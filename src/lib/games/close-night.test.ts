import { describe, it, expect } from "vitest";
import { nightWindow } from "./close-night";

/**
 * The window the nightly sweep finalizes games in.
 *
 * ⛔ THE LOWER BOUND IS THE WHOLE POINT, and it is the fix for the worst bug this
 * route has had. Without it the query selected every `in_progress` game ever —
 * and `reopenGameById` puts a PAST-dated game back into that state, from the
 * scoresheet's Reopen button and from `audit.ts`'s revert of a wrong
 * `finalize_game`. The sweep re-finalized anything a manager had just corrected,
 * so the app's only undo survived less than a day.
 */
describe("nightWindow", () => {
  // 2am EDT on 11 Sep — the sweep's own slot, a few hours after the night ended.
  const AT_2AM_EDT = new Date("2026-09-11T06:00:00Z");

  it("covers the night that just ended, and only that night", () => {
    const w = nightWindow(AT_2AM_EDT);
    // Midnight-to-midnight in the league zone, as UTC instants.
    expect(w.from).toBe("2026-09-10T04:00:00.000Z");
    expect(w.to).toBe("2026-09-11T04:00:00.000Z");
  });

  it("excludes the night before last", () => {
    // A game from two nights ago sits below `from`, so a manager's reopen of an
    // older game is never swept back up.
    const w = nightWindow(AT_2AM_EDT);
    expect(Date.parse("2026-09-09T23:40:00Z")).toBeLessThan(Date.parse(w.from));
  });

  it("excludes tonight, which has not happened yet", () => {
    const w = nightWindow(AT_2AM_EDT);
    // Tonight's 7pm game — after the window closes.
    expect(Date.parse("2026-09-11T23:00:00Z")).toBeGreaterThanOrEqual(
      Date.parse(w.to),
    );
  });

  it("still covers the night when the cron fires late", () => {
    // ⚠️ Hobby cron precision is per-hour: `0 6 * * *` fires anywhere in
    // 06:00-06:59 UTC. The drift is forward, so the window must not move with it.
    const early = nightWindow(new Date("2026-09-11T06:00:00Z"));
    const late = nightWindow(new Date("2026-09-11T06:59:00Z"));
    expect(late).toEqual(early);
  });

  it("is 25 hours long across the fall-back boundary", () => {
    // The night of 1 Nov 2026 gains an hour. A window built from a single offset
    // would clip it, and the 9:40pm game sits in the clipped hour.
    const w = nightWindow(new Date("2026-11-02T07:00:00Z"));
    expect(w.from).toBe("2026-11-01T04:00:00.000Z");
    expect(w.to).toBe("2026-11-02T05:00:00.000Z");
    expect(Date.parse(w.to) - Date.parse(w.from)).toBe(25 * 60 * 60 * 1000);
  });

  it("is 23 hours long across the spring-forward boundary", () => {
    const w = nightWindow(new Date("2026-03-09T06:00:00Z"));
    expect(Date.parse(w.to) - Date.parse(w.from)).toBe(23 * 60 * 60 * 1000);
  });

  it("crosses a month boundary", () => {
    // 2am EDT on 1 Oct — the night that ended is 30 Sep.
    const w = nightWindow(new Date("2026-10-01T06:00:00Z"));
    expect(w.from).toBe("2026-09-30T04:00:00.000Z");
    expect(w.to).toBe("2026-10-01T04:00:00.000Z");
  });

  it("crosses a year boundary", () => {
    // 2am EST on 1 Jan — the night that ended is 31 Dec.
    const w = nightWindow(new Date("2027-01-01T07:00:00Z"));
    expect(w.from).toBe("2026-12-31T05:00:00.000Z");
    expect(w.to).toBe("2027-01-01T05:00:00.000Z");
  });
});
