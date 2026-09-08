import { describe, it, expect } from "vitest";
import { staleDraft, shiftDateByWeeks } from "./staleDraft";

/**
 * The other half of `isPastGameNight`, and the half that was missing.
 *
 * `isPastGameNight` refuses a past date at GENERATE, which is the right place
 * for a manager who types one in. It cannot see the case this module is for: a
 * draft generated against a perfectly good future date, left standing, and
 * published after that date has passed. The window is however long the manager
 * waits, and the rebuild workflow — generate early in the week, publish later —
 * walks straight through it.
 *
 * `today` is injected rather than read from the clock, and every date here is a
 * plain league-zone calendar key.
 */
describe("staleDraft", () => {
  it("returns null when the first night is still ahead", () => {
    expect(
      staleDraft({ nights: ["2026-09-15", "2026-09-22"], today: "2026-09-07" }),
    ).toBeNull();
  });

  it("returns null when the first night is today — a season may start tonight", () => {
    // The same boundary `isPastGameNight` draws, and drawn the same way: a
    // draft whose first night is tonight is publishable, not stale.
    expect(
      staleDraft({ nights: ["2026-09-07", "2026-09-14"], today: "2026-09-07" }),
    ).toBeNull();
  });

  it("returns null for a draft with no dated nights", () => {
    expect(staleDraft({ nights: [], today: "2026-09-07" })).toBeNull();
  });

  it("moves a draft one week when its first night was days ago", () => {
    expect(
      staleDraft({
        nights: ["2026-09-01", "2026-09-08", "2026-09-15"],
        today: "2026-09-07",
      }),
    ).toEqual({
      firstNight: "2026-09-01",
      passedNights: 1,
      weeks: 1,
      shiftedFirstNight: "2026-09-08",
    });
  });

  it("counts every night already behind us, not just the first", () => {
    const stale = staleDraft({
      nights: ["2026-09-01", "2026-09-03", "2026-09-08", "2026-09-10"],
      today: "2026-09-07",
    });
    expect(stale?.passedNights).toBe(2);
  });

  it("moves whole weeks, so the shifted first night keeps its weekday", () => {
    // 2026-08-04 is a Tuesday, four weeks and change behind 2026-09-07.
    const stale = staleDraft({ nights: ["2026-08-04"], today: "2026-09-07" });
    expect(stale?.weeks).toBe(5);
    expect(stale?.shiftedFirstNight).toBe("2026-09-08");
    expect(new Date("2026-09-08T12:00:00Z").getUTCDay()).toBe(
      new Date("2026-08-04T12:00:00Z").getUTCDay(),
    );
  });

  it("shifts to today itself when today is exactly a whole week on", () => {
    // ⛔ The boundary that decides whether the fix actually fixes anything: a
    // shift landing ON today is allowed, exactly as `isPastGameNight` allows a
    // draft generated for tonight. Rounding this up to the following week would
    // move a schedule that did not need moving and cost the manager a night.
    expect(staleDraft({ nights: ["2026-08-31"], today: "2026-09-07" })).toEqual(
      {
        firstNight: "2026-08-31",
        passedNights: 1,
        weeks: 1,
        shiftedFirstNight: "2026-09-07",
      },
    );
  });

  it("reads the earliest night, however the caller ordered the list", () => {
    const stale = staleDraft({
      nights: ["2026-09-08", "2026-09-01"],
      today: "2026-09-07",
    });
    expect(stale?.firstNight).toBe("2026-09-01");
  });

  it("crosses a year boundary by date, not by day-of-month", () => {
    const stale = staleDraft({ nights: ["2025-12-30"], today: "2026-01-06" });
    expect(stale).toEqual({
      firstNight: "2025-12-30",
      passedNights: 1,
      weeks: 1,
      shiftedFirstNight: "2026-01-06",
    });
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
