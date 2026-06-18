"use server";

import Anthropic from "@anthropic-ai/sdk";
import { revalidatePath } from "next/cache";
import { createAdminClient } from "@/utils/supabase/admin";
import { requireManager } from "@/lib/auth/guards";
import { resolveCurrentLeague } from "@/lib/league/current";

export type SeasonActionState =
  | { ok: boolean; message: string; seasonId?: string }
  | null;
export type TeamActionState = { ok: boolean; message: string } | null;

type Admin = ReturnType<typeof createAdminClient>;

async function getLeagueId(admin: Admin): Promise<string> {
  const league = await resolveCurrentLeague(admin);
  return league!.id;
}

const slugify = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

/** Step 1 of season setup: create a season (inactive until set active). */
export async function createSeason(
  _prev: SeasonActionState,
  formData: FormData,
): Promise<SeasonActionState> {
  await requireManager();
  const admin = createAdminClient();
  const name = String(formData.get("name") ?? "").trim();
  const starts = String(formData.get("starts_on") ?? "") || null;
  const ends = String(formData.get("ends_on") ?? "") || null;
  if (!name) return { ok: false, message: "Season name is required." };

  const { data, error } = await admin
    .from("seasons")
    .insert({
      league_id: await getLeagueId(admin),
      name,
      starts_on: starts,
      ends_on: ends,
      is_active: false,
    })
    .select("id")
    .single();
  if (error) return { ok: false, message: error.message };
  revalidatePath("/seasons");
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
  await requireManager();
  const admin = createAdminClient();

  const season_id = String(formData.get("season_id") ?? "");
  const name = String(formData.get("name") ?? "").trim();
  const color = String(formData.get("color") ?? "").trim() || null;
  const captainName = String(formData.get("captain_name") ?? "").trim();
  const captainEmail = String(formData.get("captain_email") ?? "").trim().toLowerCase();
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
    return { ok: false, message: `Couldn't enroll the team: ${enrollErr.message}` };
  }

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
      revalidatePath(`/seasons/${season_id}`);
      return { ok: false, message: `Added ${name}, but couldn't create the captain (${pErr?.message ?? "unknown"}). Add them under Rosters.` };
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
      revalidatePath(`/seasons/${season_id}`);
      return { ok: false, message: `Added ${name}, but couldn't set the captain (${tpErr.message}).` };
    }

    if (captainEmail) {
      let userId: string | undefined;
      const { data: created, error: uErr } = await admin.auth.admin.createUser({
        email: captainEmail,
        email_confirm: true,
      });
      if (uErr) {
        const { data: list } = await admin.auth.admin.listUsers({ perPage: 1000 });
        userId = list?.users.find((u) => u.email === captainEmail)?.id;
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
          revalidatePath(`/seasons/${season_id}`);
          return { ok: false, message: `Added ${name} with captain ${captainName}, but couldn't create their login (${profErr.message}).` };
        }
      }
    }
  }

  revalidatePath(`/seasons/${season_id}`);
  return {
    ok: true,
    message: `Added ${name}${captainName ? ` (captain ${captainName})` : ""}.`,
  };
}

export async function setActiveSeason(formData: FormData) {
  await requireManager();
  const admin = createAdminClient();
  const id = String(formData.get("id"));
  const leagueId = await getLeagueId(admin);
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
  revalidatePath("/seasons");
  revalidatePath("/", "layout");
}

export async function unenrollTeam(formData: FormData) {
  await requireManager();
  const admin = createAdminClient();
  const season_id = String(formData.get("season_id"));
  const team_id = String(formData.get("team_id"));
  await admin
    .from("season_teams")
    .delete()
    .eq("season_id", season_id)
    .eq("team_id", team_id);
  revalidatePath(`/seasons/${season_id}`);
}

/**
 * Generate an AI league summary using Claude and store it in seasons.ai_summary.
 * Pulls current standings, top scorers, and recent results. Manager-only.
 */
export async function generateLeagueSummary(formData: FormData) {
  await requireManager();
  const admin = createAdminClient();
  const season_id = String(formData.get("season_id"));

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY is not configured.");

  const [standingsRes, scorersRes, gamesRes, seasonRes] = await Promise.all([
    admin
      .from("v_standings_raw")
      .select("team_name, gp, wins, losses, ties, points")
      .eq("season_id", season_id)
      .order("points", { ascending: false })
      .limit(6),
    admin
      .from("v_skater_stats")
      .select("first_name, last_name, team_name, g, a, pts")
      .eq("season_id", season_id)
      .order("pts", { ascending: false })
      .order("g", { ascending: false })
      .limit(5),
    admin
      .from("games")
      .select(
        "scheduled_at, home_goals, away_goals, " +
        "home_team:teams!games_home_team_id_fkey(name), " +
        "away_team:teams!games_away_team_id_fkey(name)",
      )
      .eq("season_id", season_id)
      .eq("status", "final")
      .order("scheduled_at", { ascending: false })
      .limit(3),
    admin.from("seasons").select("name").eq("id", season_id).maybeSingle(),
  ]);

  const standings = standingsRes.data ?? [];
  const scorers = scorersRes.data ?? [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const recentGames = (gamesRes.data ?? []) as any[];
  const seasonName = seasonRes.data?.name ?? "Current Season";

  const standingsLines = standings.map(
    (r) =>
      `${r.team_name}: ${r.wins}W-${r.losses}L-${r.ties}T, ${r.points} pts (${r.gp} GP)`,
  );
  const scorerLines = scorers.map(
    (r) => `${r.first_name} ${r.last_name} (${r.team_name ?? ""}): ${r.g}G ${r.a}A ${r.pts ?? 0}PTS`,
  );
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

  revalidatePath("/");
  revalidatePath(`/seasons/${season_id}`);
}

/** Copies enrollment from the most recent prior season that had any. */
export async function carryForwardEnrollment(formData: FormData) {
  await requireManager();
  const admin = createAdminClient();
  const season_id = String(formData.get("season_id"));
  const leagueId = await getLeagueId(admin);

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

  if (sourceId) {
    const { data: src } = await admin
      .from("season_teams")
      .select("team_id")
      .eq("season_id", sourceId);
    const rows = (src ?? []).map((r) => ({ season_id, team_id: r.team_id }));
    if (rows.length) {
      await admin
        .from("season_teams")
        .upsert(rows, { onConflict: "season_id,team_id" });
    }
  }
  revalidatePath(`/seasons/${season_id}`);
}
