import { describe, it, expect } from "vitest";
import { decideLeagueVisible } from "./visibility";

/**
 * Four cells, and the two that matter are the diagonal: a staged league must be
 * invisible to a stranger and visible to its own people. The other two are the
 * published cases, where identity is irrelevant.
 *
 * This is a COMPLETE truth table over the two-boolean domain, so it pins the
 * intended function rather than merely agreeing with the implementation: every
 * other boolean function of two booleans fails at least one row, both term-drops
 * included. A separate pair of knock-out assertions used to sit below it and was
 * removed as duplicate coverage — the table already catches what they caught.
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
