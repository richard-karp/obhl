import { describe, it, expect } from "vitest";
import { leagueWeekday } from "./format";

// 0 = Sunday, matching Date#getDay and the day_of_week column.
const MON = 1;
const SUN = 0;

describe("leagueWeekday", () => {
  it("reads the weekday in the league zone, not UTC", () => {
    // 8pm EDT on Monday 14 Sep is already Tuesday in UTC. The goalie defaults
    // for that game belong to Monday.
    expect(leagueWeekday("2026-09-15T00:00:00Z")).toBe(MON);
  });

  it("holds across the EST/EDT boundary", () => {
    // 8pm EST on Monday 12 Jan is 01:00 UTC on the Tuesday.
    expect(leagueWeekday("2026-01-13T01:00:00Z")).toBe(MON);
  });

  it("reads a late Sunday game as Sunday", () => {
    // 11:30pm EDT Sunday 13 Sep — 03:30 UTC Monday.
    expect(leagueWeekday("2026-09-14T03:30:00Z")).toBe(SUN);
  });

  it("returns -1 for an undated game", () => {
    // -1 matches no day_of_week row, so an undated game gets no defaults.
    expect(leagueWeekday(null)).toBe(-1);
  });
});
