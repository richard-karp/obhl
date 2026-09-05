"use server";

import Anthropic from "@anthropic-ai/sdk";
import { revalidatePath } from "next/cache";
import { createAdminClient } from "@/utils/supabase/admin";
import { requireLeagueManager } from "@/lib/auth/guards";
import { logAudit } from "@/lib/audit";
import { findUserIdByEmail } from "@/lib/auth/users";
import { addLeagueMembership } from "@/lib/auth/membership";
import { leagueOfSeason, leagueOfTeam } from "@/lib/league/of-entity";
import { getStandings } from "@/lib/queries/standings";
import { getSkaterLeaders } from "@/lib/queries/stats";
import { getRecentResults } from "@/lib/queries/schedule";
import { slugify } from "@/lib/utils/slug";

export type SeasonActionState = {
  ok: boolean;
  message: string;
  seasonId?: string;
} | null;
export type TeamActionState = { ok: boolean; message: string } | null;

type Admin = ReturnType<typeof createAdminClient>;

/**
 * The league a season belongs to. This used to come from the `obhl_league`
 * cookie, which nothing writes now that the league is in the URL — leaving it
 * would have meant every write landing in whichever league was created first.
 * An action holding a season id can just ask the season.
 */
async function leagueIdOfSeason(
  admin: Admin,
  seasonId: string,
): Promise<string> {
  const leagueId = await leagueOfSeason(seasonId, admin);
  if (!leagueId) throw new Error("That season no longer exists.");
  return leagueId;
}

/** Step 1 of season setup: create a season (inactive until set active). */
export async function createSeason(
  _prev: SeasonActionState,
  formData: FormData,
): Promise<SeasonActionState> {
  const admin = createAdminClient();
  const league_id = String(formData.get("league_id") ?? "");
  const name = String(formData.get("name") ?? "").trim();
  const starts = String(formData.get("starts_on") ?? "") || null;
  const ends = String(formData.get("ends_on") ?? "") || null;
  if (!name) return { ok: false, message: "Season name is required." };
  if (!league_id) return { ok: false, message: "No league selected." };
  const manager = await requireLeagueManager(league_id);

  const { data, error } = await admin
    .from("seasons")
    .insert({
      league_id,
      name,
      starts_on: starts,
      ends_on: ends,
      is_active: false,
    })
    .select("id")
    .single();
  if (error) return { ok: false, message: error.message };
  // Awaited rather than voided, here and below: a void promise can be left
  // unfinished when the runtime freezes the function after the response, and
  // `logAudit` swallows its own errors, so awaiting cannot turn a successful
  // change into a reported failure. Same trade as `people.ts`.
  await logAudit({
    user_id: manager.id,
    action: "create_season",
    entity_type: "season",
    entity_id: data.id,
    new_data: { name, starts_on: starts, ends_on: ends },
  });
  revalidatePath("/[league]/seasons", "page");
  return { ok: true, message: `Season "${name}" created.`, seasonId: data.id };
}

/**
 * Step 2 of season setup: create a team in the league, enroll it in the season,
 * and optionally set its captain (a player marked captain) + a captain login.
 */
