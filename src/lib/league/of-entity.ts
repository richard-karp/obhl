import "server-only";
import { createAdminClient } from "@/utils/supabase/admin";

type Admin = ReturnType<typeof createAdminClient>;

/**
 * Admin client: the caller's access to the row is what is being decided. Each returns null
 * for an unknown id, and `requireLeagueRole(null, …)` refuses, so it fails closed.
 */

export async function leagueOfSeason(
  seasonId: string,
  admin: Admin,
): Promise<string | null> {
  if (!seasonId) return null;
  const { data } = await admin
    .from("seasons")
    .select("league_id")
    .eq("id", seasonId)
    .maybeSingle();
  return data?.league_id ?? null;
}

export async function leagueOfTeam(
  teamId: string,
  admin: Admin,
): Promise<string | null> {
  if (!teamId) return null;
  const { data } = await admin
    .from("teams")
    .select("league_id")
    .eq("id", teamId)
    .maybeSingle();
  return data?.league_id ?? null;
}

export async function leagueOfGame(
  gameId: string,
  admin: Admin,
): Promise<string | null> {
  if (!gameId) return null;
  const { data } = await admin
    .from("games")
    .select("season:seasons!inner(league_id)")
    .eq("id", gameId)
    .maybeSingle();
  return data?.season?.league_id ?? null;
}

/**
 * Not filtered on `left_on`: a departed roster row still belongs to its league, and a null
 * here would bounce every action naming it to the picker.
 */
export async function leagueOfTeamPlayer(
  teamPlayerId: string,
  admin: Admin,
): Promise<string | null> {
  if (!teamPlayerId) return null;
  const { data } = await admin
    .from("team_players")
    .select("season:seasons!inner(league_id)")
    .eq("id", teamPlayerId)
    .maybeSingle();
  return data?.season?.league_id ?? null;
}

/**
 * ⛔ Plural: `players` has no `league_id`, so there is no `leagueOfPlayer` to write. Not
 * filtered on `left_on`, since a rename still changes past stats. `[]` means never rostered.
 */
export async function leaguesOfPlayer(
  playerId: string,
  admin: Admin,
): Promise<string[]> {
  if (!playerId) return [];
  const { data } = await admin
    .from("team_players")
    .select("season:seasons!inner(league_id)")
    .eq("player_id", playerId);
  return [...new Set((data ?? []).map((r) => r.season.league_id))];
}

export async function leagueOfAnnouncement(
  announcementId: string,
  admin: Admin,
): Promise<string | null> {
  if (!announcementId) return null;
  const { data } = await admin
    .from("announcements")
    .select("league_id")
    .eq("id", announcementId)
    .maybeSingle();
  return data?.league_id ?? null;
}

/** Through the season, not `team_id`: a constraint's authority comes from its season. */
export async function leagueOfScheduleConstraint(
  constraintId: string,
  admin: Admin,
): Promise<string | null> {
  if (!constraintId) return null;
  const { data } = await admin
    .from("season_schedule_constraints")
    .select("season:seasons!inner(league_id)")
    .eq("id", constraintId)
    .maybeSingle();
  return data?.season?.league_id ?? null;
}

/**
 * For entities audited under their league's own id. A lookup rather than an echo, so an id
 * matching no league fails closed.
 */
export async function leagueIdIfExists(
  leagueId: string,
  admin: Admin,
): Promise<string | null> {
  if (!leagueId) return null;
  const { data } = await admin
    .from("leagues")
    .select("id")
    .eq("id", leagueId)
    .maybeSingle();
  return data?.id ?? null;
}
