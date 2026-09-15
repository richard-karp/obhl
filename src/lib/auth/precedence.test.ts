import { describe, it, expect } from "vitest";
import { decideProfileWrite, type OfficeTier } from "./precedence";

const TIERS: (OfficeTier | null)[] = ["commissioner", "deputy", null];
const name = (t: OfficeTier | null) => t ?? "manager";

describe("decideProfileWrite — the nine-cell precedence matrix", () => {
  // Rows are the actor, columns the target. `contains` is true throughout, so no office
  // cell passes on the tier-0 test; containment is asserted separately below.
  const expected: Record<string, boolean> = {
    "commissioner->commissioner": false, // peer-flat: the tier is not editable from the app
    "commissioner->deputy": true,
    "commissioner->manager": true,
    "deputy->commissioner": false, // a deputy cannot touch the office at all
    "deputy->deputy": false,
    "deputy->manager": true,
    "manager->commissioner": false, // never via vacuous containment
    "manager->deputy": false,
    "manager->manager": true, // ...when contained; see below
  };

  for (const mine of TIERS) {
    for (const theirs of TIERS) {
      const key = `${name(mine)}->${name(theirs)}`;
      it(`${key} is ${expected[key]}`, () => {
        expect(decideProfileWrite(mine, theirs, true)).toBe(expected[key]);
      });
    }
  }
});

describe("decideProfileWrite — the tier-0 containment sub-cases", () => {
  it("a manager may write a tier-0 profile whose leagues theirs contain", () => {
    expect(decideProfileWrite(null, null, true)).toBe(true);
  });

  it("a manager may not write one that works a league they are not in", () => {
    expect(decideProfileWrite(null, null, false)).toBe(false);
  });
});

describe("decideProfileWrite — the office ignores containment", () => {
  // An office cell that depends on `contains` has drifted from `0034`, whose SQL reaches
  // its containment test only at tier 0.
  it.each([
    ["commissioner", "deputy", true],
    ["commissioner", null, true],
    ["deputy", null, true],
    ["commissioner", "commissioner", false],
    ["deputy", "deputy", false],
    ["deputy", "commissioner", false],
  ] as [OfficeTier, OfficeTier | null, boolean][])(
    "%s -> %s is %s regardless of containment",
    (mine, theirs, want) => {
      expect(decideProfileWrite(mine, theirs, true)).toBe(want);
      expect(decideProfileWrite(mine, theirs, false)).toBe(want);
    },
  );
});

describe("decideProfileWrite — self-writes", () => {
  // At tier 0 a manager passes here; `updateStaffRole`'s demotion guard is what refuses.
  // Asserted so a change to either cannot quietly swap which one holds.
  it.each(TIERS)("%s cannot write their own tier", (tier) => {
    expect(decideProfileWrite(tier, tier, true)).toBe(tier === null);
  });
});
