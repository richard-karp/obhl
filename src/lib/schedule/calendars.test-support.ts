/**
 * The calendars the schedule tests build over and over, named by shape.
 * Imported by tests only; `vitest.config.ts` collects `*.test.ts`, not this.
 */
import type { Night } from "./assignNights";
import { enumerateNights } from "./capacity";

const THREE_SHEETS = ["19:00", "20:15", "21:30"];

/** Tuesday and Thursday for `weeks` weeks from Tue 2026-09-01, in order. */
export function twoNightsPerWeek(
  weeks: number,
  slots: string[] = THREE_SHEETS,
): Night[] {
  const ns: Night[] = [];
  const base = Date.UTC(2026, 8, 1);
  for (let w = 0; w < weeks; w++) {
    for (const off of [0, 2]) {
      const d = new Date(base + (w * 7 + off) * 86400000);
      ns.push({ date: d.toISOString().slice(0, 10), slots });
    }
  }
  return ns;
}

/** One Tuesday a week from 2026-09-08 on three sheets: six teams all play every week. */
export function sixTeamTuesdays(maxNights: number): Night[] {
  return enumerateNights("2026-09-08", {
    weekdays: new Set([2]),
    slotTimes: THREE_SHEETS,
    excluded: new Set<string>(),
    maxNights,
  });
}

/** Monday and Thursday from 2026-09-10 on three sheets: eight teams, two byes a night. */
export function eightTeamMonThu(
  maxNights: number,
  excluded: string[] = [],
): Night[] {
  return enumerateNights("2026-09-10", {
    weekdays: new Set([1, 4]),
    slotTimes: THREE_SHEETS,
    excluded: new Set(excluded),
    maxNights,
  });
}
