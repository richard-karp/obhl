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
  home_team: {
    id: string;
    name: string;
    slug: string;
    color: string | null;
  } | null;
  away_team: {
    id: string;
    name: string;
    slug: string;
    color: string | null;
  } | null;
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
  /**
   * True when one of the reads below failed and `started` was locked shut
   * rather than answered. The counts in this object are then *unknown*, not
   * zero — anything rendering them has to say so instead of stating them.
   */
  readFailed: boolean;
};

export async function getPublishState(
  seasonId: string,
  opts: { client?: DbClient } = {},
): Promise<SchedulePublishState> {
  const supabase = opts.client ?? (await createClient());

  const liveGames = () =>
    supabase
      .from("games")
      .select("scheduled_at")
      .eq("season_id", seasonId)
      .eq("is_draft", false);

  const [live, firstLive, lastLive, drafts, started, lineups] =
    await Promise.all([
      // An exact count from the server, not `data.length`. Counting the returned
      // rows silently capped liveCount at PostgREST's `max_rows` (1000 — see
      // supabase/config.toml), so a season past that would have told the manager a
      // replace deletes 1000 games while the RPC deleted every one of them. It is
      // also the read most likely to time out, being the only one here that
      // touched every row in the season; `head: true` returns no rows at all.
      supabase
        .from("games")
        .select("*", { count: "exact", head: true })
        .eq("season_id", seasonId)
        .eq("is_draft", false),
      // First and last dated live game, one row each rather than sorting the whole
      // season in memory. Undated games are excluded here on purpose — they have
      // no place in a date range — and no longer need to be carried by this query
      // to be counted, now that the count above is its own request.
      liveGames()
        .not("scheduled_at", "is", null)
        .order("scheduled_at", { ascending: true })
        .limit(1),
      liveGames()
        .not("scheduled_at", "is", null)
        .order("scheduled_at", { ascending: false })
        .limit(1),
      supabase
        .from("games")
        .select("*", { count: "exact", head: true })
        .eq("season_id", seasonId)
        .eq("is_draft", true),
      supabase.rpc("season_is_started", { p_season: seasonId }),
      supabase
        .from("game_rosters")
        .select("id, games!inner(season_id, is_draft)", {
          count: "exact",
          head: true,
        })
        .eq("games.season_id", seasonId)
        .eq("games.is_draft", false),
    ]);

  // Fail closed on ANY of them, not just the RPC.
  //
  // These are independent PostgREST requests, so one can fail on its own and
  // leave the returned state looking authoritative. Every decision the builder
  // makes is derived from these numbers — whether to offer the generate form,
  // whether publishing confirms first, and what the confirmation says will be
  // destroyed — so a partial read produces a confident answer from incomplete
  // data. Absorbing a live-count error is the dangerous one: it reads as
  // liveCount 0, which is publishMode's "draft-only", and the manager gets a
  // one-click "Publish N games" with no dialog, no live count and no lineup
  // warning, while the RPC behind that button still deletes the whole live
  // schedule. Absorbing a lineup error quietly drops the warning that captains'
  // lineups are deleted along with the games.
  //
  // Locking is the only honest way to fail closed here. A count has no "unknown"
  // value publishMode could branch on, and inventing a non-zero one would put a
  // fabricated number in front of the manager on the one screen in this app that
  // deletes data. So the builder reports "started" and offers no publish path at
  // all; nothing is destroyed, the RPC's own gate is unchanged, and the next
  // render with a working query unlocks it.
  //
  // `readFailed` travels with it because locking alone still leaves the counts
  // reading as a confident zero. Without it the locked card stated "0 games are
  // published" about a season that may hold hundreds — the same fabricated
  // number, moved one screen over.
  const failure =
    live.error ??
    firstLive.error ??
    lastLive.error ??
    drafts.error ??
    started.error ??
    lineups.error;
  if (failure) console.error("publish state read failed:", failure.message);

  const firstAt = firstLive.data?.[0]?.scheduled_at ?? null;
  const lastAt = lastLive.data?.[0]?.scheduled_at ?? null;

  return {
    liveCount: live.count ?? 0,
    draftCount: drafts.count ?? 0,
    started: failure ? true : started.data === true,
    firstLiveDate: firstAt ? leagueDateKey(firstAt) : null,
    lastLiveDate: lastAt ? leagueDateKey(lastAt) : null,
    lineupsAtRisk: lineups.count ?? 0,
    readFailed: !!failure,
  };
}
