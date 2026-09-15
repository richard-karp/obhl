"use server";

import { revalidatePath } from "next/cache";
import { createAdminClient } from "@/utils/supabase/admin";
import { requireLeagueManager } from "@/lib/auth/guards";
import { logAudit } from "@/lib/audit";
import { findUserIdByEmail } from "@/lib/auth/users";
import { addLeagueMembership, mayWriteProfileOf } from "@/lib/auth/membership";
import { leagueOfSeason, leagueOfTeam } from "@/lib/league/of-entity";
import { slugify } from "@/lib/utils/slug";

export type SeasonActionState = {
  ok: boolean;
  message: string;
  seasonId?: string;
} | null;
export type TeamActionState = { ok: boolean; message: string } | null;

type Admin = ReturnType<typeof createAdminClient>;

/** The season's league, or a throw when the season is gone. */
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
  // Awaited, not voided, here and below: a voided write can be dropped when the runtime freezes,
  // and `logAudit` swallows its own errors.
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

/** Step 2 of season setup: create a team, enrol it, and optionally a captain and their login. */
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

  // Logged here: the team survives every exit below, including three captain failures. The
  // captain stays out of the payload because it may not land.
  await logAudit({
    user_id: manager.id,
    action: "create_team",
    entity_type: "team",
    entity_id: team.id,
    new_data: { name, season_id },
  });

  // A captain step failing leaves a valid team: report the partial outcome, never roll back or
  // claim success.
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
        // Failing is normal for a captain who already has an account, so look it up (paged: one
        // page stops finding them once the instance outgrows it).
        userId = (await findUserIdByEmail(admin, captainEmail)) ?? undefined;
      } else {
        userId = created.user.id;
      }
      // ⛔ Neither worked: say so. `findUserIdByEmail` returns null for a failed `listUsers` too,
      // so an auth outage lands here.
      if (!userId) {
        revalidatePath("/[league]/seasons/[seasonId]", "page");
        return {
          ok: false,
          message: `Added ${name} with captain ${captainName}, but couldn't create or find their login (${uErr?.message ?? "no matching account"}). The team and player are there — add their login from People & Roles.`,
        };
      }

      // An existing account keeps its profile: `profiles.role` is account-wide, and `is_captain_of`
      // (0038) reads `player_id` alone. Only a login with no role is written.
      if (uErr) {
        const { data: existing } = await admin
          .from("profiles")
          .select("role")
          .eq("id", userId)
          .maybeSingle();
        if (existing?.role && existing.role !== "captain") {
          revalidatePath("/[league]/seasons/[seasonId]", "page");
          return {
            ok: false,
            message: `Added ${name} with captain ${captainName}, but ${captainEmail} already has an account as ${existing.role.replace("league_", "")}, and a role is account-wide, so it was left unchanged.`,
          };
        }
        if (existing?.role === "captain") {
          const granted = await addLeagueMembership(userId, season.league_id);
          revalidatePath("/[league]/seasons/[seasonId]", "page");
          return {
            ok: false,
            message: granted.ok
              ? `Added ${name} with captain ${captainName}, but ${captainEmail} already captains through another player. Their login was added to this league and left linked, so it does not captain ${name}.`
              : `Added ${name} with captain ${captainName}, but ${captainEmail} already captains through another player, and couldn't be given access to this league (${granted.error}).`,
          };
        }
        if (!(await mayWriteProfileOf(manager.id, userId))) {
          revalidatePath("/[league]/seasons/[seasonId]", "page");
          return {
            ok: false,
            message: `Added ${name} with captain ${captainName}, but ${captainEmail} already has an account in a league you don't manage, so it was left unchanged.`,
          };
        }
      }

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
      // ⛔ Checked: a role without a league reaches nothing, and this grant is the last thing the
      // captain needs to sign in and reach anything.
      const granted = await addLeagueMembership(userId, season.league_id);
      if (!granted.ok) {
        revalidatePath("/[league]/seasons/[seasonId]", "page");
        return {
          ok: false,
          message: `Added ${name} with captain ${captainName}, but couldn't give them access to this league (${granted.error}). Their login exists — add them from People & Roles.`,
        };
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

// Colour and monogram ink move together, as one decision. Guarded on the team's league: that is
// the row written, and a season id in the form could authorise a team the season lacks.
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
  // Checked here as well as by 0041's constraint, so the manager sees a sentence, not a Postgres error.
  if (!(LOGO_TEXT_COLORS as readonly string[]).includes(rawTextColor)) {
    return { ok: false, message: "Letter color must be light or dark." };
  }
  // `<input type="color">` cannot produce anything else, but the action is a
  // POST endpoint and this string is written straight into an inline `style`.
  if (color !== null && !/^#[0-9a-f]{6}$/i.test(color)) {
    return { ok: false, message: "Color must be a hex value like #0ea5e9." };
  }

  // Read before the update: the replaced colour exists nowhere else afterwards.
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
  // The chip is on the public pages too, not only the setup page.
  revalidatePath("/[league]", "layout");
  return { ok: true, message: `Updated ${was.name}.` };
}

export async function setActiveSeason(formData: FormData) {
  const admin = createAdminClient();
  const id = String(formData.get("id"));
  const leagueId = await leagueIdOfSeason(admin, id);
  const manager = await requireLeagueManager(leagueId);

  // Read before the update that clears it: afterwards nothing says which season was live.
  const { data: was } = await admin
    .from("seasons")
    .select("id, name")
    .eq("league_id", leagueId)
    .eq("is_active", true)
    .maybeSingle();

  // Unset the active season first (one-active-per-league unique index), then activate this one,
  // scoped to this league so a stray id cannot activate another league's season.
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

  // Read before the unenrol, so the entry stays readable if the team is later deleted.
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
  // Filed under the season, which outlives the enrollment, so `leagueOfEntity` still resolves a
  // league; a `season_teams` row would resolve nothing.
  await logAudit({
    user_id: manager.id,
    action: "unenroll_team",
    entity_type: "season",
    entity_id: season_id,
    old_data: { team_id, name: team?.name ?? null },
  });
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
      // `ignoreDuplicates` returns only inserted rows, which is the count the entry wants.
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
  // Logged even when nothing carried; `from_season_id` tells "no earlier season had teams" from
  // "all already enrolled".
  await logAudit({
    user_id: manager.id,
    action: "carry_forward_enrollment",
    entity_type: "season",
    entity_id: season_id,
    new_data: { from_season_id: sourceId, teams: carried },
  });
  revalidatePath("/[league]/seasons/[seasonId]", "page");
}
