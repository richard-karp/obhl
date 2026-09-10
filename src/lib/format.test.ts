import { describe, it, expect } from "vitest";
import {
  hasStartedWithin,
  isOnLeagueDate,
  leagueDayStart,
  leagueToday,
  leagueWeekday,
  weekdayOf,
} from "./format";

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

  it("returns -1 rather than raising on an unparseable timestamp", () => {
    // Unreachable from a timestamptz column, but this runs on the live scoring
    // page: losing the goalie defaults beats losing the page mid-game.
    expect(leagueWeekday("not a date")).toBe(-1);
  });
});

describe("weekdayOf", () => {
  // Moved here from schedule/assignNights so there's one weekday-from-date
  // implementation. It reads a plain calendar date, with no timezone involved.
  it("reads the weekday of a calendar date", () => {
    expect(weekdayOf("2026-09-14")).toBe(1); // Monday
    expect(weekdayOf("2026-09-13")).toBe(0); // Sunday
    expect(weekdayOf("2026-09-19")).toBe(6); // Saturday
  });

  it("ignores anything after the date", () => {
    expect(weekdayOf("2026-09-14T23:59:00Z")).toBe(1);
  });
});

describe("leagueToday", () => {
  // `now` is a parameter rather than a clock read so these stay pure — nothing
  // in this repo uses fake timers, and the page passes the value down anyway.
  it("reads the league-zone date, not the UTC one", () => {
    // 9:40pm EDT on Monday 14 Sep is already Tuesday 15th in UTC. The
    // scorekeeper's night is still the 14th.
    expect(leagueToday(new Date("2026-09-15T01:40:00Z"))).toBe("2026-09-14");
  });

  it("holds across the EST/EDT boundary", () => {
    // 9:40pm EST on 12 Jan is 02:40 UTC on the 13th.
    expect(leagueToday(new Date("2026-01-13T02:40:00Z"))).toBe("2026-01-12");
  });
});

describe("isOnLeagueDate", () => {
  const NIGHT = "2026-09-14";

  it("matches a late game that has already rolled over in UTC", () => {
    // The whole point: the last slot of the night is 9:40pm Eastern, which is
    // the next day in UTC. Comparing UTC dates would drop it off its own night.
    expect(isOnLeagueDate("2026-09-15T01:40:00Z", NIGHT)).toBe(true);
  });

  it("matches the first slot of the night", () => {
    expect(isOnLeagueDate("2026-09-14T23:00:00Z", NIGHT)).toBe(true);
  });

  it("rejects the night before", () => {
    expect(isOnLeagueDate("2026-09-13T23:00:00Z", NIGHT)).toBe(false);
  });

  it("rejects the night after", () => {
    expect(isOnLeagueDate("2026-09-15T23:00:00Z", NIGHT)).toBe(false);
  });

  it("rejects an undated game", () => {
    // `scheduled_at` is nullable, and postponing sets it to null (0025). An
    // undated game is never today.
    expect(isOnLeagueDate(null, NIGHT)).toBe(false);
  });

  it("rejects rather than raising on an unparseable timestamp", () => {
    // Same reasoning as leagueWeekday: this runs on the scoring path, where
    // refusing one game beats losing the page.
    expect(isOnLeagueDate("not a date", NIGHT)).toBe(false);
  });
});

describe("leagueDayStart", () => {
  it("is midnight in the league zone, as a UTC instant", () => {
    // Midnight EDT is 04:00Z.
    expect(leagueDayStart("2026-09-14")).toBe("2026-09-14T04:00:00.000Z");
  });

  it("is midnight EST in winter", () => {
    expect(leagueDayStart("2026-01-12")).toBe("2026-01-12T05:00:00.000Z");
  });

  it("uses the offset at MIDNIGHT on a fall-back day, not at noon", () => {
    // ⛔ 1 Nov 2026 switches EDT->EST at 2am local, so midnight is still EDT
    // (04:00Z) even though noon that day is EST. `leagueOffset` samples noon and
    // would put this hour late, clipping 00:00-01:00 off the night.
    expect(leagueDayStart("2026-11-01")).toBe("2026-11-01T04:00:00.000Z");
  });

  it("is midnight EST the day after the switch", () => {
    expect(leagueDayStart("2026-11-02")).toBe("2026-11-02T05:00:00.000Z");
  });

  it("uses the offset at midnight on a spring-forward day", () => {
    // 8 Mar 2026 switches EST->EDT at 2am, so midnight is still EST (05:00Z).
    expect(leagueDayStart("2026-03-08")).toBe("2026-03-08T05:00:00.000Z");
  });
});

describe("hasStartedWithin", () => {
  // 9:40pm EDT on Mon 14 Sep — the last slot of a night.
  const LAST_SLOT = "2026-09-15T01:40:00Z";

  it("keeps a game open past local midnight", () => {
    // 00:30 local, half an hour after the day rolled over. The scorekeeper is
    // still entering the game they started before midnight; the day rule alone
    // would have shut them out.
    const at = new Date("2026-09-15T04:30:00Z");
    expect(hasStartedWithin(LAST_SLOT, 6, at)).toBe(true);
  });

  it("is still open two hours after puck drop", () => {
    expect(
      hasStartedWithin(LAST_SLOT, 6, new Date("2026-09-15T03:40:00Z")),
    ).toBe(true);
  });

  it("closes once the window has passed", () => {
    // 6h01m after start — deep enough into the night that nobody is scoring.
    expect(
      hasStartedWithin(LAST_SLOT, 6, new Date("2026-09-15T07:41:00Z")),
    ).toBe(false);
  });

  it("does not open a game that has not started yet", () => {
    // ⛔ A TAIL, NOT A WINDOW. Tonight's later games are reachable because they
    // are TODAY, not because of this — so this must never reach forward, or a
    // game could be opened before its night.
    expect(
      hasStartedWithin(LAST_SLOT, 6, new Date("2026-09-15T00:00:00Z")),
    ).toBe(false);
  });

  it("never opens an undated game", () => {
    expect(hasStartedWithin(null, 6, new Date("2026-09-15T04:30:00Z"))).toBe(
      false,
    );
  });

  it("never opens an unparseable one", () => {
    expect(hasStartedWithin("not a date", 6, new Date())).toBe(false);
  });
});
