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

/**
 * Deliberately NOT filtered on `left_on`. This answers which league a row
 * belongs to so a guard can check it, and a departure does not move the row to
 * another league — it makes it history. Filtering here would return null for a
 * departed roster row, and `requireLeagueRole(null, …)` fails closed, so every
 * action naming one would redirect to the picker with nothing to explain it.
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
 * Every league a PLAYER plays in — plural, and that is not an oversight.
 *
 * ⛔ The singular resolvers above exist because every other entity belongs to
 * exactly one league. A player does not. `players` has no `league_id` at all
 * (0002_core.sql:43, and 0032's header restates it), deliberately, so that one
 * human is one row across every league they play in. There is therefore no
 * `leagueOfPlayer` to write, and reaching for one is the mistake this function
 * is named to prevent.
 *
 * Derived through the only path the schema offers: `team_players` → `seasons`
 * → `league_id`. NOT filtered on `left_on`: a player who left a team in March
 * still played in that league, and a rename still changes the name on that
 * league's stats pages — which is exactly what the containment test in
 * `mayWritePlayer` is asking about.
 *
 * An empty array means a player nobody has rostered anywhere. Callers must
 * decide what that means for them rather than reading it as "no restriction";
 * in `mayWritePlayer` it passes containment vacuously, and is meant to.
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
 * A schedule constraint belongs to the league of the season it constrains.
 *
 * Same shape as `leagueOfTeamPlayer`: the action holds a constraint id and no
 * league, and the season is the only hop to one. Not resolved through `team_id`
 * — a team carries a `league_id` directly, but a constraint's authority comes
 * from the season it is attached to, and those are the same league by
 * construction (a season only enrols its own league's teams).
 */
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
 * Validates a league id, for entities audited under their league's own id.
 *
 * Shaped differently from the resolvers above on purpose: those derive a league
 * from some *other* entity, while this one is for things that are per-league
 * already, where the entity id IS the league id. Two use it —
 * `league_rules` (one row per league, and `saveRules` upserts, so a first save
 * has no row id to name) and `league_staff` (a person spans leagues, so a
 * profile id names no single one; the league is the entity being changed).
 *
 * Still a lookup rather than handing the argument back: an id matching no
 * league returns null and fails closed, like the others.
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