export async function createTeamForSeason(
  _prev: TeamActionState,
  formData: FormData,
): Promise<TeamActionState> {
  const admin = createAdminClient();

  const season_id = String(formData.get("season_id") ?? "");
  const manager = await requireLeagueManager(() =>
    leagueOfSeason(season_id, admin),
  );
  const name = String(formData.get("name") ?? "").trim();
  const color = String(formData.get("color") ?? "").trim() || null;
  const captainName = String(formData.get("captain_name") ?? "").trim();
  const captainEmail = String(formData.get("captain_email") ?? "")
    .trim()
    .toLowerCase();
  if (!name) return { ok: false, message: "Team name is required." };
  if (captainEmail && !captainName) {
    return { ok: false, message: "Enter the captain's name too." };
  }

  const { data: season } = await admin
    .from("seasons")
    .select("league_id")
    .eq("id", season_id)
    .maybeSingle();
  if (!season) return { ok: false, message: "Season not found." };

  const { data: team, error: tErr } = await admin
    .from("teams")
    .insert({ league_id: season.league_id, name, slug: slugify(name), color })
    .select("id")
    .single();
  if (tErr) {
    if (tErr.code === "23505") {
      return {
        ok: false,
        message: `A team like "${name}" already exists. Use "Same teams as last season" to reuse it.`,
      };
    }
    return { ok: false, message: tErr.message };
  }

  // Enroll the team. If this fails, roll back the team so we don't leave an
  // orphan, and don't report success.
  const { error: enrollErr } = await admin
    .from("season_teams")
    .insert({ season_id, team_id: team.id });
  if (enrollErr) {
    await admin.from("teams").delete().eq("id", team.id);
    return {
      ok: false,
      message: `Couldn't enroll the team: ${enrollErr.message}`,
    };
  }

  // Logged HERE, not after the captain block, because from this line on the team
  // survives every remaining exit. Three of them return `ok: false` — the
  // captain's player row, its roster row, or its login failed — and each says so
  // in its message while leaving the team enrolled, on purpose: a team without a
  // captain is a valid state. Logging at the end therefore left exactly the
  // teams whose creation went half-right unrecorded, which is the case an audit
  // log is for.
  //
  // The captain is not in the payload for the same reason: nothing is known
  // about it yet, and naming someone who then failed to get a login would make
  // the entry assert the thing that did not happen.
  await logAudit({
    user_id: manager.id,
    action: "create_team",
    entity_type: "team",
    entity_id: team.id,
    new_data: { name, season_id },
  });

  // Captain is optional and secondary: if a captain step fails, the team still
  // exists (a valid state), so report the partial outcome honestly instead of
  // rolling the whole team back or claiming full success.
  if (captainName) {
    const [first, ...rest] = captainName.split(/\s+/);
    const { data: player, error: pErr } = await admin
      .from("players")
      .insert({ first_name: first, last_name: rest.join(" ") })
      .select("id")
      .single();
    if (pErr || !player) {
      revalidatePath("/[league]/seasons/[seasonId]", "page");
      return {
        ok: false,
        message: `Added ${name}, but couldn't create the captain (${pErr?.message ?? "unknown"}). Add them under Rosters.`,
      };
    }

    const { error: tpErr } = await admin.from("team_players").insert({
      season_id,
      team_id: team.id,
      player_id: player.id,
      is_captain: true,
      position: "F",
    });
    if (tpErr) {
      await admin.from("players").delete().eq("id", player.id);
      revalidatePath("/[league]/seasons/[seasonId]", "page");
      return {
        ok: false,
        message: `Added ${name}, but couldn't set the captain (${tpErr.message}).`,
      };
    }

    if (captainEmail) {
      let userId: string | undefined;
      const { data: created, error: uErr } = await admin.auth.admin.createUser({
        email: captainEmail,
        email_confirm: true,
      });
      if (uErr) {
        // Paged: a single page of the instance's auth users would stop finding
        // an existing captain once there are more than fit in it, and this
        // branch's failure is silent — `userId` stays undefined, no profile is
        // written, and the team is still reported added with a captain who
        // cannot sign in.
        userId = (await findUserIdByEmail(admin, captainEmail)) ?? undefined;
      } else {
        userId = created.user.id;
      }
      if (userId) {
        const { error: profErr } = await admin.from("profiles").upsert({
          id: userId,
          role: "captain",
          player_id: player.id,
          display_name: captainName,
        });
        if (profErr) {
          revalidatePath("/[league]/seasons/[seasonId]", "page");
          return {
            ok: false,
            message: `Added ${name} with captain ${captainName}, but couldn't create their login (${profErr.message}).`,
          };
        }
        // A role without a league reaches nothing: every manage page now asks
        // for membership as well. Granted for the league this season is in.
        await addLeagueMembership(userId, season.league_id);
      }
    }
  }

  revalidatePath("/[league]/seasons/[seasonId]", "page");
  return {
    ok: true,
    message: `Added ${name}${captainName ? ` (captain ${captainName})` : ""}.`,
  };
}

