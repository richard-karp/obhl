import { describe, it, expect } from "vitest";
import { isPastGameNight } from "./startDate";

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
    expect(isPastGameNight({ startDate: "", today: "2026-09-05" })).toBe(false);
  });
});
