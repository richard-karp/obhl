import { describe, it, expect } from "vitest";
import { scoresheetProblems, type SideCheck } from "./incomplete";

const ok = (over: Partial<SideCheck> = {}): SideCheck => ({
  teamName: "Red",
  dressedCount: 12,
  goalieId: "g",
  goalieIsSub: false,
  dressedGoalieIds: [],
  ...over,
});

describe("scoresheetProblems", () => {
  it("says nothing about a complete sheet", () => {
    expect(scoresheetProblems([ok(), ok({ teamName: "Green" })])).toEqual([]);
  });

  it("names the team that dressed nobody", () => {
    // The production fault, 2026-09-12: Red had zero `game_rosters` rows and
    // the game finalized 0-3 without a word.
    expect(scoresheetProblems([ok({ dressedCount: 0 })])).toContain(
      "Red: no players dressed",
    );
  });

  it("names the team with no goalie recorded", () => {
    expect(
      scoresheetProblems([ok({ goalieId: null, dressedGoalieIds: [] })]),
    ).toEqual(["Red: no goalie recorded"]);
  });

  it("accepts a dressed goalie as recorded, with no explicit pick", () => {
    // The view's fallback branch is a real answer, not an omission.
    expect(
      scoresheetProblems([
        ok({ goalieId: null, dressedGoalieIds: ["keeper"] }),
      ]),
    ).toEqual([]);
  });

  /**
   * ⛔ THE FALSE POSITIVE THIS FUNCTION WAS CORRECTED FOR. A Sub selection is a
   * complete answer that deliberately carries no individual record; warning
   * about it nags a correctly-entered sheet, and a warning that fires on
   * correct data teaches people to click through warnings — the exact
   * behaviour the gate exists to prevent.
   */
  it("does not warn about a substitute goalie", () => {
    expect(
      scoresheetProblems([
        ok({ goalieId: null, goalieIsSub: true, dressedGoalieIds: [] }),
      ]),
    ).toEqual([]);
  });

  it("counts an all-substitutes team as dressed", () => {
    // `setSubstitutes` writes one aggregate row with a null player_id. A team
    // fielding only subs is unusual, not wrong.
    expect(scoresheetProblems([ok({ dressedCount: 1 })])).toEqual([]);
  });

  it("reports both problems for a side that has neither", () => {
    expect(
      scoresheetProblems([
        ok({ dressedCount: 0, goalieId: null, dressedGoalieIds: [] }),
      ]),
    ).toEqual(["Red: no players dressed", "Red: no goalie recorded"]);
  });
});
