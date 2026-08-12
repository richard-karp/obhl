import { describe, it, expect } from "vitest";
import { spacingReport, proportionalSplit, type PlacedGame } from "./spacing";
import type { Night } from "./assignNights";

const TUE = Date.UTC(2026, 8, 1); // 2026-09-01 is a Tuesday
const day = (offsetFromTue: number) =>
  new Date(TUE + offsetFromTue * 86400000).toISOString().slice(0, 10);

/**
 * `weeks` calendar weeks of game nights, one per day-offset from Tue 2026-09-01
 * (0=Tue, 1=Wed, 2=Thu, 3=Fri). The cadence is a parameter because the metrics
 * below have to hold for any number of weekdays, not just the league's two.
 */
function cadence(weeks: number, offsets: number[], slots = ["19:00", "20:15"]): Night[] {
  const ns: Night[] = [];
  for (let w = 0; w < weeks; w++) {
    for (const off of offsets) ns.push({ date: day(w * 7 + off), slots });
  }
  return ns;
}

// Two weekly nights (Tue+Thu) for `weeks` weeks.
const nights = (weeks: number, slots = ["19:00", "20:15"]) =>
  cadence(weeks, [0, 2], slots);

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

describe("proportionalSplit", () => {
  it("splits evenly when every weekday has the same number of nights", () => {
    expect(proportionalSplit(6, [24, 24])).toEqual([3, 3]);
    expect(proportionalSplit(6, [10, 10, 10])).toEqual([2, 2, 2]);
  });

  it("breaks an unavoidable tie on weekday order, so it stays deterministic", () => {
    expect(proportionalSplit(5, [24, 24])).toEqual([3, 2]);
    expect(proportionalSplit(5, [24, 24])).toEqual(proportionalSplit(5, [24, 24]));
  });

  it("follows the night counts when weekdays are unequal, rather than evening up", () => {
    // 3 Tue nights to 1 Thu: three meetings belong 2-1, not 2-1 by rounding luck.
    expect(proportionalSplit(3, [3, 1])).toEqual([2, 1]);
    expect(proportionalSplit(9, [3, 1])).toEqual([7, 2]);
  });

  it("is the identity on a single-weekday cadence", () => {
    expect(proportionalSplit(5, [48])).toEqual([5]);
  });

  it("always distributes exactly the total it was given", () => {
    for (const total of [0, 1, 5, 17, 36]) {
      for (const per of [[24, 24], [3, 1], [10, 10, 10], [48], [7, 5, 3]]) {
        const out = proportionalSplit(total, per);
        expect(out.reduce((s, x) => s + x, 0)).toBe(total);
        expect(out.every((x) => x >= 0)).toBe(true);
      }
    }
  });
});

describe("spacingReport — byesAdjNight", () => {
  it("counts a bye on two game nights in a row", () => {
    const ns = nights(2); // 4 nights: Tue/Thu, Tue/Thu
    const games = [g("A", "B", 0, 0), g("A", "B", 3, 0)]; // A & B bye nights 1, 2
    const r = spacingReport(games, ns, ["A", "B"]);
    expect(r.byesAdjNight).toBe(2); // one for each of the two teams
  });

  it("fires across a holiday gap, where the week-based bye rules do not", () => {
    // Weeks 0 and 3, nothing between. A byes the second night of week 0 and the
    // first of week 3 — not consecutive *weeks*, so the three existing bye rules
    // all read clean, yet A goes 23 days without a game. This gap is the whole
    // reason the metric is stated in nights.
    const ns: Night[] = [
      { date: day(0), slots: ["19:00"] }, // Tue, week 0
      { date: day(2), slots: ["19:00"] }, // Thu, week 0
      { date: day(21), slots: ["19:00"] }, // Tue, week 3
      { date: day(23), slots: ["19:00"] }, // Thu, week 3
    ];
    const games = [g("A", "B", 0, 0), g("C", "D", 1, 0), g("C", "D", 2, 0), g("A", "B", 3, 0)];
    const r = spacingReport(games, ns, ["A", "B", "C", "D"]);
    expect(r.byesMultiWeek).toBe(0);
    expect(r.byesConsecWeek).toBe(0);
    expect(r.byesConsecWeekSameDay).toBe(0);
    expect(r.byesAdjNight).toBe(2); // A and B, byeing nights 1 and 2
    expect(r.longestLayoffDays).toBe(23); // A and B: Sep 1 → Sep 24
  });

  it("is zero when byes alternate with games", () => {
    const ns = nights(2);
    const games = [g("A", "B", 0, 0), g("A", "B", 2, 0)]; // A byes 1 and 3, not adjacent
    const r = spacingReport(games, ns, ["A", "B"]);
    expect(r.byesAdjNight).toBe(0);
  });
});

