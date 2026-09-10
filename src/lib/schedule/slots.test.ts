import { describe, it, expect } from "vitest";
import { assignSlots } from "./slots";
import {
  compareIceOutcome,
  iceOutcome,
  SLOT_BIAS_W,
  type IceOutcome,
} from "./spacing";

/**
 * Phase S under manager constraints.
 *
 * Cadence coverage for the ordinary slot metrics lives in `matchups.test.ts`
 * under `describe("assignSlots weekday split")` — see `SCHEDULE_HANDOFF.md` §6.
 * This file is only about the two things constraints add: a pinned ice time,
 * and the preference term.
 */

/** `n` identical nights of two games: 0 v 1 and 2 v 3, on two sheets of ice. */
const twoGameNights = (n: number): [number, number][][] =>
  Array.from({ length: n }, () => [
    [0, 1],
    [2, 3],
  ]);

describe("assignSlots pins", () => {
  it("holds a pinned game on its ice time while the night permutes around it", () => {
    const pairsByNight = twoGameNights(6);
    // Ask for the arrangement the search would otherwise refuse: team 0 on the
    // late sheet every single night. The even-share term costs 60 a step and the
    // pin is not a cost at all, so this only holds if the pin is honoured.
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
      // Only night 0 is supplied. The rest are `undefined`, which is NOT the
      // identity packing — they go through `seedNights` like any other night,
      // which is what lets generation pin a handful of nights without freezing
      // the season's ice-time layout.
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
  /**
   * A fixture where the bias is the ONLY thing left to decide.
   *
   * Two identical nights on one weekday, two sheets, four teams. The even-share
   * terms pin team 0 to one early game and one late one; both orderings tie on
   * season share, on per-weekday share, and on repeats (neither has any). Which
   * night gets which sheet is therefore a coin toss — unless a bias is asked
   * for, which is precisely the situation this term exists for.
   */
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
    // Ten nights, one weekday, the whole season inside the window. An even
    // share is 5/5; taking every game early would be 10/0. The bias is 4 a step
    // against 60 for a step of share, so it must lose — best effort means
    // exactly this, and a weight that won here would have reordered the goals.
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
    // Everything else about the two is identical, which is the point: without
    // this term reaching `compareIceOutcome`, generation would pick between
    // them at random and the feature would be a coin toss.
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
    biasCost: 0,
  };

  it("breaks a tie the four real metrics cannot", () => {
    expect(compareIceOutcome(base, { ...base, biasCost: 8 })).toBeLessThan(0);
  });

  it("never outranks an ordinary repeat, let alone anything above it", () => {
    // A candidate that honours the bias perfectly but adds a repeat loses, and
    // so does one that adds a three-game run. Bias is the last term for a
    // reason: it is a preference, and `slot_on` is the pin.
    expect(
      compareIceOutcome({ ...base, consecutive: 11, biasCost: -100 }, base),
    ).toBeGreaterThan(0);
    expect(
      compareIceOutcome({ ...base, streak3: 1, biasCost: -100 }, base),
    ).toBeGreaterThan(0);
  });
});

describe("a night permutation is not safe for slot_bias", () => {
  /**
   * ⛔ WHY `nightClass` CARRIES A MEMBERSHIP BIT PER BIAS. The night-order pass
   * may only swap nights whose labels match (`nightClass` in `assignNights.ts`),
   * and that label is correct only if it names every way a request can depend on
   * a night's POSITION. A `slot_bias` looks like the one kind that cannot:
   * `play_on`/`slot_on` name a night, `bye_in_week` names a week, but a bias is
   * (team, prefer) and reads position-free — so leaving it out of the label, or
   * exempting bias-only leagues from the pass altogether, both look free.
   *
   * Neither is. `SlotBias.nights` is a per-night mask — a from/to stretch of the
   * season, "over THIS stretch, lean my games late" — and `biasCost` charges
   * only the games whose night index falls inside it. Permuting nights relabels
   * which games are in the window, so the cost moves. Below: one arrangement and
   * a pure permutation of it, same games, same slots, different `biasCost`.
   *
   * ⚠️ The failure mode if this is misread is not a crash. `evaluateConstraints`
   * runs afterwards off the final games, so it would honestly report a request
   * as unmet that PHASE S had honoured — a bias is a Phase S cost term, and
   * `evaluateConstraints` deliberately exempts `slot_bias` from the
   * `plannerHonours` short-circuit. A silent downgrade, not an error.
   *
   * ⚠️ AN EARLIER VERSION OF THIS BLOCK DREW A STRONGER CONCLUSION THAN IT
   * EARNS — that the gate therefore could not be narrowed and had to stay
   * `resolved.empty`. What the asymmetry below rules out is narrowing the gate
   * BY CONSTRAINT KIND. It says nothing against constraining the PERMUTATION,
   * which is what night classes do, and which is what lets the pass run on a
   * constrained season at all. Measured: worst-team clustering 15 under the old
   * gate, 4 with night classes and the draw block restored.
   *
   * Related: `describe("iceOutcome bias")` above is already a pure night
   * permutation (`biasCost` 0 → 4). This block exists as the NAMED landing spot
   * for "is a bias position-sensitive?", not as new behavioural coverage — do
   * not delete either as a duplicate of the other.
   */
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