/** The two legible inks the monogram chip can draw its letters in. */
const LOGO_TEXT_COLORS = ["light", "dark"] as const;

/**
 * Step 2, after the fact: change an enrolled team's colour and the ink its
 * monogram is drawn in. Colour used to be settable once, at creation, and never
 * again.
 *
 * Both fields move together because they are one decision — "dark letters" means
 * nothing except against the colour chosen beside it, and a manager who picks a
 * pale colour needs to fix the letters in the same breath or the chip is
 * unreadable in between.
 *
 * Guarded on the TEAM's league rather than the season's. The season page is
 * where the control lives, but the team row is what gets written, and
 * `leagueOfTeam` is the only claim about that row the id itself supports — a
 * season id in the form would authorise a write to a team the season does not
 * contain.
 */
export async function updateTeamColor(
  _prev: TeamActionState,
  formData: FormData,
): Promise<TeamActionState> {
  const admin = createAdminClient();
  const team_id = String(formData.get("team_id") ?? "");
  if (!team_id) return { ok: false, message: "No team selected." };
  const manager = await requireLeagueManager(() =>
    leagueOfTeam(team_id, admin),
  );

  const color = String(formData.get("color") ?? "").trim() || null;
  const rawTextColor = String(formData.get("logo_text_color") ?? "light");
  // Checked here as well as by 0041's check constraint: the constraint would
  // reject a bad value with a Postgres error string, and this is a form field a
  // manager can see.
  if (!(LOGO_TEXT_COLORS as readonly string[]).includes(rawTextColor)) {
    return { ok: false, message: "Letter color must be light or dark." };
  }
  // `<input type="color">` cannot produce anything else, but the action is a
  // POST endpoint and this string is written straight into an inline `style`.
  if (color !== null && !/^#[0-9a-f]{6}$/i.test(color)) {
    return { ok: false, message: "Color must be a hex value like #0ea5e9." };
  }

  // Read before the update: the replaced colour is the only thing this entry can
  // record that the team row does not already hold afterwards. Same reason
  // `upload_logo` keeps `old_data`.
  const { data: was } = await admin
    .from("teams")
    .select("name, color, logo_text_color")
    .eq("id", team_id)
    .maybeSingle();
  if (!was) return { ok: false, message: "Team not found." };

  const { error } = await admin
    .from("teams")
    .update({ color, logo_text_color: rawTextColor })
    .eq("id", team_id);
  if (error) return { ok: false, message: error.message };

  await logAudit({
    user_id: manager.id,
    action: "update_team_color",
    entity_type: "team",
    entity_id: team_id,
    old_data: { color: was.color, logo_text_color: was.logo_text_color },
    new_data: { color, logo_text_color: rawTextColor },
  });

  revalidatePath("/[league]/seasons/[seasonId]", "page");
  revalidatePath("/[league]/teams", "page");
  // The chip is on the public pages too — standings, the team pages, every game
  // row — so revalidating only the setup page would leave the whole public site
  // showing the old colour until something unrelated rebuilt it.
  revalidatePath("/[league]", "layout");
  return { ok: true, message: `Updated ${was.name}.` };
}

export async function setActiveSeason(formData: FormData) {
  const admin = createAdminClient();
  const id = String(formData.get("id"));
  const leagueId = await leagueIdOfSeason(admin, id);
  const manager = await requireLeagueManager(leagueId);

  // Which season is being replaced, read before the update that clears it —
  // afterwards nothing says what was live, and that is the whole point of the
  // entry.
  const { data: was } = await admin
    .from("seasons")
    .select("id, name")
    .eq("league_id", leagueId)
    .eq("is_active", true)
    .maybeSingle();

  // Unset the current active first (one-active-per-league partial unique index),
  // then activate the chosen season — scoped to this league so a stray id can't
  // activate another league's season.
  const { error: e1 } = await admin
    .from("seasons")
    .update({ is_active: false })
    .eq("league_id", leagueId);
  if (e1) throw new Error(`Deactivating seasons failed: ${e1.message}`);
  const { error: e2 } = await admin
    .from("seasons")
    .update({ is_active: true })
    .eq("id", id)
    .eq("league_id", leagueId);
  if (e2) throw new Error(`Activating season failed: ${e2.message}`);
  const { data: now } = await admin
    .from("seasons")
    .select("name")
    .eq("id", id)
    .maybeSingle();
  await logAudit({
    user_id: manager.id,
    action: "set_active_season",
    entity_type: "season",
    entity_id: id,
    old_data: was ? { season_id: was.id, name: was.name } : null,
    new_data: { season_id: id, name: now?.name ?? null },
  });
  revalidatePath("/[league]/seasons", "page");
  revalidatePath("/[league]", "layout");
}

