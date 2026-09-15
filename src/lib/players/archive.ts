import "server-only";
import { createAdminClient } from "@/utils/supabase/admin";

type Admin = ReturnType<typeof createAdminClient>;

/**
 * ⛔ The league is never optional: `players` is global, so "archived" is a fact about a (person,
 * league) pair, and dropping it hides someone from a league that never archived them.
 */
export async function archivedPlayerIdsIn(
  leagueId: string,
  admin: Admin,
): Promise<Set<string>> {
  if (!leagueId) return new Set();
  const { data } = await admin
    .from("player_league_archive")
    .select("player_id")
    .eq("league_id", leagueId);
  return new Set((data ?? []).map((r) => r.player_id));
}

export async function isPlayerArchivedIn(
  playerId: string,
  leagueId: string,
  admin: Admin,
): Promise<boolean> {
  if (!playerId || !leagueId) return false;
  const { data } = await admin
    .from("player_league_archive")
    .select("player_id")
    .eq("player_id", playerId)
    .eq("league_id", leagueId)
    .maybeSingle();
  return !!data;
}
