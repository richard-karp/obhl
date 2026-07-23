import type { Night } from "./assignNights";

export type EnumerateNightsOptions = {
  /** Weekdays the league plays (0=Sun..6=Sat). */
  weekdays: Set<number>;
  /** Ice-time slots ("HH:MM") applied to every night. */
  slotTimes: string[];
  /** Dates to skip ("YYYY-MM-DD") — holidays / weeks off. */
  excluded?: Set<string>;
  /** Inclusive last date to consider. Omit to run until `maxNights`. */
  endDate?: string;
  /** Stop once this many nights have been collected. */
  maxNights?: number;
};

const DAY_MS = 86_400_000;
const HARD_GUARD_DAYS = 730; // ~2 years — never walk forever.

/**
 * Chronological list of game nights from `startDate` forward: every selected
 * weekday, minus excluded dates, until `endDate` (inclusive) and/or `maxNights`.
 * UTC arithmetic so DST never shifts a day. Factored from the old inline loop in
 * `generateSchedule`.
 */
export function enumerateNights(
  startDate: string,
  opts: EnumerateNightsOptions,
): Night[] {
  const { weekdays, slotTimes, excluded, endDate, maxNights } = opts;
  if (!startDate || weekdays.size === 0 || slotTimes.length === 0) return [];

  const [sy, sm, sd] = startDate.split("-").map(Number);
  const endU = endDate
    ? (() => {
        const [ey, em, ed] = endDate.split("-").map(Number);
        return Date.UTC(ey, em - 1, ed);
      })()
    : Infinity;

  const nights: Night[] = [];
  for (
    let cur = Date.UTC(sy, sm - 1, sd), guard = 0;
    cur <= endU && guard < HARD_GUARD_DAYS;
    cur += DAY_MS, guard++
  ) {
    if (maxNights != null && nights.length >= maxNights) break;
    const day = new Date(cur);
    const date = day.toISOString().slice(0, 10);
    if (weekdays.has(day.getUTCDay()) && !excluded?.has(date)) {
      nights.push({ date, slots: slotTimes });
    }
  }
  return nights;
}
