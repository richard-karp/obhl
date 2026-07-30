import { createClient } from "@/utils/supabase/server";
import { leagueDateKey } from "@/lib/format";
import { isUuid } from "@/lib/db/uuid";
import { groupIntoNights, type SeasonNight } from "@/lib/schedule/nights";
import type { DbClient } from "@/lib/db/helpers";

// Every helper here that filters by team interpolates the id into a PostgREST
// `.or()` string, which is not parameterised the way `.eq()` is. Each one
// therefore checks the id itself and returns nothing if it isn't a UUID, rather
// than trusting its caller — a rule that only holds if it holds uniformly, since
// one guarded helper among several reads as though the others were judged safe.

// Shared select for a game with both teams embedded (disambiguated by FK).
const GAME_SELECT = `
  id, scheduled_at, postponed_from, status, week, round, home_goals, away_goals, result_type, is_draft, label,
  home_team:teams!games_home_team_id_fkey(id, name, slug, color),
  away_team:teams!games_away_team_id_fkey(id, name, slug, color)
`;

export type GameWithTeams = {
  id: string;
  scheduled_at: string | null;
  /** Where a postponed game sat before it was postponed; null otherwise. */
  postponed_from: string | null;
  status: "scheduled" | "in_progress" | "final" | "postponed" | "cancelled";
  week: number | null;
  round: number | null;
  home_goals: number;
  away_goals: number;
  result_type: "regulation" | "overtime" | "shootout";
  is_draft: boolean;
  label: string | null;
  home_team: { id: string; name: string; slug: string; color: string | null } | null;
  away_team: { id: string; name: string; slug: string; color: string | null } | null;
};

/**
 * All published games for a season, optionally filtered to one team.
 *
 * Like every read helper here, it takes its options as an object whose `client`
 * defaults to the RLS client. Manager-gated callers pass the admin client so
 * they don't depend on the season being publicly readable; anything reachable
 * by a merely signed-in user must leave the default alone.
 */
export async function getSchedule(
  seasonId: string,
  opts: { teamId?: string; client?: DbClient } = {},
): Promise<GameWithTeams[]> {
  const { teamId, client } = opts;
  const supabase = client ?? (await createClient());
  let q = supabase
    .from("games")
    .select(GAME_SELECT)
    .eq("season_id", seasonId)
    .eq("is_draft", false)
    .order("scheduled_at", { ascending: true });
  if (teamId) {
    if (!isUuid(teamId)) return [];
    q = q.or(`home_team_id.eq.${teamId},away_team_id.eq.${teamId}`);
  }
  const { data, error } = await q;
  if (error) console.error("schedule query failed:", error.message);
  return (data ?? []) as unknown as GameWithTeams[];
}

/**
 * Every published game a team has ever played, for its calendar feed.
 *
 * Deliberately not season-scoped: a subscription is a standing thing, and
 * narrowing it to the active season would delete past games out of calendars
 * that already hold them.
 */
export async function getTeamFeedGames(
  teamId: string,
  opts: { client?: DbClient } = {},
): Promise<GameWithTeams[]> {
  if (!isUuid(teamId)) return [];
  const supabase = opts.client ?? (await createClient());
  const { data, error } = await supabase
    .from("games")
    .select(GAME_SELECT)
    .eq("is_draft", false)
    .or(`home_team_id.eq.${teamId},away_team_id.eq.${teamId}`)
    .order("scheduled_at", { ascending: true });
  if (error) console.error("team feed query failed:", error.message);
  return (data ?? []) as unknown as GameWithTeams[];
}

/** Upcoming (scheduled, future) games. */
export async function getUpcoming(
  seasonId: string,
  opts: { limit?: number; teamId?: string; client?: DbClient } = {},
): Promise<GameWithTeams[]> {
  const { limit = 5, teamId, client } = opts;
  const supabase = client ?? (await createClient());
  let q = supabase
    .from("games")
    .select(GAME_SELECT)
    .eq("season_id", seasonId)
    .eq("is_draft", false)
    .eq("status", "scheduled")
    .gte("scheduled_at", new Date().toISOString())
    .order("scheduled_at", { ascending: true })
    .limit(limit);
  if (teamId) {
    if (!isUuid(teamId)) return [];
    q = q.or(`home_team_id.eq.${teamId},away_team_id.eq.${teamId}`);
  }
  const { data, error } = await q;
  if (error) console.error("schedule query failed:", error.message);
  return (data ?? []) as unknown as GameWithTeams[];
}

