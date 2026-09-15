import { createClient } from "@/utils/supabase/server";
import { leagueDateKey, leagueDayStart } from "@/lib/format";
import { isUuid } from "@/lib/db/uuid";
import { groupIntoNights, type SeasonNight } from "@/lib/schedule/nights";
import {
  isConstraintKind,
  type ConstraintParams,
  type ScheduleConstraint,
} from "@/lib/schedule/constraints";
import type { DbClient } from "@/lib/db/helpers";

// The one place a game's teams are named. `TeamLogo`'s fallbacks are silent, so a column missing
// here looks like a team that chose the default.
const GAME_SELECT = `
  id, scheduled_at, postponed_from, status, week, round, home_goals, away_goals, result_type, is_draft, label,
  home_team:teams!games_home_team_id_fkey(id, name, slug, color, logo_path, logo_text_color),
  away_team:teams!games_away_team_id_fkey(id, name, slug, color, logo_path, logo_text_color)
`;

export type GameTeam = {
  id: string;
  name: string;
  slug: string;
  color: string | null;
  logo_path: string | null;
  logo_text_color: string | null;
};

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
  home_team: GameTeam | null;
  away_team: GameTeam | null;
};

/**
 * ⛔ A failed read and an empty season are different values, as in `GamesOnDate`. `readFailed` means
 * both attempts failed; a blip the retry absorbs logs `… read retried`, which CI greps for.
 */
export type ScheduleRead = { games: GameWithTeams[]; readFailed: boolean };

/**
 * Retry, log and shape. ⚠️ One `label` spells both "<label> retried" and "<label> failed", the pair
 * CI's diagnostics step greps for, so they cannot drift apart.
 */
async function gamesRead(
  run: () => PromiseLike<{ data: unknown; error: { message: string } | null }>,
  label: string,
): Promise<ScheduleRead> {
  const { data, error } = await readWithOneRetry(run, label);
  if (error) {
    console.error(`${label} failed:`, error.message);
    return { games: [], readFailed: true };
  }
  return {
    games: (data ?? []) as unknown as GameWithTeams[],
    readFailed: false,
  };
}

/**
 * `client` defaults to the RLS client. Pass the admin client only from a manager-gated
 * caller; anything a merely signed-in user can reach must leave the default.
 */
export async function getSchedule(
  seasonId: string,
  opts: { teamId?: string; client?: DbClient } = {},
): Promise<ScheduleRead> {
  const { teamId, client } = opts;
  const supabase = client ?? (await createClient());
  // ⛔ `.or()` interpolates the id unparameterised, unlike `.eq()`: every team filter in this file checks
  // `isUuid` itself. An id no team can have genuinely has no games, so this is not a failed read.
  if (teamId && !isUuid(teamId)) return { games: [], readFailed: false };
  // ⛔ A factory, not a builder: an awaited PostgREST builder is spent, so the retry builds anew.
  return gamesRead(() => {
    const q = supabase
      .from("games")
      .select(GAME_SELECT)
      .eq("season_id", seasonId)
      .eq("is_draft", false)
      .order("scheduled_at", { ascending: true });
    return teamId
      ? q.or(`home_team_id.eq.${teamId},away_team_id.eq.${teamId}`)
      : q;
  }, "schedule read");
}

export type GameWithLeague = GameWithTeams & { league_id: string };

/**
 * ⛔ `readFailed` keeps a failed read from telling a scorekeeper at the rink there are no
 * games tonight: "no rows" and "not allowed to look" must not be the same value.
 */
export type GamesOnDate = { games: GameWithLeague[]; readFailed: boolean };

// ⛔ Not added to `GAME_SELECT`: every other reader's result shape would change for a field
// none of them reads.
const GAME_SELECT_WITH_LEAGUE = `${GAME_SELECT}, season:seasons!inner(league_id)`;

/**
 * ⛔ Both bounds come from `leagueDayStart`, never `leagueOffset`, which samples noon: on a
 * DST day (1 Nov 2026 is 25 hours long) the window would start an hour late.
 */
export async function getGamesOnDate(
  leagueIds: string[],
  dateKey: string,
  opts: { client?: DbClient } = {},
): Promise<GamesOnDate> {
  // ⛔ Not an optimisation: an empty list would build a query with no league filter, an
  // unfiltered read of every game. Not a failure: no scorable league means no games.
  if (leagueIds.length === 0) return { games: [], readFailed: false };

  const supabase = opts.client ?? (await createClient());
  const day = dateKey.slice(0, 10);
  const next = new Date(`${day}T12:00:00Z`);
  next.setUTCDate(next.getUTCDate() + 1);
  const nextDay = next.toISOString().slice(0, 10);

  const { data, error } = await supabase
    .from("games")
    .select(GAME_SELECT_WITH_LEAGUE)
    // Keyed on league and date, never season: tonight's game may belong to an inactive season.
    .in("season.league_id", leagueIds)
    // Explicit, not left to RLS: a caller may pass the admin client, which bypasses the policy.
    .eq("is_draft", false)
    .gte("scheduled_at", leagueDayStart(day))
    .lt("scheduled_at", leagueDayStart(nextDay))
    .order("scheduled_at", { ascending: true });

  if (error) {
    console.error("games-on-date read failed:", error.message);
    return { games: [], readFailed: true };
  }
  const games = (
    (data ?? []) as unknown as Array<
      GameWithTeams & { season: { league_id: string } | null }
    >
  )
    // ⛔ Dropped, never defaulted: a `?? ""` would ship a dead `/undefined/games/<id>/score`
    // link. The `!inner` embed means it cannot happen.
    .filter((g) => !!g.season?.league_id)
    .map(({ season, ...game }) => ({ ...game, league_id: season!.league_id }));
  return { games, readFailed: false };
}

