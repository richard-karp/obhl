/**
 * A draft that has AGED past its own first game night, and the shift that fixes
 * it.
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
 * ⚠️ So this module answers a question; it does not refuse anything. The publish
 * stays possible — a manager whose games really were played on Tuesday and who
 * is publishing on Thursday before entering the scores needs it to be — and
 * what the callers do with the answer is warn, and offer the shift below.
 *
 * Pure, and `today` is the CALLER's job to supply as a league-zone date key,
 * for the same reason `isPastGameNight` says so: server-UTC is up to five hours
 * ahead of the league, which would call a draft stale from 7pm the evening
 * before.
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

export type StaleDraft = {
  /** The draft's earliest game night, and the one that has passed. */
  firstNight: string;
  /** How many of the draft's nights are already behind us. */
  passedNights: number;
  /** Whole weeks the draft must move for its first night to be today or later. */
  weeks: number;
  /** Where that first night lands after the shift. */
  shiftedFirstNight: string;
};

/**
 * Is this draft's first game night behind us, and by how many whole weeks?
 *
 * `null` means there is nothing to warn about: the draft starts today or later,
 * or it has no dated nights at all.
 *
 * ⚠️ WHOLE WEEKS, NOT DAYS, and the difference is the feature. A draft is a
 * whole schedule of matchups placed on particular weeknights at particular ice
 * times; moving it by an arbitrary number of days would put a Tuesday league on
 * a Thursday and every game on ice the league has not booked. Moving by weeks
 * keeps the weekdays, the slot order and the gaps between nights exactly as the
 * manager reviewed them.
 *
 * ⚠️ The smallest such shift, so a draft two days stale moves one week rather
 * than to some tidier-looking date. Landing ON today is allowed, matching
 * `isPastGameNight`'s "a season may start the night it is generated": rounding
 * it up to the next week would move a schedule that did not need moving.
 */
export function staleDraft({
  nights,
  today,
}: {
  /** The draft's game nights as league-zone date keys, in any order. */
  nights: string[];
  today: string;
}): StaleDraft | null {
  if (nights.length === 0) return null;
  // Sorted here rather than trusted from the caller: the panel's list is
  // already ordered, the action's comes off a `Map` built while grouping, and
  // "the first night" being wrong would move the schedule by the wrong number
  // of weeks — a silent, whole-season error.
  const firstNight = [...nights].sort()[0];
  if (firstNight >= today) return null;

  const [fy, fm, fd] = firstNight.split("-").map(Number);
  const [ty, tm, td] = today.split("-").map(Number);
  const daysBehind =
    (Date.UTC(ty, tm - 1, td) - Date.UTC(fy, fm - 1, fd)) / DAY_MS;
  const weeks = Math.ceil(daysBehind / 7);

  return {
    firstNight,
    passedNights: nights.filter((n) => n < today).length,
    weeks,
    shiftedFirstNight: shiftDateByWeeks(firstNight, weeks),
  };
}
