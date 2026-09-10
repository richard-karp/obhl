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

/**
 * `SCHEDULE_HANDOFF.md` §5: rescaling `MULT_W` or the `SPACING_W` rematch
 * weights requires rescaling `oneOff.ts`'s churn term in the SAME change, or the
 * repair's sense of a costly move drifts out of step with generation's —
 * quietly, with a plausible-looking schedule. Nothing covered that.
 */
describe("MULT_W / SPACING_W / CHURN_W coupling", () => {
  // ⚠️ These ratios are pinned so that changing ONE SIDE IS DELIBERATE. They are
  // not a claim that the current values are correct — if a ratio is itself
  // wrong, this test freezes the bug. It exists so the two sides move together.
  //
  // Written as exact integer products rather than float division: 5000/120 is
  // 41.666… and no `toBeCloseTo` precision expresses "these two are in a 3:125
  // ratio" without slack in one direction or the other.
  it("keeps the churn weights in step with the spacing weights", () => {
    // "Disturbing a game outweighs any single rematch penalty" — 125:3.
    expect(CHURN_W.FEWEST * 3).toBe(SPACING_W.rematchSameWeek * 125);
    // "Landing changes soonest is worth five consecutive-week rematches."
    expect(CHURN_W.SOONEST).toBe(SPACING_W.rematchConsecWeek * 5);
    // "A change to how often a pair meets outranks up to TEN disturbed nights."
    // Not "any amount of churn": both enter the same objective, so 11 nights at
    // CHURN_W.FEWEST (55 000) outweigh one meeting-count error (50 000).
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

  /**
   * Which fields `compareIceOutcome` actually consults. Both arguments are
   * EQUAL, so every term evaluates to `+0` (true for `-0` too, and `NaN` is
   * falsy), every `||` falls through, and the chain runs to the end — reading
   * each field exactly once.
   *
   * Each side gets its OWN set, and they must match: one shared set would let
   * `a.streak3 - b.consecutive` produce the correct union and pass.
   */
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

  // ⚠️ LIMITATION, found by mutating this on purpose: it records which fields the
  // comparator READS, not which ones affect the result. Replacing a term with
  // `0 * (a.x - b.x)` still reads both and still passes. Deleting a term, or
  // comparing `a.x` against `b.y`, both fail — those are the realistic drifts.
  //
  // ⛔ Catches a goal computed and ranked nowhere — the "coin toss"
  // `slots.ts:153-156` warns about, where the candidate honouring a new goal
  // loses to one ignoring it, at random, with every other test green.
  it("compareIceOutcome reads exactly the ranked fields", () => {
    expect(fieldsRead()).toEqual([...RANKED].sort());
  });

  // ⛔ And the other direction: a field added to `iceOutcome` must be classified
  // as ranked or deliberately-unranked here. Adding one without touching this
  // list fails, which is the point — the decision should not be implicit.
  it("iceOutcome produces the ranked fields plus the unranked pair", () => {
    expect(Object.keys(sample).sort()).toEqual([...RANKED, ...UNRANKED].sort());
  });

  /**
   * ⛔ The REPAIR's coupling, which is a different one. `outcomeOf` builds an
   * `IceOutcome` that never reaches `compareIceOutcome` — its only consumer is
   * `ICE_METRICS.filter((m) => mine[m] > base[m])`, which drives `worseThan` and
   * the repair dialog. So what matters here is that every metric in that list is
   * actually built, and built from the right source field.
   *
   * The fixture gives each mapped field a DISTINCT value: an all-zero season
   * passes against a completely scrambled mapping.
   */
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
  /**
   * A repair fixture with a rematch-spacing gain and a churn cost in direct
   * tension, pinning which one the repair takes. The variants exist because they
   * price churn differently (`fewest` charges `CHURN_W.FEWEST`, `spacing`
   * charges `CHURN_W.SPACING`), so `fewest` should never disturb more nights
   * than `spacing`.
   *
   * ⚠️ Needs a fixture the current ones cannot supply. Measured 2026-09-09 on
   * `oneOff.test.ts`'s 8-team/8-week season with half the nights locked:
   * `planOneOff` returns only `no-repair` (1 change) and `soonest` (10) — the
   * other two variants collapse or come back null, so there is nothing to
   * compare and a test written against it would assert nothing.
   */
  it.todo("prices churn against spacing the way the weights promise");
});