describe("spacingReport — pairingWeekdayExcess", () => {
  it("is zero when a matchup splits across weekdays in proportion to the nights", () => {
    const ns = nights(3); // 3 Tue + 3 Thu
    const games = [g("A", "B", 0, 0), g("A", "B", 3, 0)]; // one Tue, one Thu
    expect(spacingReport(games, ns, ["A", "B"]).pairingWeekdayExcess).toBe(0);
  });

  it("charges a matchup that piles onto one weekday", () => {
    const ns = nights(3); // 6 nights, 3 Tue + 3 Thu
    // Both meetings on a Tuesday. Target is 1-1; scaled by N² = 36:
    // (2·6−6)² + (0−6)² = 72 actual, (1·6−6)²·2 = 0 ideal → 72/36 = 2.
    const games = [g("A", "B", 0, 0), g("A", "B", 2, 0)];
    expect(spacingReport(games, ns, ["A", "B"]).pairingWeekdayExcess).toBe(2);
  });

  it("is identically zero on a single-weekday cadence", () => {
    const ns = cadence(6, [2]); // Thu only
    const games = [g("A", "B", 0, 0), g("A", "B", 2, 0), g("A", "B", 4, 0)];
    expect(spacingReport(games, ns, ["A", "B"]).pairingWeekdayExcess).toBe(0);
  });

  it("aims at the proportional split, not an even one, on unequal weekdays", () => {
    // 3 Tue nights to 1 Thu. Three meetings belong 2 Tue / 1 Thu — so a 1/2
    // split is *worse* than 3/0, which an even-split target would get backwards.
    const ns: Night[] = [
      { date: day(0), slots: ["19:00"] }, // Tue
      { date: day(2), slots: ["19:00"] }, // Thu
      { date: day(7), slots: ["19:00"] }, // Tue
      { date: day(14), slots: ["19:00"] }, // Tue
    ];
    const excess = (nightIdx: number[]) =>
      spacingReport(
        nightIdx.map((ni) => g("A", "B", ni, 0)),
        ns,
        ["A", "B"],
      ).pairingWeekdayExcess;

    expect(excess([0, 2, 1])).toBe(0); // 2 Tue / 1 Thu — the flattest split allowed
    expect(excess([0, 2, 3])).toBe(1); // 3 Tue / 0 Thu — one weekday ignored
    expect(excess([0, 1, 1])).toBe(3); // 1 Tue / 2 Thu — nearly even, and far worse
  });

  it("three weekdays: charges only the matchup that ignores one of them", () => {
    const ns = cadence(3, [0, 1, 3]); // Tue/Wed/Fri × 3 weeks = 9 nights
    const even = [g("A", "B", 0, 0), g("A", "B", 4, 0), g("A", "B", 8, 0)]; // one each
    expect(spacingReport(even, ns, ["A", "B"]).pairingWeekdayExcess).toBe(0);
    const piled = [g("A", "B", 0, 0), g("A", "B", 3, 0), g("A", "B", 6, 0)]; // all Tue
    expect(spacingReport(piled, ns, ["A", "B"]).pairingWeekdayExcess).toBeGreaterThan(0);
  });
});