/** Not season-scoped: narrowing it would delete past games from calendars that hold them. */
export async function getTeamFeedGames(
  teamId: string,
  opts: { client?: DbClient } = {},
): Promise<ScheduleRead> {
  if (!isUuid(teamId)) return { games: [], readFailed: false };
  const supabase = opts.client ?? (await createClient());
  return gamesRead(
    () =>
      supabase
        .from("games")
        .select(GAME_SELECT)
        .eq("is_draft", false)
        .or(`home_team_id.eq.${teamId},away_team_id.eq.${teamId}`)
        .order("scheduled_at", { ascending: true }),
    "team feed read",
  );
}

export async function getUpcoming(
  seasonId: string,
  opts: { limit?: number; teamId?: string; client?: DbClient } = {},
): Promise<ScheduleRead> {
  const { limit = 5, teamId, client } = opts;
  const supabase = client ?? (await createClient());
  if (teamId && !isUuid(teamId)) return { games: [], readFailed: false };
  // Sampled once, outside the factory: a retry must re-run the same query, not a later one.
  const from = new Date().toISOString();
  return gamesRead(() => {
    const q = supabase
      .from("games")
      .select(GAME_SELECT)
      .eq("season_id", seasonId)
      .eq("is_draft", false)
      .eq("status", "scheduled")
      .gte("scheduled_at", from)
      .order("scheduled_at", { ascending: true })
      .limit(limit);
    return teamId
      ? q.or(`home_team_id.eq.${teamId},away_team_id.eq.${teamId}`)
      : q;
  }, "upcoming read");
}

export type { SeasonNight, SeasonNightGame } from "@/lib/schedule/nights";

/**
 * ⛔ Two server actions validate against these nights: flattened to `[]`, a failed read makes every
 * date "not a game night" and refuses the write for a false reason.
 */
export type SeasonNightsRead = { nights: SeasonNight[]; readFailed: boolean };

/** Grouping and locking rules live in `groupIntoNights`; this only fetches the rows. */
export async function getSeasonNights(
  seasonId: string,
  opts: { client?: DbClient } = {},
): Promise<SeasonNightsRead> {
  const supabase = opts.client ?? (await createClient());
  const { data, error } = await readWithOneRetry(
    () =>
      supabase
        .from("games")
        .select(
          "id, scheduled_at, postponed_from, status, label, home_team_id, away_team_id",
        )
        .eq("season_id", seasonId)
        .eq("is_draft", false)
        .order("scheduled_at", { ascending: true }),
    "season nights read",
  );
  if (error) {
    console.error("season nights read failed:", error.message);
    return { nights: [], readFailed: true };
  }

  return {
    nights: groupIntoNights(
      data ?? [],
      leagueDateKey(new Date().toISOString()),
    ),
    readFailed: false,
  };
}

/**
 * In the generator's shape: `params` is `jsonb`, narrowed only here. A `kind` this build
 * does not know can only come from a newer deploy, and is dropped.
 */
export async function getScheduleConstraints(
  seasonId: string,
  // ⛔ Required, and it must be the admin client: `0039` grants the table to nobody, so an RLS
  // read logs 42501 and returns `[]`, a season with no requests instead of an error.
  opts: { client: DbClient },
): Promise<ScheduleConstraint[]> {
  if (!isUuid(seasonId)) return [];
  const supabase = opts.client;
  const { data, error } = await supabase
    .from("season_schedule_constraints")
    .select("id, team_id, kind, params")
    .eq("season_id", seasonId)
    .order("created_at", { ascending: true });
  if (error) {
    console.error("schedule constraints read failed:", error.message);
    return [];
  }
  return (data ?? []).flatMap((r) =>
    isConstraintKind(r.kind)
      ? [
          {
            id: r.id,
            teamId: r.team_id,
            kind: r.kind,
            params: (r.params ?? {}) as ConstraintParams,
          },
        ]
      : [],
  );
}

