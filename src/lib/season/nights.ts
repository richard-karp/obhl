/**
 * The nights of the week a season plays.
 *
 * ⛔ NOT `getSeasonNights`. `lib/queries/schedule.ts` already exports that, and
 * it means something else: the season's actual game NIGHTS, grouped by date,
 * with their games and their locks. This module is about weekdays — "the league
 * plays Mondays and Thursdays" — and nothing here touches the database.
 *
 * ⚠️ WHY THE VALUE IS DECLARED RATHER THAN DERIVED. It is written by
 * `generateSchedule` from the weekday checkboxes the manager ticks, because
 * that is where the league states which ice it has booked. Deriving it from the
 * games instead would make it change under a manager's feet: reschedule one
 * game onto a Saturday and the league would appear to play Saturdays.
 */

/** 0=Sun … 6=Sat, matching `leagueWeekday()` and `team_players.night_of_week`. */
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
 * @param stored `seasons.game_nights` — what the schedule was built with.
 * @param publishedWeekdays The weekdays this season's PUBLISHED games fall on,
 *   in the league's zone. Only consulted when nothing was stored.
 *
 * ⚠️ THE FALLBACK IS FOR SEASONS NOBODY BUILT HERE. The esportsdesk importer
 * writes games without ever running the generator, so those seasons would
 * otherwise have no nights for good. Every season that existed when the column
 * landed was backfilled by `0049` from exactly this computation, so in practice
 * the fallback runs almost never — which is why its caller
 * (`seasonNightsFor`) only pays for the query when `stored` is empty.
 */
export function resolveSeasonNights(
  stored: number[] | null | undefined,
  publishedWeekdays: number[],
): number[] {
  const declared = stored ?? [];
  return sortedUnique(declared.length > 0 ? declared : publishedWeekdays);
}

/**
 * Whether to offer night controls at all.
 *
 * ⛔ EXACTLY ONE IS FALSE. A league that plays a single night has nothing to
 * choose between, and a select with one option is a control that can only
 * restate what the whole season already says. The maintainer's rule is "when a
 * league has more than one night" — this is that sentence.
 */
export function hasMultipleNights(nights: number[]): boolean {
  return nights.length > 1;
}
