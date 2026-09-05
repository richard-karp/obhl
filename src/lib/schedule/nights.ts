import { leagueDateKey } from "@/lib/format";

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
