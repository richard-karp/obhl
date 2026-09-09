import { describe, it, expect } from "vitest";
import { staleDraft, shiftDateByWeeks } from "./staleDraft";

/**
 * The other half of `isPastGameNight`, and the half that was missing.
 *
 * `isPastGameNight` refuses a past first night at GENERATE, which is the right
 * place for a manager who types one in. It cannot see the case this module is
 * for: a draft generated against a perfectly good future date, left standing,
 * and published after that date has passed. The window is however long the
 * manager waits, and the rebuild workflow — generate early in the week, publish
 * later — walks straight through it.
 *
 * ⛔ EVERY BOUNDARY HERE IS AN INSTANT, NOT A DATE. The lock this guards
 * (`season_is_started`) fires on `scheduled_at < now()`, so a test suite that
 * only ever compares whole days would pass over the several hours each game
 * night spends already-played and still today — which is exactly the hole an
 * earlier revision of this module left open. `now` is injected for that reason.
 */
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
    // The counterpart to `isPastGameNight` allowing today: at 10am, tonight's
    // 19:00 face-off is a perfectly good first night.
    expect(
      staleDraft({
        games: [at("2026-09-07T19:00:00-04:00")],
        now: "2026-09-07T10:00:00-04:00",
      }),
    ).toBeNull();
  });

  it("is stale once tonight's game has actually started", () => {
    // ⛔ THE CASE A DAY-GRANULAR CHECK MISSES ENTIRELY. Publishing here trips
    // `season_is_started` on the spot, and the manager gets no warning at all
    // unless this returns non-null.
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
    // ⛔ THE REGRESSION THIS MODULE EXISTS TO NOT REPEAT. A draft stale by
    // exactly one week, looked at after that evening's face-off: shifting it to
    // "today" moves the first game to an hour ago, the warning disappears, and
    // the very next click locks the season. The remedy would have created the
    // state it exists to prevent. Two weeks is the smallest honest answer.
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
    // The same draft, seen in the morning: today's 19:00 is genuinely ahead, so
    // moving one week costs the manager nothing and starts the season tonight.
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
        // Tonight: the 19:00 has gone, the 20:15 has not. One night, and it
        // counts — the schedule is under way whatever happens next.
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
    // 2026-10-27 is a Tuesday; US Eastern leaves DST on 2026-11-01, so the
    // shifted night is a -05:00 evening where the original was -04:00. The date
    // arithmetic is UTC and the wall clock is preserved, so it stays a Tuesday.
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
    // A row with a malformed date is not this function's to interpret, and must
    // not become an `Invalid Date` that silently reads as the epoch — which
    // would call every draft in the app stale.
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
    // 2026-10-27 is a Tuesday; US Eastern leaves DST on 2026-11-01. UTC
    // arithmetic is what keeps the shifted date on a Tuesday — adding
    // 7×86 400 000 ms to a local-midnight Date would land on the Monday.
    expect(shiftDateByWeeks("2026-10-27", 1)).toBe("2026-11-03");
  });
});
