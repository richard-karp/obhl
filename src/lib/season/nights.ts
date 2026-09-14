/**
 * ⛔ Weekdays (0=Sun, like `leagueWeekday()`), not `getSeasonNights`' dated nights. Declared by
 * `generateSchedule` from the manager's checkboxes, never derived from games, which can move.
 */
export const NIGHT_LABEL = [
  "Sun",
  "Mon",
  "Tue",
  "Wed",
  "Thu",
  "Fri",
  "Sat",
] as const;

export const NIGHT_LONG = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
] as const;

const sortedUnique = (ns: number[]): number[] =>
  [...new Set(ns)].sort((a, b) => a - b);

/**
 * `publishedWeekdays` is consulted only when nothing is stored. ⛔ That is not rare: a season is
 * created with `game_nights` empty until generated, and `seasonNightsFor` pays for the query then.
 */
export function resolveSeasonNights(
  stored: number[] | null | undefined,
  publishedWeekdays: number[],
): number[] {
  const declared = stored ?? [];
  return sortedUnique(declared.length > 0 ? declared : publishedWeekdays);
}

/** ⛔ Exactly one is false: a select with one option can only restate what the season says. */
export function hasMultipleNights(nights: number[]): boolean {
  return nights.length > 1;
}
