"use server";

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

  await admin.from("season_teams").insert({ season_id, team_id: team.id });

  if (captainName) {
    const [first, ...rest] = captainName.split(/\s+/);
    const { data: player } = await admin
      .from("players")
      .insert({ first_name: first, last_name: rest.join(" ") })
      .select("id")
      .single();
    if (player) {
      await admin.from("team_players").insert({
        season_id,
        team_id: team.id,
        player_id: player.id,
        is_captain: true,
        position: "F",
      });

      if (captainEmail) {
        let userId: string | undefined;
        const { data: created, error: uErr } = await admin.auth.admin.createUser({
          email: captainEmail,
          email_confirm: true,
        });
        if (uErr) {
          const { data: list } = await admin.auth.admin.listUsers();
          userId = list.users.find((u) => u.email === captainEmail)?.id;
        } else {
          userId = created.user.id;
        }
        if (userId) {
          await admin.from("profiles").upsert({
            id: userId,
            role: "captain",
            player_id: player.id,
            display_name: captainName,
          });
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
  // Unset the current active first (one-active-per-league partial unique index).
  await admin.from("seasons").update({ is_active: false }).eq("league_id", leagueId);
  await admin.from("seasons").update({ is_active: true }).eq("id", id);
  revalidatePath("/seasons");
  revalidatePath("/", "layout");
}

export async function enrollTeam(formData: FormData) {
  await requireManager();
  const admin = createAdminClient();
  const season_id = String(formData.get("season_id"));
  const team_id = String(formData.get("team_id"));
  await admin
    .from("season_teams")
    .upsert({ season_id, team_id }, { onConflict: "season_id,team_id" });
  revalidatePath(`/seasons/${season_id}`);
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