export type { SeasonNight, SeasonNightGame } from "@/lib/schedule/nights";

/**
 * A season's published games grouped into nights, in the shape the one-off
 * planner reasons about.
 *
 * The grouping and locking rules live in `groupIntoNights`, which is pure and
 * tested; this only fetches the rows.
 */
export async function getSeasonNights(
  seasonId: string,
  opts: { client?: DbClient } = {},
): Promise<SeasonNight[]> {
  const supabase = opts.client ?? (await createClient());
  const { data, error } = await supabase
    .from("games")
    .select(
      "id, scheduled_at, postponed_from, status, label, home_team_id, away_team_id",
    )
    .eq("season_id", seasonId)
    .eq("is_draft", false)
    .order("scheduled_at", { ascending: true });
  if (error) {
    console.error("season nights query failed:", error.message);
    return [];
  }

  return groupIntoNights(data ?? [], leagueDateKey(new Date().toISOString()));
}

/** Most recent final games. */
export async function getRecentResults(
  seasonId: string,
  opts: { limit?: number; teamId?: string; client?: DbClient } = {},
): Promise<GameWithTeams[]> {
  const { limit = 5, teamId, client } = opts;
  const supabase = client ?? (await createClient());
  let q = supabase
    .from("games")
    .select(GAME_SELECT)
    // Explicit rather than relying on `public read games` to exclude drafts:
    // an admin client bypasses that policy.
    .eq("is_draft", false)
    .eq("season_id", seasonId)
    .eq("status", "final")
    .order("scheduled_at", { ascending: false })
    .limit(limit);
  if (teamId) {
    if (!isUuid(teamId)) return [];
    q = q.or(`home_team_id.eq.${teamId},away_team_id.eq.${teamId}`);
  }
  const { data, error } = await q;
  if (error) console.error("schedule query failed:", error.message);
  return (data ?? []) as unknown as GameWithTeams[];
}

/**
 * Everything the schedule builder needs to decide what it may offer.
 *
 * `started` is read from the `season_is_started` RPC rather than recomputed
 * here: it is the gate `replace_published_schedule` enforces, and a second copy
 * of that predicate in TypeScript would be free to drift from the one that
 * actually guards the delete.
 */
export type SchedulePublishState = {
  liveCount: number;
  draftCount: number;
  started: boolean;
  /** League-local YYYY-MM-DD of the first/last dated live game; null if none. */
  firstLiveDate: string | null;
  lastLiveDate: string | null;
  /**
   * `game_rosters` rows hanging off live games. They cascade on game delete
   * (0004_games.sql), so a replace silently discards lineups a captain set in
   * advance — the confirm dialog names this when it is non-zero.
   */
  lineupsAtRisk: number;
};

export async function getPublishState(
  seasonId: string,
  opts: { client?: DbClient } = {},
): Promise<SchedulePublishState> {
  const supabase = opts.client ?? (await createClient());

  const [live, drafts, started, lineups] = await Promise.all([
    // Dates come back with the rows rather than as a min/max aggregate so an
    // undated live game still counts toward liveCount.
    supabase
      .from("games")
      .select("scheduled_at")
      .eq("season_id", seasonId)
      .eq("is_draft", false),
    supabase
      .from("games")
      .select("*", { count: "exact", head: true })
      .eq("season_id", seasonId)
      .eq("is_draft", true),
    supabase.rpc("season_is_started", { p_season: seasonId }),
    supabase
      .from("game_rosters")
      .select("id, games!inner(season_id, is_draft)", { count: "exact", head: true })
      .eq("games.season_id", seasonId)
      .eq("games.is_draft", false),
  ]);

  const dates = (live.data ?? [])
    .map((g) => g.scheduled_at)
    .filter((d): d is string => !!d)
    .sort();

  return {
    liveCount: live.data?.length ?? 0,
    draftCount: drafts.count ?? 0,
    // Fail closed. On an RPC error `data` is null, and reporting "not started"
    // would offer a Replace button on a season that has begun. The RPC still
    // refuses the write, so nothing is destroyed — but the UI would be lying,
    // and a lock the manager doesn't expect is the safer way to be wrong.
    started: started.error ? true : started.data === true,
    firstLiveDate: dates.length ? leagueDateKey(dates[0]) : null,
    lastLiveDate: dates.length ? leagueDateKey(dates[dates.length - 1]) : null,
    lineupsAtRisk: lineups.count ?? 0,
  };
}
