import "server-only";
import { createAdminClient } from "@/utils/supabase/admin";

type Admin = ReturnType<typeof createAdminClient>;

/**
 * Who has been archived out of ONE league (0040).
 *
 * ⛔ The league argument is the whole point and is never optional. `players` is
 * global — the same human plays in more than one league and is one row — so
 * "archived" is only ever a fact about a (person, league) pair. A caller that
 * drops the league and asks "is this player archived" is asking a question the
 * schema deliberately refuses to answer, and would hide someone from a league
 * that never archived them.
 *
 * Returned as a Set of player ids rather than a per-id predicate: every caller
 * is filtering a list it already has, and one read beats one per row.
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

/** Is this one person archived out of this one league? */
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
