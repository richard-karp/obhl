import { describe, it, expect } from "vitest";
import { staleDraft, shiftDateByWeeks } from "./staleDraft";

/** ⛔ Every boundary here is an instant, not a date: `season_is_started` fires on
 *  `scheduled_at < now()`, so day-only tests miss the hours a night is played but still today. */
describe("staleDraft", () => {
  const at = (iso: string) => iso; // readability at the call sites below

  it("returns null when the first game is still ahead", () => {
    expect(
      staleDraft({
        games: [at("2026-09-15T19:00:00-04:00")],
        now: "2026-09-07T20:00:00-04:00",
      }),
    ).toBeNull();
  });

  it("returns null for a game later tonight — a season may start this evening", () => {
    expect(
      staleDraft({
        games: [at("2026-09-07T19:00:00-04:00")],
        now: "2026-09-07T10:00:00-04:00",
      }),
    ).toBeNull();
  });

  it("is stale once tonight's game has actually started", () => {
    // ⛔ The case a day-granular check misses: publishing now trips `season_is_started`.
    expect(
      staleDraft({
        games: [at("2026-09-07T19:00:00-04:00")],
        now: "2026-09-07T20:00:00-04:00",
      }),
    ).toEqual({
      firstNight: "2026-09-07",
      passedNights: 1,
      weeks: 1,
      shiftedFirstNight: "2026-09-14",
    });
  });

  it("returns null for a draft with no dated games", () => {
    expect(
      staleDraft({ games: [], now: "2026-09-07T20:00:00-04:00" }),
    ).toBeNull();
  });

  it("moves a draft one week when its first night was days ago", () => {
    expect(
      staleDraft({
        games: [
          at("2026-09-01T19:00:00-04:00"),
          at("2026-09-08T19:00:00-04:00"),
          at("2026-09-15T19:00:00-04:00"),
        ],
        now: "2026-09-07T20:00:00-04:00",
      }),
    ).toEqual({
      firstNight: "2026-09-01",
      passedNights: 1,
      weeks: 1,
      shiftedFirstNight: "2026-09-08",
    });
  });

  it("never shifts onto a face-off that has already gone", () => {
    // ⛔ Stale by exactly a week, after that evening's face-off: shifting to "today" puts the
    // first game an hour ago and the next click locks the season. Two weeks is the honest answer.
    expect(
      staleDraft({
        games: [at("2026-09-01T19:00:00-04:00")],
        now: "2026-09-08T20:00:00-04:00",
      }),
    ).toEqual({
      firstNight: "2026-09-01",
      passedNights: 1,
      weeks: 2,
      shiftedFirstNight: "2026-09-15",
    });
  });

  it("does shift onto today when the face-off is still to come", () => {
    expect(
      staleDraft({
        games: [at("2026-09-01T19:00:00-04:00")],
        now: "2026-09-08T10:00:00-04:00",
      }),
    ).toEqual({
      firstNight: "2026-09-01",
      passedNights: 1,
      weeks: 1,
      shiftedFirstNight: "2026-09-08",
    });
  });

  it("counts a night as passed once its first game has started, not at midnight", () => {
    const stale = staleDraft({
      games: [
        at("2026-09-01T19:00:00-04:00"),
        at("2026-09-01T20:15:00-04:00"),
        // Tonight's 19:00 has gone and its 20:15 hasn't: one night, and it counts.
        at("2026-09-07T19:00:00-04:00"),
        at("2026-09-07T20:15:00-04:00"),
        at("2026-09-14T19:00:00-04:00"),
      ],
      now: "2026-09-07T19:30:00-04:00",
    });
    expect(stale?.passedNights).toBe(2);
  });

  it("reads the earliest game, however the caller ordered the list", () => {
    const stale = staleDraft({
      games: [
        at("2026-09-08T19:00:00-04:00"),
        at("2026-09-01T20:15:00-04:00"),
        at("2026-09-01T19:00:00-04:00"),
      ],
      now: "2026-09-07T20:00:00-04:00",
    });
    expect(stale?.firstNight).toBe("2026-09-01");
    // The 19:00, not the 20:15 — the shift is anchored on the night's opener.
    expect(stale?.shiftedFirstNight).toBe("2026-09-08");
  });

  it("keeps the weekday when the shift crosses the end of DST", () => {
    // 2026-10-27 is a Tuesday; US Eastern leaves DST on 2026-11-01.
    const stale = staleDraft({
      games: [at("2026-10-27T19:00:00-04:00")],
      now: "2026-10-28T09:00:00-04:00",
    });
    expect(stale?.weeks).toBe(1);
    expect(stale?.shiftedFirstNight).toBe("2026-11-03");
  });

  it("crosses a year boundary by date, not by day-of-month", () => {
    expect(
      staleDraft({
        games: [at("2025-12-30T19:00:00-05:00")],
        now: "2026-01-05T20:00:00-05:00",
      }),
    ).toEqual({
      firstNight: "2025-12-30",
      passedNights: 1,
      weeks: 1,
      shiftedFirstNight: "2026-01-06",
    });
  });

  it("ignores a game whose timestamp cannot be read", () => {
    // A malformed timestamp must not read as the epoch, which would call every draft stale.
    expect(
      staleDraft({
        games: ["not a timestamp", at("2026-09-15T19:00:00-04:00")],
        now: "2026-09-07T20:00:00-04:00",
      }),
    ).toBeNull();
  });
});

describe("shiftDateByWeeks", () => {
  it("adds whole weeks", () => {
    expect(shiftDateByWeeks("2026-09-01", 1)).toBe("2026-09-08");
    expect(shiftDateByWeeks("2026-09-01", 3)).toBe("2026-09-22");
  });

  it("crosses month and year ends", () => {
    expect(shiftDateByWeeks("2026-12-29", 1)).toBe("2027-01-05");
    expect(shiftDateByWeeks("2026-02-25", 1)).toBe("2026-03-04");
  });

  it("keeps the weekday across a DST boundary", () => {
    // 2026-10-27 is a Tuesday; local-midnight millisecond arithmetic would land on the Monday.
    expect(shiftDateByWeeks("2026-10-27", 1)).toBe("2026-11-03");
  });
});
