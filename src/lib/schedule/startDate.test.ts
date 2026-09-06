import { describe, it, expect } from "vitest";
import { isPastGameNight } from "./startDate";

/**
 * The guard behind the one irreversible mistake the schedule builder offers.
 *
 * `season_is_started` counts only published games, so a past-dated DRAFT looks
 * completely fine — until it is published, at which point generate, replace and
 * remove all refuse permanently. Refusing the date at GENERATE is what keeps
 * that from ever reaching the publish button.
 *
 * `today` is injected rather than read from the clock so these stay honest; the
 * caller passes the league-zone date, not the server's.
 */
describe("isPastGameNight", () => {
  it("rejects a first game night before today", () => {
    expect(
      isPastGameNight({ startDate: "2026-09-04", today: "2026-09-05" }),
    ).toBe(true);
  });

  it("allows today — a season may start the night it is generated", () => {
    expect(
      isPastGameNight({ startDate: "2026-09-05", today: "2026-09-05" }),
    ).toBe(false);
  });

  it("allows a future first game night", () => {
    expect(
      isPastGameNight({ startDate: "2026-09-10", today: "2026-09-05" }),
    ).toBe(false);
  });

  it("compares whole dates, not day-of-month", () => {
    // A naive day/month comparison would call this future-dated.
    expect(
      isPastGameNight({ startDate: "2025-12-31", today: "2026-01-01" }),
    ).toBe(true);
  });

  it("does not refuse a date it cannot read", () => {
    // Emptiness is already answered by "Pick a first game night." upstream;
    // this must not invent a second, wronger message for it.
    expect(isPastGameNight({ startDate: "", today: "2026-09-05" })).toBe(false);
  });
});
