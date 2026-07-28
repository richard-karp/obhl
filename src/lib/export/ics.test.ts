import { describe, it, expect } from "vitest";
import { buildIcs, type IcsGame } from "./ics";

// These pin the behaviour that already shipped, so the module can be moved and
// filtered without silently changing what subscribers' calendars receive.

const g = (over: Partial<IcsGame> = {}): IcsGame => ({
  id: "abc",
  scheduled_at: "2026-09-14T23:00:00Z",
  status: "scheduled",
  home: "Anchors",
  away: "Tide",
  ...over,
});

/** The SUMMARY lines, unfolded enough for a single short title. */
function summaries(ics: string): string[] {
  return ics
    .split("\r\n")
    .filter((l) => l.startsWith("SUMMARY:"))
    .map((l) => l.slice("SUMMARY:".length));
}

describe("buildIcs", () => {
  it("titles a scheduled game away-at-home", () => {
    expect(summaries(buildIcs([g()], "OBHL"))).toEqual(["Tide @ Anchors"]);
  });

  it("titles a final game with its score", () => {
    const ics = buildIcs(
      [g({ status: "final", home_goals: 2, away_goals: 3 })],
      "OBHL",
    );
    expect(summaries(ics)).toEqual(["Tide 3–2 Anchors (Final)"]);
  });

  it("treats missing goals on a final as nil-nil", () => {
    expect(summaries(buildIcs([g({ status: "final" })], "OBHL"))).toEqual([
      "Tide 0–0 Anchors (Final)",
    ]);
  });

  it("drops an undated game, having no way to place it", () => {
    const ics = buildIcs([g({ scheduled_at: null })], "OBHL");
    expect(ics).not.toContain("BEGIN:VEVENT");
  });

  it("gives each game a stable UID so an update replaces the event", () => {
    const ics = buildIcs([g({ id: "xyz" })], "OBHL");
    expect(ics).toContain("UID:game-xyz@obhl");
  });

  it("runs an event for ninety minutes", () => {
    expect(buildIcs([g()], "OBHL")).toContain("DURATION:PT1H30M");
  });

  it("emits the start in UTC", () => {
    expect(buildIcs([g()], "OBHL")).toContain("DTSTART:20260914T230000Z");
  });

  it("carries the calendar name through", () => {
    expect(buildIcs([g()], "OBHL Team Schedule")).toContain(
      "OBHL Team Schedule",
    );
  });

  it("still returns a parseable calendar when there is nothing to show", () => {
    // Withholding statuses can empty a feed that previously always had events,
    // so a subscriber polling an all-cancelled season must not get garbage.
    const ics = buildIcs([], "OBHL");
    expect(ics).toContain("BEGIN:VCALENDAR");
    expect(ics).toContain("END:VCALENDAR");
    expect(ics).not.toContain("BEGIN:VEVENT");
  });
});