export async function unenrollTeam(formData: FormData) {
  const admin = createAdminClient();
  const season_id = String(formData.get("season_id"));
  const team_id = String(formData.get("team_id"));
  const manager = await requireLeagueManager(() =>
    leagueOfSeason(season_id, admin),
  );

  // The team's name, read before the enrollment goes: the team row survives an
  // unenroll, but reading it here keeps the entry readable even if the team is
  // later deleted outright.
  const { data: team } = await admin
    .from("teams")
    .select("name")
    .eq("id", team_id)
    .maybeSingle();

  await admin
    .from("season_teams")
    .delete()
    .eq("season_id", season_id)
    .eq("team_id", team_id);
  // Filed under the SEASON, which outlives the enrollment row — so
  // `leagueOfEntity` still resolves a league and the entry stays visible. The
  // `season_teams` row itself has no id here and would resolve to nothing.
  await logAudit({
    user_id: manager.id,
    action: "unenroll_team",
    entity_type: "season",
    entity_id: season_id,
    old_data: { team_id, name: team?.name ?? null },
  });
  revalidatePath("/[league]/seasons/[seasonId]", "page");
}

/**
 * Generate an AI league summary using Claude and store it in seasons.ai_summary.
 * Pulls current standings, top scorers, and recent results. Manager-only.
 */
export async function generateLeagueSummary(formData: FormData) {
  const admin = createAdminClient();
  const season_id = String(formData.get("season_id"));
  const manager = await requireLeagueManager(() =>
    leagueOfSeason(season_id, admin),
  );

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY is not configured.");

  // The same reads the public pages use, through the same helpers. `getStandings`
  // matters most: it applies the tiebreakers, where ordering by points alone can
  // name a leader the standings page doesn't.
  const [ranked, scorers, recentGames, seasonRes] = await Promise.all([
    getStandings(season_id, { client: admin }),
    getSkaterLeaders(season_id, { limit: 5, client: admin }),
    getRecentResults(season_id, { limit: 3, client: admin }),
    // `ai_summary` alongside the name, on the read that was already happening:
    // the update below overwrites it, and the replaced text is the only thing
    // this entry can say that the season row does not already hold.
    admin
      .from("seasons")
      .select("name, ai_summary")
      .eq("id", season_id)
      .maybeSingle(),
  ]);

  const standings = ranked.slice(0, 6);
  const seasonName = seasonRes.data?.name ?? "Current Season";

  // The view columns are nullable, and an unguarded null interpolates as the
  // string "null" — straight into the prompt, where it reads as fact. (The
  // game lines below come from `GameWithTeams`, whose goal counts are not.)
  const standingsLines = standings.map(
    (r) =>
      `${r.team_name ?? "Unknown"}: ${r.wins ?? 0}W-${r.losses ?? 0}L-${r.ties ?? 0}T, ` +
      `${r.points ?? 0} pts (${r.gp ?? 0} GP)`,
  );
  const scorerLines = scorers.map((r) => {
    const name =
      [r.first_name, r.last_name].filter(Boolean).join(" ") || "Unknown";
    return `${name} (${r.team_name ?? ""}): ${r.g ?? 0}G ${r.a ?? 0}A ${r.pts ?? 0}PTS`;
  });
  const gameLines = recentGames.map((g) => {
    const away = g.away_team?.name ?? "Away";
    const home = g.home_team?.name ?? "Home";
    return `${away} ${g.away_goals} – ${g.home_goals} ${home}`;
  });

  const prompt = [
    `Write a short 2-3 sentence league news update for a recreational adult hockey league.`,
    `Season: ${seasonName}`,
    standings.length ? `Standings:\n${standingsLines.join("\n")}` : "",
    scorers.length ? `Top scorers:\n${scorerLines.join("\n")}` : "",
    recentGames.length ? `Recent results:\n${gameLines.join("\n")}` : "",
    `Highlight the standings leader, a standout player, and recent results. Keep it casual and fun.`,
    `No filler phrases like "The league is heating up" or "In an exciting development".`,
  ]
    .filter(Boolean)
    .join("\n\n");

  const client = new Anthropic({ apiKey });
  const msg = await client.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 300,
    messages: [{ role: "user", content: prompt }],
  });

  const summary =
    msg.content.length > 0 && msg.content[0].type === "text"
      ? msg.content[0].text.trim()
      : "";
  if (!summary) throw new Error("AI returned empty summary.");

  const { error } = await admin
    .from("seasons")
    .update({ ai_summary: summary })
    .eq("id", season_id);
  if (error) throw new Error(`Save summary failed: ${error.message}`);

  await logAudit({
    user_id: manager.id,
    action: "generate_summary",
    entity_type: "season",
    entity_id: season_id,
    // Only the old one. The new summary is in `seasons.ai_summary` already, and
    // regenerating is destructive — the previous text is gone the moment the
    // update lands. Same reason `upload_logo` keeps `old_data`.
    old_data: { summary: seasonRes.data?.ai_summary ?? null },
  });

  revalidatePath("/[league]", "page");
  revalidatePath("/[league]/seasons/[seasonId]", "page");
}