describe("spacingReport — slotWeekdaySpread", () => {
  it("catches a team whose season ice share is perfect but whose weekdays are not", () => {
    const ns = nights(2, ["19:00", "20:15"]); // Tue, Thu, Tue, Thu
    // A: both Tuesdays in slot 0, both Thursdays in slot 1. Season 2-2 (spread
    // 0), but Tue is 2-0 and Thu is 0-2 — spread 2 each, so 4. This is the exact
    // defect the season-wide term cannot see.
    const games = [
      g("A", "B", 0, 0),
      g("A", "B", 2, 0),
      g("A", "B", 1, 1),
      g("A", "B", 3, 1),
    ];
    const r = spacingReport(games, ns, ["A", "B"]);
    expect(r.slotWeekdaySpread).toBe(8); // 4 for A, 4 for B
  });

  it("is zero when each weekday is itself evenly shared", () => {
    const ns = nights(2, ["19:00", "20:15"]);
    const games = [
      g("A", "B", 0, 0),
      g("A", "B", 2, 1), // Tue: one of each
      g("A", "B", 1, 0),
      g("A", "B", 3, 1), // Thu: one of each
    ];
    expect(spacingReport(games, ns, ["A", "B"]).slotWeekdaySpread).toBe(0);
  });

  it("degenerates to the season-wide spread on a single-weekday cadence", () => {
    // With one weekday the per-weekday term says exactly what the season term
    // says. Harmless in the rank tuple (the two are always equal, so the second
    // is never the tiebreak), but a cost function must not charge both.
    const ns = cadence(4, [2], ["19:00", "20:15"]); // Thu only
    const games = [
      g("A", "B", 0, 0),
      g("A", "B", 1, 0),
      g("A", "B", 2, 0),
      g("A", "B", 3, 1),
    ];
    const r = spacingReport(games, ns, ["A", "B"]);
    const seasonSpread = 3 - 1; // slot0 three times, slot1 once
    expect(r.slotWeekdaySpread).toBe(seasonSpread * 2); // per team
  });
});

describe("spacingReport — slotStreak3", () => {
  it("counts a three-game run in one ice time once", () => {
    const ns = nights(2);
    const games = [g("A", "B", 0, 0), g("A", "B", 1, 0), g("A", "B", 2, 0)];
    const r = spacingReport(games, ns, ["A", "B"]);
    expect(r.slotStreak3).toBe(2); // one per team
    expect(r.slotConsecutive).toBe(4); // two back-to-back pairs per team
  });

  it("counts a four-game run twice, so longer runs cost more", () => {
    const ns = nights(2);
    const games = [
      g("A", "B", 0, 0),
      g("A", "B", 1, 0),
      g("A", "B", 2, 0),
      g("A", "B", 3, 0),
    ];
    expect(spacingReport(games, ns, ["A", "B"]).slotStreak3).toBe(4); // 2 per team
  });

  it("ignores two separate back-to-back pairs", () => {
    const ns = nights(2);
    const games = [
      g("A", "B", 0, 0),
      g("A", "B", 1, 0), // a 2-run in slot 0
      g("A", "B", 2, 1),
      g("A", "B", 3, 1), // a separate 2-run in slot 1
    ];
    const r = spacingReport(games, ns, ["A", "B"]);
    expect(r.slotStreak3).toBe(0);
    expect(r.slotConsecutive).toBe(4);
  });
});

describe("spacingReport — longestLayoffDays", () => {
  it("measures days, not nights, so a holiday gap shows its real length", () => {
    const ns: Night[] = [
      { date: day(0), slots: ["19:00"] },
      { date: day(2), slots: ["19:00"] },
      { date: day(28), slots: ["19:00"] }, // four weeks later
    ];
    const games = [g("A", "B", 0, 0), g("A", "B", 2, 0)];
    // A and B skip night 1, so their gap is day 0 → day 28.
    expect(spacingReport(games, ns, ["A", "B"]).longestLayoffDays).toBe(28);
  });

  it("is null when no team has two games to sit between", () => {
    const ns = nights(2);
    const games = [g("A", "B", 0, 0)];
    expect(spacingReport(games, ns, ["A", "B"]).longestLayoffDays).toBeNull();
  });
});