export async function getRecentResults(
  seasonId: string,
  opts: { limit?: number; teamId?: string; client?: DbClient } = {},
): Promise<ScheduleRead> {
  const { limit = 5, teamId, client } = opts;
  const supabase = client ?? (await createClient());
  if (teamId && !isUuid(teamId)) return { games: [], readFailed: false };
  return gamesRead(() => {
    const q = supabase
      .from("games")
      .select(GAME_SELECT)
      // Explicit rather than relying on `public read games` to exclude drafts:
      // an admin client bypasses that policy.
      .eq("is_draft", false)
      .eq("season_id", seasonId)
      .eq("status", "final")
      .order("scheduled_at", { ascending: false })
      .limit(limit);
    return teamId
      ? q.or(`home_team_id.eq.${teamId},away_team_id.eq.${teamId}`)
      : q;
  }, "recent results read");
}

/**
 * `started` comes from the `season_is_started` RPC, never recomputed: a TypeScript copy
 * of the gate `replace_published_schedule` enforces could drift from it.
 */
export type SchedulePublishState = {
  liveCount: number;
  draftCount: number;
  started: boolean;
  /** League-local YYYY-MM-DD of the first/last dated live game; null if none. */
  firstLiveDate: string | null;
  lastLiveDate: string | null;
  /** Moves when the schedule is replaced (every game gets a new id), not when edited in place. */
  liveScheduleKey: string;
  /** Lineups on live games: they cascade on game delete (`0004`), so the confirm dialog names them. */
  lineupsAtRisk: number;
  /** A read failed and `started` locked shut: the counts are then unknown, not zero. */
  readFailed: boolean;
};

const READ_RETRY_DELAY_MS = 150;

/**
 * ⛔ Reads only, and one retry (a gateway 502 is a valid response, so nothing below retries it):
 * a read failing twice still fails closed. Takes a factory, since an awaited builder is spent.
 */
export async function readWithOneRetry<T extends { error: unknown }>(
  run: () => PromiseLike<T>,
  /** Its log line ends "read retried", which CI's diagnostics step greps for. */
  label = "publish state read",
): Promise<T> {
  const first = await run();
  if (!first.error) return first;

  // ⛔ Logged, or a retry that worked leaves no trace and a worsening fault goes unseen.
  // `warn`, not `error`: the read succeeded on the second try.
  console.warn(
    `${label} retried:`,
    (first.error as { message?: string })?.message ?? String(first.error),
  );

  await new Promise((resolve) => setTimeout(resolve, READ_RETRY_DELAY_MS));
  return run();
}

export async function getPublishState(
  seasonId: string,
  opts: { client?: DbClient } = {},
): Promise<SchedulePublishState> {
  const supabase = opts.client ?? (await createClient());

  const liveGames = () =>
    supabase
      .from("games")
      // `id` feeds `liveScheduleKey` through `lowestId` below.
      .select("id, scheduled_at")
      .eq("season_id", seasonId)
      .eq("is_draft", false);

  const [live, firstLive, lastLive, lowestId, drafts, started, lineups] =
    await Promise.all([
      // An exact server count, never `data.length`, which PostgREST's `max_rows` (1000) caps
      // while the RPC deletes every game. `head: true` returns no rows.
      readWithOneRetry(() =>
        supabase
          .from("games")
          .select("*", { count: "exact", head: true })
          .eq("season_id", seasonId)
          .eq("is_draft", false),
      ),
      // `id` breaks ties: games on one night often share a timestamp, and without it two renders
      // of an unchanged schedule can disagree on the first game.
      readWithOneRetry(() =>
        liveGames()
          .not("scheduled_at", "is", null)
          .order("scheduled_at", { ascending: true })
          .order("id", { ascending: true })
          .limit(1),
      ),
      readWithOneRetry(() =>
        liveGames()
          .not("scheduled_at", "is", null)
          .order("scheduled_at", { ascending: false })
          .order("id", { ascending: false })
          .limit(1),
      ),
      // ⛔ Ordered by id, never date: this feeds `liveScheduleKey`, and moving a night to the front
      // would remount the generate form and discard what the manager typed.
      readWithOneRetry(() =>
        liveGames().order("id", { ascending: true }).limit(1),
      ),
      readWithOneRetry(() =>
        supabase
          .from("games")
          .select("*", { count: "exact", head: true })
          .eq("season_id", seasonId)
          .eq("is_draft", true),
      ),
      readWithOneRetry(() =>
        supabase.rpc("season_is_started", { p_season: seasonId }),
      ),
      readWithOneRetry(() =>
        supabase
          .from("game_rosters")
          .select("id, games!inner(season_id, is_draft)", {
            count: "exact",
            head: true,
          })
          .eq("games.season_id", seasonId)
          .eq("games.is_draft", false),
      ),
    ]);

  // ⛔ `lowestId` is deliberately not in the fail-closed list: its failure only leaves the
  // generate form un-cleared, which does not justify locking the builder.
  if (lowestId.error) {
    console.error("live schedule key read failed:", lowestId.error.message);
  }
  // Fail closed on ANY other read: an absorbed live-count error reads as 0 and offers a one-click
  // publish, with no dialog, over an RPC that deletes the live schedule.
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
    liveScheduleKey: `${live.count ?? 0}:${lowestId.data?.[0]?.id ?? ""}`,
    lineupsAtRisk: lineups.count ?? 0,
    readFailed: !!failure,
  };
}
