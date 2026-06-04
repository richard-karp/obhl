"use server";

import { revalidatePath } from "next/cache";
import { createAdminClient } from "@/utils/supabase/admin";
import { requireManager } from "@/lib/auth/guards";

export type RosterActionState = { ok: boolean; message: string } | null;

export async function addRosterPlayer(
  _prev: RosterActionState,
  formData: FormData,
): Promise<RosterActionState> {
  await requireManager();
  const admin = createAdminClient();

  const season_id = String(formData.get("season_id"));
  const team_id = String(formData.get("team_id"));
  // Optional: reuse an existing global person (shared identity across leagues).
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
    // Players are global people (no league_id). The same person can be added
    // to teams in more than one league.
    const { data: player, error: pErr } = await admin
      .from("players")
      .insert({ first_name: first, last_name: last })
      .select("id")
      .single();
    if (pErr) return { ok: false, message: pErr.message };
    player_id = player!.id;
    label = `${first} ${last}`;
  }

  const { error } = await admin.from("team_players").insert({
    season_id,
    team_id,
    player_id,
    jersey_number: jersey,
    position: position as "F" | "D" | "G",
    is_captain,
  });
  if (error) return { ok: false, message: error.message };

  revalidatePath(`/rosters/${team_id}`);
  return { ok: true, message: `${label} added to the roster.` };
}

export async function removeRosterPlayer(formData: FormData) {
  await requireManager();
  const admin = createAdminClient();
  const id = String(formData.get("id"));
  const team_id = String(formData.get("team_id"));
  await admin.from("team_players").delete().eq("id", id);
  revalidatePath(`/rosters/${team_id}`);
}

export async function toggleCaptain(formData: FormData) {
  await requireManager();
  const admin = createAdminClient();
  const id = String(formData.get("id"));
  const team_id = String(formData.get("team_id"));
  const make = formData.get("make") === "1";
  await admin.from("team_players").update({ is_captain: make }).eq("id", id);
  revalidatePath(`/rosters/${team_id}`);
}
