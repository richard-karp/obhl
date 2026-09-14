import { describe, it, expect } from "vitest";
import { decideLeagueVisible } from "./visibility";

/**
 * A complete truth table over two booleans, so it pins the function: every other boolean
 * function of two booleans fails at least one row, both term-drops included.
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
