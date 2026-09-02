"use server";

import { revalidatePath } from "next/cache";
import { createAdminClient } from "@/utils/supabase/admin";
import {
  requireLeagueManager,
  requireLeagueManagerOf,
} from "@/lib/auth/guards";
import {
  leagueOfSeason,
  leagueOfTeam,
  leagueOfTeamPlayer,
} from "@/lib/league/of-entity";
import { logAudit } from "@/lib/audit";

export type RosterActionState = { ok: boolean; message: string } | null;

export async function addRosterPlayer(
  _prev: RosterActionState,
  formData: FormData,
): Promise<RosterActionState> {
  const admin = createAdminClient();

  const season_id = String(formData.get("season_id"));
  const team_id = String(formData.get("team_id"));
  // These forms carry ids, never a league — the league is in the URL of the
  // page that rendered them. Every guard below therefore derives it from the
  // rows being written, which is what makes a hand-made request naming another
  // league's ids fail rather than pass.
  //
  // BOTH ids, because both are written. Guarding the season alone let a foreign
  // `team_id` through, and `is_captain` rides in the same payload.
  const manager = await requireLeagueManagerOf(
    () => leagueOfSeason(season_id, admin),
    () => leagueOfTeam(team_id, admin),
  );
  const existing_id = String(formData.get("player_id") ?? "").trim();
  const first = String(formData.get("first_name") ?? "").trim();
  const last = String(formData.get("last_name") ?? "").trim();
  const jerseyRaw = formData.get("jersey_number");
  const jersey = jerseyRaw ? Number(jerseyRaw) : null;
  const position = String(formData.get("position") ?? "F");
  const is_captain = formData.get("is_captain") === "on";

  let player_id = existing_id;
  let label = "Player";

  if (!player_id) {
    if (!first || !last) {
      return {
        ok: false,
        message: "Pick an existing person, or enter a first and last name.",
      };
    }
    const { data: player, error: pErr } = await admin
      .from("players")
      .insert({ first_name: first, last_name: last })
      .select("id")
      .single();
    if (pErr) return { ok: false, message: pErr.message };
    player_id = player!.id;
    label = `${first} ${last}`;
  }

  const { data: inserted, error } = await admin
    .from("team_players")
    .insert({
      season_id,
      team_id,
      player_id,
      jersey_number: jersey,
      position: position as "F" | "D" | "G",
      is_captain,
    })
    .select("id")
    .single();
  if (error) return { ok: false, message: error.message };

  void logAudit({
    user_id: manager.id,
    action: "add_player",
    entity_type: "team_player",
    entity_id: inserted.id,
    new_data: { player_id, team_id, season_id, position },
  });

  revalidatePath("/[league]/manage/rosters/[teamId]", "page");
  return { ok: true, message: `${label} added to the roster.` };
}

export async function removeRosterPlayer(formData: FormData) {
  const admin = createAdminClient();
  const id = String(formData.get("id"));
  const team_id = String(formData.get("team_id"));
  const manager = await requireLeagueManager(() => leagueOfTeamPlayer(id, admin));

  // Capture full row before deletion so revert can restore it
  const { data: existing } = await admin
    .from("team_players")
    .select("*")
    .eq("id", id)
    .maybeSingle();

  await admin.from("team_players").delete().eq("id", id);
  void logAudit({
    user_id: manager.id,
    action: "remove_player",
    entity_type: "team_player",
    entity_id: id,
    old_data: existing ?? { team_id },
  });
  revalidatePath("/[league]/manage/rosters/[teamId]", "page");
}

export async function toggleCaptain(formData: FormData) {
  const admin = createAdminClient();
  const id = String(formData.get("id"));
  const manager = await requireLeagueManager(() => leagueOfTeamPlayer(id, admin));
  const make = formData.get("make") === "1";
  await admin.from("team_players").update({ is_captain: make }).eq("id", id);
  void logAudit({
    user_id: manager.id,
    action: "toggle_captain",
    entity_type: "team_player",
    entity_id: id,
    new_data: { is_captain: make },
  });
  revalidatePath("/[league]/manage/rosters/[teamId]", "page");
}

