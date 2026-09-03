import { describe, it, expect } from "vitest";
import { planMerge, type RosterRow, type GameRow } from "./merge-plan";

const g = (o: Partial<GameRow> & { id: string; playerId: string }): GameRow => ({
  gameId: "g1", teamId: "t1", goals: 0, assists: 0, pim: 0, ...o,
});

describe("planMerge", () => {
  it("sums three records dressed for the same game into one row", () => {
    const plan = planMerge("keep", [], [
      g({ id: "r1", playerId: "keep", goals: 1, assists: 2 }),
      g({ id: "r2", playerId: "dupe1", goals: 2, assists: 1, pim: 4 }),
      g({ id: "r3", playerId: "dupe2", goals: 0, assists: 3 }),
    ]);
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.games).toEqual([{
      gameId: "g1", survivorId: "r1", deleteIds: ["r2", "r3"],
      goals: 3, assists: 6, pim: 4, repoint: false,
    }]);
  });

  it("elects a survivor and repoints when the kept player did not dress", () => {
    const plan = planMerge("keep", [], [
      g({ id: "r2", playerId: "dupe1", goals: 1 }),
      g({ id: "r3", playerId: "dupe2", goals: 2 }),
    ]);
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.games[0]).toMatchObject({
      survivorId: "r2", deleteIds: ["r3"], goals: 3, repoint: true,
    });
  });

  it("refuses when two records played the same game on opposite teams", () => {
    const plan = planMerge("keep", [], [
      g({ id: "r1", playerId: "keep", teamId: "t1" }),
      g({ id: "r2", playerId: "dupe1", teamId: "t2" }),
    ]);
    expect(plan).toEqual({ ok: false, reason: "opposing-teams", gameId: "g1" });
  });

  it("refuses when the records are active on different teams in one season", () => {
    const rosters: RosterRow[] = [
      { id: "a", playerId: "keep", seasonId: "s", teamId: "t1", jerseyNumber: 9, isCaptain: false },
      { id: "b", playerId: "dupe1", seasonId: "s", teamId: "t2", jerseyNumber: 9, isCaptain: false },
    ];
    const plan = planMerge("keep", rosters, []);
    expect(plan).toMatchObject({ ok: false, reason: "different-active-teams" });
  });

  it("refuses when two of the records have linked user accounts", () => {
    const plan = planMerge("keep", [], [], ["keep", "dupe1"]);
    expect(plan).toMatchObject({ ok: false, reason: "both-linked" });
  });

  it("allows the merge when only one record is linked", () => {
    const plan = planMerge("keep", [], [], ["dupe1"]);
    expect(plan.ok).toBe(true);
  });

  it("keeps the richer roster row on the same team and season", () => {
    const rosters: RosterRow[] = [
      { id: "r1", playerId: "keep", seasonId: "s", teamId: "t", jerseyNumber: null, isCaptain: false },
      { id: "r2", playerId: "dupe1", seasonId: "s", teamId: "t", jerseyNumber: 17, isCaptain: true },
    ];
    const plan = planMerge("keep", rosters, []);
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.rosterKeep).toEqual(["r2"]);
    expect(plan.rosterDelete).toEqual(["r1"]);
  });
});
