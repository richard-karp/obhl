import { leagueDateKey, leagueOffset, leagueTimeKey } from "@/lib/format";

/**
 * A draft whose first game has ALREADY BEEN PLAYED-OVER — the schedule aged
 * between generate and publish — and the shift that fixes it.
 *
 * ⛔ THE GAP THIS CLOSES, STATED EXACTLY. `isPastGameNight` (`./startDate`)
 * refuses a past first night at GENERATE, and its docstring argues — correctly
 * — against re-checking at publish, because a manager who typed a bad date
 * should hear about it before they have a draft they have reviewed. Neither end
 * covers the case in the middle: a draft generated against a perfectly valid
 * FUTURE date, left standing, and published after that date has passed.
 * Generate checked the date when the draft was made; nothing checks it again.
 *
 * That is not an unlikely path. It is the schedule rebuild workflow — generate
 * and review early in the week, publish later — so the window is however long
 * the manager waits.
 *
 * What makes it expensive: `season_is_started` (`0026`) counts only
 * `not is_draft`, so a past-dated draft is invisible to the lock right up until
 * it is published, and publishing it locks the season INSTANTLY AND FOR GOOD.
 * Generate, replace and remove all refuse from then on, with no undo.
 *
 * ⛔ MEASURED AGAINST AN INSTANT, NOT A CALENDAR DAY, AND THAT IS LOAD-BEARING.
 * This module compared date keys for one revision, mirroring `isPastGameNight`
 * — and `season_is_started`'s predicate is `scheduled_at < now()`, a TIMESTAMP.
 * The two disagree for the several hours between a night's first face-off and
 * midnight, and in that window a draft that locks the season the moment it is
 * published looks perfectly healthy: no banner, no confirmation, one click.
 *
 * ⚠️ Worse, the day-granular version could CREATE that state through its own
 * remedy. A draft stale by exactly a whole number of weeks shifted to "today",
 * which is in the future only until that evening's face-off — so a manager
 * clicking the fix at 20:00 moved their first game to 19:00 that same evening,
 * watched the warning disappear, and published into the lock they were trying
 * to avoid. Hence `weeks` starts at 1 and climbs until the shifted first game
 * is genuinely ahead of `now`.
 *
 * ⚠️ So this module answers a question; it does not refuse anything. The publish
 * stays possible — a manager whose games really were played on Tuesday and who
 * is publishing on Thursday before entering the scores needs it to be — and
 * what the callers do with the answer is warn, and offer the shift below.
 *
 * Pure, and `now` is injected rather than read from the clock so every boundary
 * here is testable.
 */

const DAY_MS = 86_400_000;

/**
 * A plain "YYYY-MM-DD" date, `weeks` whole weeks later.
 *
 * ⛔ UTC ARITHMETIC, and it has to be. The whole point of moving by weeks is
 * that every night keeps its weekday and its ice times, and a local-midnight
 * `Date` plus 7×86 400 000 ms lands on the previous day across a DST boundary —
 * which would silently move a Tuesday schedule onto Mondays for the rest of the
 * season. Same reasoning, and the same shape, as `enumerateNights` in
 * `./capacity`.
 */
export function shiftDateByWeeks(date: string, weeks: number): string {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d) + weeks * 7 * DAY_MS)
    .toISOString()
    .slice(0, 10);
}

/**
 * The instant a game at league wall-clock `time` on `date` actually starts.
 *
 * ⚠️ WALL CLOCK, NOT AN OFFSET CARRIED FORWARD, because that is how the move
 * itself behaves (`moveNightTo`): 19:00 stays 19:00 on the new date, whichever
 * side of a DST boundary it falls. Asking "is the shifted game in the future?"
 * with the OLD date's offset answers a question about a game that will not
 * exist.
 */
const instantOf = (date: string, time: string): number =>
  Date.parse(`${date}T${time}:00${leagueOffset(date)}`);

export type StaleDraft = {
  /** The league-zone date of the draft's earliest game — the night that passed. */
  firstNight: string;
  /** How many of the draft's nights have already begun. */
  passedNights: number;
  /** Whole weeks the draft must move for that game to be ahead of us again. */
  weeks: number;
  /** Where that first night lands after the shift. */
  shiftedFirstNight: string;
};

/**
 * Has this draft's first game already started, and by how many whole weeks must
 * the schedule move to be publishable again?
 *
 * `null` means there is nothing to warn about: the first game is still ahead,
 * or the draft has no dated games at all.
 *
 * ⚠️ WHOLE WEEKS, NOT DAYS, and the difference is the feature. A draft is a
 * whole schedule of matchups placed on particular weeknights at particular ice
 * times; moving it by an arbitrary number of days would put a Tuesday league on
 * a Thursday and every game on ice the league has not booked. Moving by weeks
 * keeps the weekdays, the slot order and the gaps between nights exactly as the
 * manager reviewed them.
 *
 * ⚠️ The smallest such shift, so a draft two days stale moves one week rather
 * than to some tidier-looking date — but never a shift that lands on a game
 * that has itself already started. See the note on the module above; that was a
 * real hole, not a hypothetical one.
 */
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

  // One pass: the earliest game overall, and the earliest on each night — the
  // second is what makes "how many nights are behind us" a question about
  // face-offs rather than about dates.
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
  // The first game's wall-clock time, which the shift preserves.
  const faceOff = leagueTimeKey(firstIso);

  // ⚠️ FROM 1, AND CLIMBING UNTIL THE SHIFTED GAME IS ACTUALLY AHEAD OF US.
  // `Math.ceil(daysBehind / 7)` is the same number nine times out of ten and
  // wrong in exactly the case that matters: it lands the game on today's date
  // at a time that may already have gone. A NaN instant compares false and ends
  // the loop rather than spinning.
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
