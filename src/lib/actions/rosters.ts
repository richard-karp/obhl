"use server";

import { revalidatePath } from "next/cache";
import { createAdminClient } from "@/utils/supabase/admin";
import { requireManager } from "@/lib/auth/guards";
import { logAudit } from "@/lib/audit";

export type RosterActionState = { ok: boolean; message: string } | null;

export async function addRosterPlayer(
  _prev: RosterActionState,
  formData: FormData,
): Promise<RosterActionState> {
  const manager = await requireManager();
  const admin = createAdminClient();

  const season_id = String(formData.get("season_id"));
  const team_id = String(formData.get("team_id"));
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

  revalidatePath(`/rosters/${team_id}`);
  return { ok: true, message: `${label} added to the roster.` };
}

export async function removeRosterPlayer(formData: FormData) {
  const manager = await requireManager();
  const admin = createAdminClient();
  const id = String(formData.get("id"));
  const team_id = String(formData.get("team_id"));

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
  revalidatePath(`/rosters/${team_id}`);
}

export async function toggleCaptain(formData: FormData) {
  const manager = await requireManager();
  const admin = createAdminClient();
  const id = String(formData.get("id"));
  const team_id = String(formData.get("team_id"));
  const make = formData.get("make") === "1";
  await admin.from("team_players").update({ is_captain: make }).eq("id", id);
  void logAudit({
    user_id: manager.id,
    action: "toggle_captain",
    entity_type: "team_player",
    entity_id: id,
    new_data: { is_captain: make },
  });
  revalidatePath(`/rosters/${team_id}`);
}

export async function updatePlayerStatus(formData: FormData) {
  const manager = await requireManager();
  const admin = createAdminClient();
  const id = String(formData.get("id"));
  const team_id = String(formData.get("team_id"));
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
  revalidatePath(`/rosters/${team_id}`);
}
