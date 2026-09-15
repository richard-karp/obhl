import { describe, it, expect } from "vitest";
import {
  spacingReport,
  proportionalSplit,
  iceOutcome,
  compareIceOutcome,
  type PlacedGame,
  type IceOutcome,
} from "./spacing";
import { type Night } from "./assignNights";

const TUE = Date.UTC(2026, 8, 1); // 2026-09-01 is a Tuesday
const day = (offsetFromTue: number) =>
  new Date(TUE + offsetFromTue * 86400000).toISOString().slice(0, 10);

/** `weeks` weeks of nights at day `offsets` from Tue 2026-09-01 (0=Tue … 3=Fri). */
function cadence(
  weeks: number,
  offsets: number[],
  slots = ["19:00", "20:15"],
): Night[] {
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
    expect(proportionalSplit(5, [24, 24])).toEqual(
      proportionalSplit(5, [24, 24]),
    );
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
    const ns: Night[] = [
      { date: day(0), slots: ["19:00"] }, // Tue, week 0
      { date: day(2), slots: ["19:00"] }, // Thu, week 0
      { date: day(21), slots: ["19:00"] }, // Tue, week 3
      { date: day(23), slots: ["19:00"] }, // Thu, week 3
    ];
    const games = [
      g("A", "B", 0, 0),
      g("C", "D", 1, 0),
      g("C", "D", 2, 0),
      g("A", "B", 3, 0),
    ];
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
    expect(
      spacingReport(piled, ns, ["A", "B"]).pairingWeekdayExcess,
    ).toBeGreaterThan(0);
  });
});

describe("spacingReport — pairingsOffWeekdaySplit", () => {
  const ns = nights(3); // 3 Tue + 3 Thu

  it("counts matchups, not deviation", () => {
    // A|B piles both meetings onto Tuesdays; C|D splits one and one.
    const games = [
      g("A", "B", 0, 0),
      g("A", "B", 2, 0),
      g("C", "D", 0, 1),
      g("C", "D", 3, 1),
    ];
    const r = spacingReport(games, ns, ["A", "B", "C", "D"]);
    expect(r.pairingsOffWeekdaySplit).toBe(1); // just A|B
    expect(r.pairingWeekdayExcess).toBe(2); // ...which the score calls 2
  });

  it("counts each offending matchup once, however far off it is", () => {
    const games = [
      g("A", "B", 0, 0),
      g("A", "B", 2, 0),
      g("C", "D", 0, 1),
      g("C", "D", 2, 1),
      g("C", "D", 4, 1), // three Tuesdays — worse than A|B, still one matchup
    ];
    const r = spacingReport(games, ns, ["A", "B", "C", "D"]);
    expect(r.pairingsOffWeekdaySplit).toBe(2);
    expect(r.pairingWeekdayExcess).toBeGreaterThan(4);
  });

  it("is zero exactly when the score is", () => {
    const even = [g("A", "B", 0, 0), g("A", "B", 3, 0)]; // one Tue, one Thu
    const r = spacingReport(even, ns, ["A", "B"]);
    expect(r.pairingWeekdayExcess).toBe(0);
    expect(r.pairingsOffWeekdaySplit).toBe(0);
  });

  it("is a whole number where the score is fractional", () => {
    // 2 Tue / 1 Thu: the score divides by 9 and lands off an integer.
    const uneven: Night[] = [
      { date: day(0), slots: ["19:00"] }, // Tue
      { date: day(2), slots: ["19:00"] }, // Thu
      { date: day(7), slots: ["19:00"] }, // Tue
    ];
    const games = [g("A", "B", 0, 0), g("A", "B", 2, 0)]; // both Tuesdays
    const r = spacingReport(games, uneven, ["A", "B"]);
    expect(r.pairingWeekdayExcess).toBe(0.6667);
    expect(r.pairingsOffWeekdaySplit).toBe(1);
  });
});