/** Copies enrollment from the most recent prior season that had any. */
export async function carryForwardEnrollment(formData: FormData) {
  const admin = createAdminClient();
  const season_id = String(formData.get("season_id"));
  const leagueId = await leagueIdOfSeason(admin, season_id);
  const manager = await requireLeagueManager(leagueId);

  const { data: priors } = await admin
    .from("seasons")
    .select("id")
    .eq("league_id", leagueId)
    .neq("id", season_id)
    .order("starts_on", { ascending: false, nullsFirst: false });

  let sourceId: string | null = null;
  for (const s of priors ?? []) {
    const { count } = await admin
      .from("season_teams")
      .select("*", { count: "exact", head: true })
      .eq("season_id", s.id);
    if ((count ?? 0) > 0) {
      sourceId = s.id;
      break;
    }
  }

  let carried = 0;
  if (sourceId) {
    const { data: src } = await admin
      .from("season_teams")
      .select("team_id")
      .eq("season_id", sourceId);
    const rows = (src ?? []).map((r) => ({ season_id, team_id: r.team_id }));
    if (rows.length) {
      // `ignoreDuplicates` turns this into ON CONFLICT DO NOTHING, and the
      // representation then comes back holding ONLY the rows that were inserted
      // — which is the count the log wants. Behaviour is unchanged: the row is
      // nothing but its own key, so the update branch it replaces wrote nothing.
      // Pressing the button twice used to record "carried 6 teams" both times.
      const { data: added } = await admin
        .from("season_teams")
        .upsert(rows, {
          onConflict: "season_id,team_id",
          ignoreDuplicates: true,
        })
        .select("team_id");
      carried = added?.length ?? 0;
    }
  }
  // Logged even when it carried nothing, and the two ways that happens are kept
  // apart by `from_season_id`: no earlier season had teams to copy, or they were
  // all enrolled here already. Someone reading this because a roster is
  // unexpectedly empty needs to tell those apart.
  await logAudit({
    user_id: manager.id,
    action: "carry_forward_enrollment",
    entity_type: "season",
    entity_id: season_id,
    new_data: { from_season_id: sourceId, teams: carried },
  });
  revalidatePath("/[league]/seasons/[seasonId]", "page");
}
