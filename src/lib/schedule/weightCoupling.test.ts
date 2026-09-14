import { describe, it, expect } from "vitest";
import { CHURN_W, ICE_METRICS, outcomeOf } from "./oneOff";
import { MULT_W } from "./matchups";
import {
  SPACING_W,
  iceOutcome,
  compareIceOutcome,
  spacingReport,
  type IceOutcome,
} from "./spacing";

/** Rescaling `MULT_W` or the `SPACING_W` rematch weights must rescale `oneOff.ts`'s churn term
 *  in the same change. RUNBOOK.md, _Schedule generator_. */
describe("MULT_W / SPACING_W / CHURN_W coupling", () => {
  // ⚠️ Pinned so changing one side is deliberate, not because the values are right. Integer
  // products, since no `toBeCloseTo` precision states an exact ratio.
  it("keeps the churn weights in step with the spacing weights", () => {
    // "Disturbing a game outweighs any single rematch penalty" — 125:3.
    expect(CHURN_W.FEWEST * 3).toBe(SPACING_W.rematchSameWeek * 125);
    // "Landing changes soonest is worth five consecutive-week rematches."
    expect(CHURN_W.SOONEST).toBe(SPACING_W.rematchConsecWeek * 5);
    // A meeting-count change outranks up to TEN disturbed nights: 11 at `CHURN_W.FEWEST`
    // (55 000) outweigh one error (50 000).
    expect(MULT_W).toBe(CHURN_W.FEWEST * 10);
  });
});

describe("IceOutcome is produced and read consistently", () => {
  const sample: IceOutcome = iceOutcome({
    teamCount: 4,
    pairsByNight: [
      [
        [0, 1],
        [2, 3],
      ],
      [
        [0, 2],
        [1, 3],
      ],
    ],
    slotOf: [
      [0, 1],
      [1, 0],
    ],
  });

  /** Ranked by `compareIceOutcome`, in no particular order. */
  const RANKED = [
    "seasonSpread",
    "streak3",
    "weekdaySpread",
    "consecutive",
    "biasCost",
  ];
  /** Computed, and deliberately NOT ranked — see the ⛔ in `compareIceOutcome`. */
  const UNRANKED = ["clusterWorst", "clusterTotal"];

  /** Fields `compareIceOutcome` reads: equal arguments make every `||` fall through. ⚠️ One set
   *  per side, or `a.streak3 - b.consecutive` would produce the right union and pass. */
  const fieldsRead = (): string[] => {
    const seenA = new Set<string>();
    const seenB = new Set<string>();
    const spy = (o: IceOutcome, into: Set<string>) =>
      new Proxy(o, {
        get(target, key, receiver) {
          if (typeof key === "string") into.add(key);
          return Reflect.get(target, key, receiver);
        },
      });
    compareIceOutcome(spy(sample, seenA), spy({ ...sample }, seenB));
    expect([...seenA].sort()).toEqual([...seenB].sort());
    return [...seenA].sort();
  };

  // ⚠️ Records fields READ, not fields that decide: `0 * (a.x - b.x)` still passes.
  // ⛔ Catches a goal computed but ranked nowhere, where a request becomes a coin toss.
  it("compareIceOutcome reads exactly the ranked fields", () => {
    expect(fieldsRead()).toEqual([...RANKED].sort());
  });

  // ⛔ And the other way: a new `iceOutcome` field must be classified ranked or unranked here,
  // so the decision is never implicit.
  it("iceOutcome produces the ranked fields plus the unranked pair", () => {
    expect(Object.keys(sample).sort()).toEqual([...RANKED, ...UNRANKED].sort());
  });

  /** ⛔ The repair's coupling: `outcomeOf` feeds only `worseThan`, so each metric must be built
   *  from the right field. Distinct values, since an all-zero season passes a scrambled map. */
  it("the repair builds every metric its regression list names", () => {
    const spacingAfter = {
      ...spacingReport(
        [
          { home: "a", away: "b", nightIndex: 0, slotIndex: 0 },
          { home: "c", away: "d", nightIndex: 0, slotIndex: 1 },
        ],
        [{ date: "2026-09-01", slots: ["19:00", "20:15"] }],
        ["a", "b", "c", "d"],
      ),
      slotWeekdaySpread: 11,
      slotStreak3: 22,
      slotConsecutive: 33,
      slotClusterWorstTeam: 44,
      slotClusterWindows: 55,
    };
    const out = outcomeOf({ slotSpreadAfter: 7, spacingAfter });

    for (const m of ICE_METRICS) {
      expect(Number.isFinite(out[m])).toBe(true);
    }
    // Distinct values, so a swapped mapping cannot pass.
    expect(out.seasonSpread).toBe(7);
    expect(out.weekdaySpread).toBe(11);
    expect(out.streak3).toBe(22);
    expect(out.consecutive).toBe(33);
    expect(out.clusterWorst).toBe(44);
    expect(out.clusterTotal).toBe(55);
  });
});

describe("the behavioural third of this guard", () => {
  /** Would pin `fewest` never disturbing more nights than `spacing`. ⚠️ Needs a new fixture: on
   *  `oneOff.test.ts`'s season only `no-repair` and `soonest` come back, so it asserts nothing. */
  it.todo("prices churn against spacing the way the weights promise");
});
