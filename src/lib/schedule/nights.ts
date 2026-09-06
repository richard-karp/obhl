import {
  formatLongDate,
  leagueDateKey,
  leagueOffset,
  leagueTimeKey,
} from "@/lib/format";

/** A game row as the night grouping needs it, independent of the query shape. */
export type NightRow = {
  id: string;
  scheduled_at: string | null;
  postponed_from: string | null;
  status: string;
  label: string | null;
  home_team_id: string;
  away_team_id: string;
};

export type SeasonNightGame = {
  id: string;
  homeTeamId: string;
  awayTeamId: string;
  /**
   * The game's own `scheduled_at`, which is null for a postponed game — *not*
   * the date the night was derived from. The one-off repair writes this value
   * straight back, so carrying `postponed_from` here would resurrect a date that
   * was deliberately cleared.
   */
  scheduledAt: string | null;
  label: string | null;
  /**
   * The row's own status. Carried so a caller refusing a locked night can say
   * WHICH game locked it — `locked` on its own is a boolean with no story, and
   * "that night has been played" about a night where one game is postponed is
   * the wrong sentence.
   */
  status: string;
};

export type SeasonNight = {
  /** League-local calendar date, "YYYY-MM-DD". */
  date: string;
  /**
   * The repair may not touch this night: it's in the past, or one of its games
   * has moved off `scheduled` (played, in progress, postponed, cancelled).
   * Whole-night granularity, because re-pairing part of a night would break
   * one-game-per-team.
   */
  locked: boolean;
  /** The night's games in ice-time order. */
  games: SeasonNightGame[];
};

/**
 * Groups a season's games into the nights the one-off planner reasons about.
 *
 * Pure, and takes `today` as a league date key rather than reading the clock, so
 * the locking rules can be tested.
 *
 * A postponed game is placed by `postponed_from`: it has no `scheduled_at` any
 * more, and grouping on that alone would drop it — which would take its night's
 * lock with it and let the planner re-pair a night it must not touch. A game
 * with neither date has no night to belong to and is dropped.
 */
export function groupIntoNights(
  rows: NightRow[],
  today: string,
): SeasonNight[] {
  // `at` is where the night is; `game.scheduledAt` is what the row actually
  // holds. They differ for a postponed game, and conflating them is how a
  // cleared date would find its way back into the column.
  type Slot = { at: string; game: SeasonNightGame };
  const byDate = new Map<string, { slots: Slot[]; locked: boolean }>();

  for (const g of rows) {
    const at = g.scheduled_at ?? g.postponed_from;
    if (!at) continue;
    const date = leagueDateKey(at);
    const night =
      byDate.get(date) ??
      byDate.set(date, { slots: [], locked: date < today }).get(date)!;
    if (g.status !== "scheduled") night.locked = true;
    night.slots.push({
      at,
      game: {
        id: g.id,
        homeTeamId: g.home_team_id,
        awayTeamId: g.away_team_id,
        scheduledAt: g.scheduled_at,
        label: g.label,
        status: g.status,
      },
    });
  }

  return [...byDate.entries()]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([date, n]) => ({
      date,
      locked: n.locked,
      games: n.slots.sort((a, b) => (a.at < b.at ? -1 : 1)).map((s) => s.game),
    }));
}

/**
 * Whether a whole-night move is allowed, and if not, why — in a sentence a
 * manager can act on.
 *
 * Pure and in this module rather than in the server action, for the reason
 * `checkOneOffWrite` is: every refusal here is a decision worth testing without
 * a database, and there are four of them.
 *
 * ⛔ A LOCKED NIGHT IS NAMED, NOT JUST REFUSED. `locked` is set by
 * `groupIntoNights` from exactly two conditions — the date is behind us, or a
 * game has moved off `scheduled` — and they want different sentences. A game
 * with goals is always the second one, because the first bumped stat takes a
 * game to `in_progress` (`bumpStat` in actions/games.ts), so this covers the
 * "has goals" half of the season lock without a second query for them.
 *
 * ⚠️ A target night that already runs games is refused rather than merged.
 * Combining two nights changes how many games run in an evening, which is an
 * ice-booking question the app cannot answer — so the count is reported and the
 * decision left with the manager.
 */
export function checkNightMove(opts: {
  nights: SeasonNight[];
  from: string;
  to: string;
  /** Team id → name, for naming the game that blocked the move. */
  nameOf: (id: string) => string;
}): string | null {
  const { nights, from, to, nameOf } = opts;
  if (from === to) return "That night is already on that date.";

  const source = nights.find((n) => n.date === from);
  if (!source) return "That date isn't a game night this season.";

  if (source.locked) {
    const blocker = source.games.find((g) => g.status !== "scheduled");
    if (!blocker) {
      return `${formatLongDate(from)} is in the past, so it can't be moved.`;
    }
    return `${formatLongDate(from)} can't move — ${nameOf(blocker.awayTeamId)} @ ${nameOf(blocker.homeTeamId)} is ${blocker.status.replace("_", " ")}.`;
  }

  const clash = nights.find((n) => n.date === to);
  if (clash) {
    const n = clash.games.length;
    return `${formatLongDate(to)} already runs ${n} game${n === 1 ? "" : "s"}. Combining two nights isn't something this can decide — move them one game at a time instead.`;
  }

  return null;
}

/** One game's new timestamp, as `rescheduleNight` writes it. */
export type MovedGame = { id: string; scheduledAt: string };

/**
 * Move a whole night's games to another date, keeping their ice-time order and
 * the gaps between the slots.
 *
 * The rule is **wall clock, not instant**: a game on the ice at 19:00 is on the
 * ice at 19:00 on the new date, whichever side of the DST boundary each date
 * falls. That preserves the gaps by construction — 19:00/20:15/21:30 stays
 * 19:00/20:15/21:30 — where carrying the UTC instants forward would shift the
 * whole night by an hour across a boundary, and rewriting only the date part of
 * the string would do the same thing while looking correct.
 *
 * Pure, and takes the games in the order they should keep. `groupIntoNights`
 * already returns a night's games in ice-time order, so a caller handing one
 * straight over gets that order back.
 *
 * A game with no `scheduledAt` is dropped rather than given a time. Only a
 * postponed game is in that state, its night is locked, and `rescheduleNight`
 * refuses a locked night — so this is the belt to that braces, not a path.
 */
export function moveNightTo(
  games: { id: string; scheduledAt: string | null }[],
  targetDate: string,
): MovedGame[] {
  const offset = leagueOffset(targetDate);
  return games.flatMap((g) =>
    g.scheduledAt
      ? [
          {
            id: g.id,
            scheduledAt: `${targetDate}T${leagueTimeKey(g.scheduledAt)}:00${offset}`,
          },
        ]
      : [],
  );
}
