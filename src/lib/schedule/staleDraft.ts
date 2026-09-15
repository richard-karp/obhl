import { leagueDateKey, leagueOffset, leagueTimeKey } from "@/lib/format";

// ⛔ A draft whose first game passed between generate and publish locks the season for good
// once published. Face-off instants, not days. RUNBOOK.md, _Schedule edits and exports_.
// ⚠️ It warns and publish needs `stale_ok`; never a flat refusal: publishing already-played games before scoring is legitimate.

const DAY_MS = 86_400_000;

/** ⛔ UTC arithmetic: local midnight plus 7×86 400 000 ms lands a day early across DST and
 *  moves a Tuesday schedule onto Mondays. */
export function shiftDateByWeeks(date: string, weeks: number): string {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d) + weeks * 7 * DAY_MS)
    .toISOString()
    .slice(0, 10);
}

/** ⚠️ Wall clock on the new date, as `moveNightTo` moves it: the old date's offset describes a
 *  game that will not exist. */
const instantOf = (date: string, time: string): number =>
  Date.parse(`${date}T${time}:00${leagueOffset(date)}`);

export type StaleDraft = {
  /** The league-zone date of the draft's earliest game — the night that passed. */
  firstNight: string;
  /** How many of the draft's nights have already begun. */
  passedNights: number;
  /** Whole weeks the draft must move for that game to be ahead of us again. */
  weeks: number;
  shiftedFirstNight: string;
};

/** Null when the first game is still ahead. ⚠️ Shifts by whole weeks (days would move weekdays
 *  and ice), the fewest that put the first face-off genuinely ahead of `now`. */
export function staleDraft({
  games,
  now,
}: {
  /** Every dated draft game's `scheduled_at`, in any order. */
  games: string[];
  /** The current instant, as an ISO timestamp. */
  now: string;
}): StaleDraft | null {
  const nowMs = Date.parse(now);

  let earliest = Number.POSITIVE_INFINITY;
  const nightStart = new Map<string, number>();
  for (const iso of games) {
    const ms = Date.parse(iso);
    if (Number.isNaN(ms)) continue;
    if (ms < earliest) earliest = ms;
    const date = leagueDateKey(iso);
    const held = nightStart.get(date);
    if (held === undefined || ms < held) nightStart.set(date, ms);
  }
  if (!Number.isFinite(earliest) || earliest >= nowMs) return null;

  const firstIso = new Date(earliest).toISOString();
  const firstNight = leagueDateKey(firstIso);
  const faceOff = leagueTimeKey(firstIso);

  // ⚠️ From 1, climbing until the shifted game is ahead: `Math.ceil(daysBehind / 7)` can land it
  // on today at a time already gone. A NaN instant compares false and ends the loop.
  let weeks = 1;
  while (instantOf(shiftDateByWeeks(firstNight, weeks), faceOff) <= nowMs) {
    weeks++;
  }

  return {
    firstNight,
    passedNights: [...nightStart.values()].filter((ms) => ms < nowMs).length,
    weeks,
    shiftedFirstNight: shiftDateByWeeks(firstNight, weeks),
  };
}
