import { describe, it, expect } from "vitest";
import { assignSlots } from "./slots";
import {
  compareIceOutcome,
  iceOutcome,
  SLOT_BIAS_W,
  type IceOutcome,
} from "./spacing";

/** `n` identical nights of two games: 0 v 1 and 2 v 3, on two sheets of ice. */
const twoGameNights = (n: number): [number, number][][] =>
  Array.from({ length: n }, () => [
    [0, 1],
    [2, 3],
  ]);

describe("assignSlots pins", () => {
  it("holds a pinned game on its ice time while the night permutes around it", () => {
    const pairsByNight = twoGameNights(6);
    // Team 0 late every night, which the share term would refuse: this holds only if the pin does.
    const slotOf = assignSlots({
      teamCount: 4,
      pairsByNight,
      slotsPerNight: new Array(6).fill(2),
      weekdayOfNight: new Array(6).fill(1),
      timeBudgetMs: 200,
      restarts: 50,
      initial: pairsByNight.map(() => [1, 0]),
      pinned: pairsByNight.map(() => [0]),
    });
    for (let n = 0; n < 6; n++) {
      expect(slotOf[n][0]).toBe(1);
      // The night is still a permutation: the unpinned game took what was left.
      expect([...slotOf[n]].sort()).toEqual([0, 1]);
    }
  });

  it("leaves a night alone when it is given no pin", () => {
    const pairsByNight = twoGameNights(6);
    const slotOf = assignSlots({
      teamCount: 4,
      pairsByNight,
      slotsPerNight: new Array(6).fill(2),
      weekdayOfNight: new Array(6).fill(1),
      timeBudgetMs: 200,
      restarts: 50,
      // ⚠️ Only night 0 is supplied: `undefined` nights are seeded like any other, not the
      // identity packing, which is what lets generation pin a few nights.
      initial: [[1, 0], ...new Array(5).fill(undefined)],
      pinned: [[0], ...new Array(5).fill(undefined)],
    });
    expect(slotOf[0][0]).toBe(1);
    const team0 = slotOf.map((row) => row[0]);
    // Six games, two sheets: an even share is reachable and the search takes it.
    expect(team0.filter((s) => s === 0).length).toBe(3);
  });
});

describe("assignSlots slot_bias", () => {
  /** Two identical nights where every other term ties, so only the bias decides. */
  const biasFixture = (prefer: "early" | "late") =>
    assignSlots({
      teamCount: 4,
      pairsByNight: twoGameNights(2),
      slotsPerNight: [2, 2],
      weekdayOfNight: [0, 0],
      timeBudgetMs: 200,
      restarts: 30,
      biases: [{ team: 0, nights: [true, false], prefer }],
    });

  it("puts the biased team on the early sheet inside the window", () => {
    const slotOf = biasFixture("early");
    expect(slotOf[0][0]).toBe(0);
    expect(slotOf[1][0]).toBe(1);
  });

  it("...and on the late sheet when late is what was asked for", () => {
    const slotOf = biasFixture("late");
    expect(slotOf[0][0]).toBe(1);
    expect(slotOf[1][0]).toBe(0);
  });

  it("will not buy the preference by breaking the even ice share", () => {
    // Ten nights inside the window: an even share is 5/5, all early 10/0. The bias (4 a step)
    // must lose to the share (60).
    const slotOf = assignSlots({
      teamCount: 4,
      pairsByNight: twoGameNights(10),
      slotsPerNight: new Array(10).fill(2),
      weekdayOfNight: new Array(10).fill(0),
      timeBudgetMs: 300,
      restarts: 50,
      biases: [{ team: 0, nights: new Array(10).fill(true), prefer: "early" }],
    });
    const early = slotOf.filter((row) => row[0] === 0).length;
    expect(early).toBe(5);
  });
});

describe("iceOutcome bias", () => {
  const pairsByNight = twoGameNights(2);

  it("scores the bias off the assignment, so selection can see it", () => {
    const base = {
      teamCount: 4,
      pairsByNight,
      weekdayOfNight: [0, 0],
    };
    // Team 0 early on night 0 (the window), late on night 1.
    const honoured = iceOutcome({
      ...base,
      slotOf: [
        [0, 1],
        [1, 0],
      ],
      biases: [{ team: 0, nights: [true, false], prefer: "early" }],
    });
    const ignored = iceOutcome({
      ...base,
      slotOf: [
        [1, 0],
        [0, 1],
      ],
      biases: [{ team: 0, nights: [true, false], prefer: "early" }],
    });
    expect(honoured.biasCost).toBe(0);
    expect(ignored.biasCost).toBe(SLOT_BIAS_W);
    expect(compareIceOutcome(honoured, ignored)).toBeLessThan(0);
  });

  it("reads 0 when nobody asked for anything", () => {
    expect(
      iceOutcome({
        teamCount: 4,
        pairsByNight,
        weekdayOfNight: [0, 0],
        slotOf: [
          [0, 1],
          [1, 0],
        ],
      }).biasCost,
    ).toBe(0);
  });
});

describe("compareIceOutcome bias ranking", () => {
  const base: IceOutcome = {
    seasonSpread: 0,
    weekdaySpread: 0,
    streak3: 0,
    consecutive: 10,
    clusterWorst: 0,
    clusterTotal: 0,
    biasCost: 0,
  };

  it("breaks a tie the four real metrics cannot", () => {
    expect(compareIceOutcome(base, { ...base, biasCost: 8 })).toBeLessThan(0);
  });

  it("never outranks an ordinary repeat, let alone anything above it", () => {
    expect(
      compareIceOutcome({ ...base, consecutive: 11, biasCost: -100 }, base),
    ).toBeGreaterThan(0);
    expect(
      compareIceOutcome({ ...base, streak3: 1, biasCost: -100 }, base),
    ).toBeGreaterThan(0);
  });
});

describe("a night permutation is not safe for slot_bias", () => {
  /** ⛔ Why `nightClass` carries a bit per bias: a bias names a stretch of nights, so a pure night
   *  permutation moves `biasCost`. This and `iceOutcome bias` are not duplicates; keep both. */
  const pairsByNight: [number, number][][] = Array.from({ length: 4 }, () => [
    [0, 1],
    [2, 3],
  ]);
  // Team 0 late on nights 0-1, early on 2-3 …
  const arrangement = [
    [1, 0],
    [1, 0],
    [0, 1],
    [0, 1],
  ];
  // … and the same four nights in a different order: 2,3,0,1.
  const permuted = [arrangement[2], arrangement[3], arrangement[0], arrangement[1]];

  const biases = [
    { team: 0, nights: [true, true, false, false], prefer: "late" as const },
  ];
  const cost = (slotOf: number[][]) =>
    iceOutcome({ teamCount: 4, pairsByNight, slotOf, biases }).biasCost;

  it("moves biasCost, because the request names a stretch of the season", () => {
    // Team 0 is on the late sheet for both nights inside the window.
    expect(cost(arrangement)).toBe(-2 * SLOT_BIAS_W);
    // After the permutation it is on the early sheet for both of them. Same
    // games, same ice times, same season — only the night order changed.
    expect(cost(permuted)).toBe(0);
  });
});