describe("spacingReport — slotWeekdaySpread", () => {
  it("catches a team whose season ice share is perfect but whose weekdays are not", () => {
    const ns = nights(2, ["19:00", "20:15"]); // Tue, Thu, Tue, Thu
    // A: Tuesdays in slot 0, Thursdays in slot 1. Season 2-2 (spread 0), but each weekday
    // spreads 2, so 4 a team.
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

describe("compareIceOutcome", () => {
  const base = {
    seasonSpread: 0,
    weekdaySpread: 8,
    streak3: 0,
    consecutive: 46,
    clusterWorst: 0,
    clusterTotal: 0,
    biasCost: 0,
  };

  it("prefers a flat season share over every other gain", () => {
    const tempting = {
      ...base,
      seasonSpread: 4,
      weekdaySpread: 0,
      consecutive: 41,
    };
    expect(compareIceOutcome(base, tempting)).toBeLessThan(0);
  });

  it("prefers a flatter weekday split once season share ties", () => {
    const better = { ...base, weekdaySpread: 0 };
    expect(compareIceOutcome(better, base)).toBeLessThan(0);
  });

  it("will not buy a flat weekday split with a three-game run", () => {
    const flatSplitOneRun = { ...base, weekdaySpread: 0, streak3: 1 };
    expect(compareIceOutcome(base, flatSplitOneRun)).toBeLessThan(0);
    const flatSplitNoRun = { ...base, weekdaySpread: 0 };
    expect(compareIceOutcome(flatSplitNoRun, base)).toBeLessThan(0);
  });

  it("prefers fewer three-game runs over fewer ordinary repeats", () => {
    const fewerRuns = { ...base, streak3: 0, consecutive: 50 };
    const fewerRepeats = { ...base, streak3: 1, consecutive: 40 };
    expect(compareIceOutcome(fewerRuns, fewerRepeats)).toBeLessThan(0);
  });

  it("falls through to ordinary repeats when all else ties", () => {
    expect(compareIceOutcome({ ...base, consecutive: 40 }, base)).toBeLessThan(
      0,
    );
  });

  it("is 0 for identical outcomes", () => {
    expect(compareIceOutcome(base, { ...base })).toBe(0);
  });
});

describe("compareIceOutcome — clustering is computed but not ranked", () => {
  const OUT = (o: Partial<IceOutcome> = {}): IceOutcome => ({
    seasonSpread: 0,
    weekdaySpread: 0,
    streak3: 0,
    consecutive: 0,
    clusterWorst: 0,
    clusterTotal: 0,
    biasCost: 0,
    ...o,
  });

  // ⛔ Ranking on clustering was built, measured and removed: inert unconstrained, and bias
  // satisfaction fell 2/3 -> 1/3 constrained. Re-adding it needs a new measurement.
  it("ignores the clustering pair", () => {
    expect(
      compareIceOutcome(OUT({ clusterWorst: 3 }), OUT({ clusterWorst: 9 })),
    ).toBe(0);
    expect(
      compareIceOutcome(OUT({ clusterTotal: 10 }), OUT({ clusterTotal: 40 })),
    ).toBe(0);
  });

  it("lets biasCost decide regardless of clustering", () => {
    expect(
      compareIceOutcome(
        OUT({ clusterWorst: 9, biasCost: 0 }),
        OUT({ clusterWorst: 3, biasCost: 500 }),
      ),
    ).toBeLessThan(0);
  });
});

describe("iceOutcome clustered windows", () => {
  // ⚠️ Three sheets, not two: on two, every five-game window is clustered by pigeonhole, so the
  // fixture could not tell a working implementation from a broken one.
  it("counts them on a fixture the generator did not produce", () => {
    const pairsByNight: [number, number][][] = Array.from({ length: 5 }, () => [
      [0, 1],
      [2, 3],
      [4, 5],
    ]);
    const out = iceOutcome({
      teamCount: 6,
      pairsByNight,
      slotOf: [
        [0, 1, 2],
        [0, 1, 2],
        [0, 1, 2],
        [1, 2, 0],
        [2, 0, 1],
      ],
    });
    // t0/t1 see [0,0,0,1,2]; t2/t3 [1,1,1,2,0]; t4/t5 [2,2,2,0,1].
    expect(out.clusterWorst).toBe(1);
    expect(out.clusterTotal).toBe(6);
  });
});

describe("ice-time clustering", () => {
  /** t1 v t2 on `slots` weekly, plus t3 v t4 alternating the other sheets. ⚠️ t3/t4 carry 0
   *  windows and come last, so a last-team-wins bug reports 0 where the max is 2. */
  const seasonOf = (slots: number[]) => {
    const nights = slots.map((_, i) => ({
      date: new Date(Date.UTC(2026, 8, 1) + i * 7 * 86400000)
        .toISOString()
        .slice(0, 10),
      slots: ["19:00", "20:15", "21:30"],
    }));
    const games = slots.flatMap((s, i) => [
      { home: "t1", away: "t2", nightIndex: i, slotIndex: s },
      {
        home: "t3",
        away: "t4",
        nightIndex: i,
        slotIndex: (s + 1 + (i % 2)) % 3,
      },
    ]);
    return spacingReport(games, nights, ["t1", "t2", "t3", "t4"]);
  };

  it("counts a window where one ice time takes 3 of 5 games", () => {
    // windows: [2,2,2,0,1] -> three 2s, and [2,2,0,1,2] -> three 2s.
    const r = seasonOf([2, 2, 2, 0, 1, 2]);
    expect(r.slotClusterWorstTeam).toBe(2);
    expect(r.slotClusterWindows).toBe(4); // t1 and t2, both windows
  });

  it("counts nothing when the team rotates through the ice times", () => {
    const r = seasonOf([0, 1, 2, 0, 1, 2]);
    expect(r.slotClusterWorstTeam).toBe(0);
    expect(r.slotClusterWindows).toBe(0);
  });

  it("ignores a season too short to hold a window", () => {
    const r = seasonOf([2, 2, 2, 2]);
    expect(r.slotClusterWindows).toBe(0);
  });
});