export async function setDefaultGoalie(formData: FormData) {
  const admin = createAdminClient();
  const id = String(formData.get("id")); // team_players.id
  const team_id = String(formData.get("team_id"));
  const season_id = String(formData.get("season_id"));
  const make = formData.get("make") === "1";
  // All three, unconditionally. The `id` update only runs when setting, so
  // guarding it only then looks precise — but `logAudit` below uses the id
  // whatever `make` is, and it writes on the admin client, past RLS. Guarding
  // the table writes alone therefore left an unset able to file an entry
  // against another league's roster row, into that league's audit log.
  const manager = await requireLeagueManagerOf(
    () => leagueOfSeason(season_id, admin),
    () => leagueOfTeam(team_id, admin),
    () => leagueOfTeamPlayer(id, admin),
  );

  // Clear any existing default on this team/season first, then set the new one.
  await admin
    .from("team_players")
    .update({ is_default_goalie: false })
    .eq("team_id", team_id)
    .eq("season_id", season_id);
  if (make) {
    await admin.from("team_players").update({ is_default_goalie: true }).eq("id", id);
  }
  void logAudit({
    user_id: manager.id,
    action: "set_default_goalie",
    entity_type: "team_player",
    entity_id: id,
    new_data: { is_default_goalie: make },
  });
  revalidatePath("/[league]/manage/rosters/[teamId]", "page");
}

export async function setGoalieDay(formData: FormData) {
  const admin = createAdminClient();
  const team_id = String(formData.get("team_id"));
  const season_id = String(formData.get("season_id"));
  // Both ids are written, so both are checked — and against the SAME league.
  // Two independent membership checks would pass for a person who manages both
  // leagues while still writing one league's team into the other's season.
  const manager = await requireLeagueManagerOf(
    () => leagueOfSeason(season_id, admin),
    () => leagueOfTeam(team_id, admin),
  );
  const day_of_week = Number(formData.get("day_of_week"));
  const player_id = String(formData.get("player_id") ?? "").trim();

  if (player_id) {
    await admin
      .from("team_goalie_days")
      .upsert({ team_id, season_id, day_of_week, player_id }, { onConflict: "team_id,season_id,day_of_week" });
  } else {
    await admin
      .from("team_goalie_days")
      .delete()
      .eq("team_id", team_id)
      .eq("season_id", season_id)
      .eq("day_of_week", day_of_week);
  }
  void logAudit({
    user_id: manager.id,
    action: "set_goalie_day",
    entity_type: "team",
    entity_id: team_id,
    new_data: { day_of_week, player_id: player_id || null },
  });
  revalidatePath("/[league]/manage/rosters/[teamId]", "page");
}

export async function updatePlayerStatus(formData: FormData) {
  const admin = createAdminClient();
  const id = String(formData.get("id"));
  const manager = await requireLeagueManager(() => leagueOfTeamPlayer(id, admin));
  const field = String(formData.get("field"));

  // Capture current value before update so revert can restore it
  const { data: currentRow } = await admin
    .from("team_players")
    .select("is_rookie, is_suspended, injury_notes")
    .eq("id", id)
    .maybeSingle();

  if (field === "injury_notes") {
    const raw = String(formData.get("value") ?? "").trim();
    await admin.from("team_players").update({ injury_notes: raw || null }).eq("id", id);
  } else if (field === "is_rookie") {
    const val = formData.get("value") === "1";
    await admin.from("team_players").update({ is_rookie: val }).eq("id", id);
  } else if (field === "is_suspended") {
    const val = formData.get("value") === "1";
    await admin.from("team_players").update({ is_suspended: val }).eq("id", id);
  } else {
    return;
  }

  let oldVal: unknown;
  if (currentRow) {
    if (field === "injury_notes") oldVal = currentRow.injury_notes;
    else if (field === "is_rookie") oldVal = currentRow.is_rookie;
    else if (field === "is_suspended") oldVal = currentRow.is_suspended;
  }

  void logAudit({
    user_id: manager.id,
    action: "update_player_status",
    entity_type: "team_player",
    entity_id: id,
    old_data: oldVal !== undefined ? { [field]: oldVal } : null,
    new_data: { field, value: formData.get("value") },
  });
  revalidatePath("/[league]/manage/rosters/[teamId]", "page");
}
