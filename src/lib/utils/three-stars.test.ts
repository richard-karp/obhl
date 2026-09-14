import { describe, it, expect } from "vitest";
import { computeThreeStars } from "./three-stars";

const row = (
  player_id: string | null,
  goals: number,
  assists: number,
  pim: number,
) => ({
  player_id,
  first_name: "F",
  last_name: player_id ?? "none",
  goals,
  assists,
  pim,
});

describe("computeThreeStars", () => {
  it("scores a goal 3, an assist 2 and a penalty minute -1, and keeps the top three", () => {
    const stars = computeThreeStars([
      row("p1", 1, 1, 2), // 3
      row("p2", 0, 0, 0), // 0
      row("p3", 2, 1, 0), // 8
      row("p4", 0, 2, 0), // 4
    ]);
    expect(stars).toEqual([
      { player_id: "p3", first_name: "F", last_name: "p3", g: 2, a: 1, pim: 0, score: 8 },
      { player_id: "p4", first_name: "F", last_name: "p4", g: 0, a: 2, pim: 0, score: 4 },
      { player_id: "p1", first_name: "F", last_name: "p1", g: 1, a: 1, pim: 2, score: 3 },
    ]);
  });

  it("breaks a tied score on goals, then on assists", () => {
    const stars = computeThreeStars([
      row("zero-goals", 0, 3, 0), // 6
      row("one-goal-two-assists", 1, 2, 1), // 6
      row("two-goals", 2, 0, 0), // 6
      row("one-goal-three-assists", 1, 3, 3), // 6
    ]);
    expect(stars.map((s) => s.score)).toEqual([6, 6, 6]);
    expect(stars.map((s) => s.player_id)).toEqual([
      "two-goals",
      "one-goal-three-assists",
      "one-goal-two-assists",
    ]);
  });

  it("leaves out a row with no player, however many points it has", () => {
    const stars = computeThreeStars([row(null, 5, 0, 0), row("p1", 0, 1, 0)]);
    expect(stars.map((s) => s.player_id)).toEqual(["p1"]);
  });
});
