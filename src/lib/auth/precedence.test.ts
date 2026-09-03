import { describe, it, expect } from "vitest";
import { decideProfileWrite, type OfficeTier } from "./precedence";

const TIERS: (OfficeTier | null)[] = ["commissioner", "deputy", null];
const name = (t: OfficeTier | null) => t ?? "manager";

describe("decideProfileWrite — the nine-cell precedence matrix", () => {
  // Rows are the actor, columns the target, in TIERS order. `contains` is true
  // throughout so the office cells are not accidentally passing on the tier-0
  // test; the containment sub-cases are asserted separately below.
  const expected: Record<string, boolean> = {
    "commissioner->commissioner": false, // peer-flat: the tier is not editable from the app
    "commissioner->deputy": true,
    "commissioner->manager": true,
    "deputy->commissioner": false, // a deputy cannot touch the office at all
    "deputy->deputy": false,
    "deputy->manager": true,
    "manager->commissioner": false, // trap (b): never via vacuous containment
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
  // Reach is a rule at every office tier, not data, so an office member has no
  // profile_leagues rows and containment is meaningless for them. If any office
  // cell ever started depending on `contains`, the two halves of the rule would
  // have drifted: 0034's SQL reaches its containment test only at tier 0.
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
  // At the office tiers this is peer-flatness doing the work, and it is why an
  // office member cannot demote themselves into a powerless commissioner. At
  // tier 0 a manager DOES pass here — their leagues trivially contain their own —
  // and it is `updateStaffRole`'s demotion guard, not this rule, that refuses.
  // Asserted so a future change to either cannot quietly swap which one holds.
  it.each(TIERS)("%s cannot write their own tier", (tier) => {
    expect(decideProfileWrite(tier, tier, true)).toBe(tier === null);
  });
});
