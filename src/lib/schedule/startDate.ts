/**
 * Is a proposed first game night already in the past?
 *
 * ⛔ The reason this exists: `season_is_started` (`0026`) counts only
 * `not is_draft`, so a past-dated DRAFT is invisible to the lock and looks
 * completely fine. Publishing it locks the season INSTANTLY AND FOR GOOD —
 * generate, replace and remove all refuse from then on. There is no undo.
 *
 * ⚠️ Guard the GENERATE, not the publish. Refusing at publish is the obvious
 * place and is worse: by then the manager has a draft they have reviewed and
 * can do nothing with, and the message arrives too late to act on cheaply.
 *
 * ⚠️ Named arguments on purpose. Both are plain "YYYY-MM-DD" calendar dates, compared as whole
 * dates — that ordering is exactly lexicographic, so no Date parsing (and no
 * timezone) is involved here — and positionally they would be swappable,
 * which would INVERT the guard: every future date refused, every past one let
 * through, and nothing about the call site looking wrong.
 *
 * `today` is the CALLER's job to supply in the
 * league's zone: server-UTC is up to five hours ahead of it, which would refuse
 * a same-day generate every evening after 7pm.
 *
 * Today itself passes. A season is allowed to start the night it is generated,
 * and refusing that would be a guard that costs the manager a real option.
 */
export function isPastGameNight({
  startDate,
  today,
}: {
  startDate: string;
  today: string;
}): boolean {
  // Anything that is not a calendar date is not this function's to refuse:
  // an empty field already has its own message upstream ("Pick a first game
  // night."), and inventing a second, wronger one for it would be a
  // regression in the error rather than a guard.
  if (!/^\d{4}-\d{2}-\d{2}$/.test(startDate)) return false;
  return startDate < today;
}
