import "server-only";
import { createAdminClient } from "@/utils/supabase/admin";

type Admin = ReturnType<typeof createAdminClient>;

/**
 * Which league an entity belongs to.
 *
 * Server actions receive a season, team, game or roster id and no league — the
 * league lives in the URL of the page that rendered the form, not in the form.
 * A league-scoped guard therefore has to derive it, and these are the
 * derivations the schema supports. Each returns null when the id resolves to
 * nothing, and `requireLeagueRole(null, …)` refuses, so an unknown id fails
 * closed rather than skipping the check.
 *
 * Read on the admin client: the caller's access to the row is the very thing
 * being decided, so answering through the caller's own RLS would be circular.
 * The client is a required argument rather than a default — every caller
 * already builds one, and a default quietly built a second per lookup.
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

/** Announcements carry their league directly; the id is all an action gets. */
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

/**
 * League rules are audited under their league's own id, so this resolves a
 * league id to itself.
 *
 * `league_rules` is one row per league (`0006_rules.sql`) and `saveRules`
 * upserts, so on a first save there is no row id yet for an audit entry to
 * name — the league id is the only stable handle the action holds. The id is
 * still looked up rather than handed straight back: an id that matches no
 * league returns null and fails closed, like the others.
 */
export async function leagueOfLeagueRules(
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
