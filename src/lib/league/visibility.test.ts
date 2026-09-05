import { describe, it, expect } from "vitest";
import { decideLeagueVisible } from "./visibility";

/**
 * Four cells, and the two that matter are the diagonal: a staged league must be
 * invisible to a stranger and visible to its own people. The other two are the
 * published cases, where identity is irrelevant.
 */
describe("decideLeagueVisible — the four cells", () => {
  const cases: [boolean, boolean, boolean, string][] = [
    [true, false, true, "a published league is public, membership or not"],
    [true, true, true, "a published league is visible to its members too"],
    [
      false,
      true,
      true,
      "a staged league is visible to a member — staging it must not lock them out",
    ],
    [
      false,
      false,
      false,
      "a staged league is invisible to a stranger — the whole point of staging",
    ],
  ];

  for (const [isPublic, isMember, expected, why] of cases) {
    it(why, () => {
      expect(decideLeagueVisible(isPublic, isMember)).toBe(expected);
    });
  }
});

describe("decideLeagueVisible — each half is load-bearing", () => {
  // These are the two knock-outs the design asks for, written as assertions
  // rather than as a manual experiment: drop either term from the rule and one
  // of them goes red. Dropping `isPublic` breaks the first; dropping `isMember`
  // breaks the second.
  it("without the published term, an anonymous visitor loses a live league", () => {
    expect(decideLeagueVisible(true, false)).toBe(true);
  });

  it("without the membership term, a member loses their staged league", () => {
    expect(decideLeagueVisible(false, true)).toBe(true);
  });
});
