import {
  formatLongDate,
  leagueDateKey,
  leagueOffset,
  leagueTimeKey,
} from "@/lib/format";

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
  /** ⛔ The game's own `scheduled_at` (null when postponed), not its night's date: repair
   *  writes it back. RUNBOOK.md, _Schedule edits and exports_. */
  scheduledAt: string | null;
  label: string | null;
  /** Carried so a refusal can name the game that locked the night, not just refuse. */
  status: string;
};

export type SeasonNight = {
  /** League-local calendar date, "YYYY-MM-DD". */
  date: string;
  /** Past, or a game has left `scheduled`. Whole nights, because re-pairing part of one would
   *  break one game per team. */
  locked: boolean;
  /** The night's games in ice-time order. */
  games: SeasonNightGame[];
};

/** ⛔ A postponed game is placed by `postponed_from`, or its night loses its lock and repair
 *  re-pairs it. `today` is a league date key. RUNBOOK.md, _Schedule edits and exports_. */
export function groupIntoNights(
  rows: NightRow[],
  today: string,
): SeasonNight[] {
  // `at` places the game; `game.scheduledAt` is what gets written. Conflate them and a cleared
  // date comes back.
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

/** Whether a whole-night move is allowed, else why. ⚠️ A target night that already runs games
 *  is refused, not merged: how many games an evening runs is an ice-booking question.
 *  ⛔ A locked night is named, not just refused; a game with goals is always off `scheduled`
 *  (`bumpStat`), so no goals query is needed. */
export function checkNightMove(opts: {
  nights: SeasonNight[];
  from: string;
  to: string;
  /** League-local: server UTC runs up to five hours ahead and would refuse evening moves. */
  today: string;
  season: { startsOn: string | null; endsOn: string | null };
  nameOf: (id: string) => string;
}): string | null {
  const { nights, from, to, today, season, nameOf } = opts;
  if (from === to) return "That night is already on that date.";

  // ⛔ The one-way door: a published game moved into the past trips `season_is_started` for
  // good, and a past night locks, so nothing moves it back. Today itself passes.
  if (to < today) {
    return "That date has already passed. Moving live games into the past locks the season — it can no longer be regenerated, replaced or removed — and there is no undo.";
  }
  if (season.startsOn && to < season.startsOn) {
    return `${formatLongDate(to)} is before the season starts on ${formatLongDate(season.startsOn)}.`;
  }
  if (season.endsOn && to > season.endsOn) {
    return `${formatLongDate(to)} is after the season ends on ${formatLongDate(season.endsOn)}.`;
  }

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

/** `from` rides along because the write applies only while the row still holds it. */
export type MovedGame = { id: string; from: string; scheduledAt: string };

/** ⚠️ Wall clock, not instant: 19:00 stays 19:00 across a DST boundary, keeping the gaps. A
 *  game with no `scheduledAt` (postponed, so its night is locked) is dropped. */
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
            from: g.scheduledAt,
            scheduledAt: `${targetDate}T${leagueTimeKey(g.scheduledAt)}:00${offset}`,
          },
        ]
      : [],
  );
}
