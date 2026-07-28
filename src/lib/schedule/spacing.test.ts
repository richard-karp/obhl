import { describe, it, expect } from "vitest";
import { spacingReport, type PlacedGame } from "./spacing";
import type { Night } from "./assignNights";

// Two weekly nights (Tue+Thu) for `weeks` weeks.
function nights(weeks: number, slots = ["19:00", "20:15"]): Night[] {
  const ns: Night[] = [];
  const base = Date.UTC(2026, 8, 1); // 2026-09-01 is a Tuesday
  for (let w = 0; w < weeks; w++) {
    for (const off of [0, 2]) {
      const d = new Date(base + (w * 7 + off) * 86400000);
      ns.push({ date: d.toISOString().slice(0, 10), slots });
    }
  }
  return ns;
}

const g = (
  home: string,
  away: string,
  nightIndex: number,
  slotIndex: number,
): PlacedGame => ({ home, away, nightIndex, slotIndex });

describe("spacingReport", () => {
  it("counts a team byeing two nights in the same week", () => {
    // Week 0 = nights 0 (Tue) & 1 (Thu). Team X plays neither → 2 byes that week.
    const ns = nights(2);
    const games = [
      g("A", "B", 0, 0),
      g("C", "D", 1, 0),
      g("A", "X", 2, 0), // X plays in week 1
    ];
    const r = spacingReport(games, ns, ["A", "B", "C", "D", "X"]);
    expect(r.byesMultiWeek).toBeGreaterThanOrEqual(1); // X missed both nights in week 0
  });

  it("counts rematches in the same week and adjacent nights", () => {
    const ns = nights(2);
    const games = [
      g("A", "B", 0, 0), // week 0, Tue
      g("A", "B", 1, 0), // week 0, Thu — same week AND adjacent night
    ];
    const r = spacingReport(games, ns, ["A", "B"]);
    expect(r.rematchSameWeek).toBe(1);
    expect(r.rematchAdjNight).toBe(1);
  });

  it("counts consecutive-week same-weekday rematches", () => {
    const ns = nights(2);
    const games = [
      g("A", "B", 0, 0), // week 0 Tue
      g("A", "B", 2, 0), // week 1 Tue — consecutive week, same weekday
    ];
    const r = spacingReport(games, ns, ["A", "B"]);
    expect(r.rematchConsecWeek).toBe(1);
    expect(r.rematchConsecWeekSameDay).toBe(1);
  });

  it("counts a team's consecutive same-slot games", () => {
    const ns = nights(2);
    const games = [
      g("A", "B", 0, 1), // A in slot 1
      g("A", "C", 2, 1), // A in slot 1 again (next game) → consecutive
    ];
    const r = spacingReport(games, ns, ["A", "B", "C"]);
    expect(r.slotConsecutive).toBe(1);
  });

  it("is all zeros for a cleanly spaced schedule", () => {
    const ns = nights(3);
    const games = [
      g("A", "B", 0, 0),
      g("A", "C", 3, 1), // different week, different slot
    ];
    const r = spacingReport(games, ns, ["A", "B", "C"]);
    expect(r.rematchSameWeek).toBe(0);
    expect(r.rematchAdjNight).toBe(0);
    expect(r.slotConsecutive).toBe(0);
  });
});
