import { describe, it, expect } from "vitest";
import { planMerge, type RosterRow, type GameRow } from "./merge-plan";

const g = (
  o: Partial<GameRow> & { id: string; playerId: string },
): GameRow => ({
  gameId: "g1",
  teamId: "t1",
  goals: 0,
  assists: 0,
  pim: 0,
  ...o,
});

const r = (
  o: Partial<RosterRow> & { id: string; playerId: string },
): RosterRow => ({
  seasonId: "s",
  teamId: "t",
  jerseyNumber: null,
  isCaptain: false,
  leftOn: null,
  ...o,
});

describe("planMerge", () => {
  it("sums three records dressed for the same game into one row", () => {
    const plan = planMerge(
      "keep",
      [],
      [
        g({ id: "r1", playerId: "keep", goals: 1, assists: 2 }),
        g({ id: "r2", playerId: "dupe1", goals: 2, assists: 1, pim: 4 }),
        g({ id: "r3", playerId: "dupe2", goals: 0, assists: 3 }),
      ],
    );
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.games).toEqual([
      {
        gameId: "g1",
        survivorId: "r1",
        deleteIds: ["r2", "r3"],
        goals: 3,
        assists: 6,
        pim: 4,
        repoint: false,
      },
    ]);
  });

  it("elects a survivor and repoints when the kept player did not dress", () => {
    const plan = planMerge(
      "keep",
      [],
      [
        g({ id: "r2", playerId: "dupe1", goals: 1 }),
        g({ id: "r3", playerId: "dupe2", goals: 2 }),
      ],
    );
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.games[0]).toMatchObject({
      survivorId: "r2",
      deleteIds: ["r3"],
      goals: 3,
      repoint: true,
    });
  });

  it("refuses when two records played the same game on opposite teams", () => {
    const plan = planMerge(
      "keep",
      [],
      [
        g({ id: "r1", playerId: "keep", teamId: "t1" }),
        g({ id: "r2", playerId: "dupe1", teamId: "t2" }),
      ],
    );
    expect(plan).toEqual({ ok: false, reason: "opposing-teams", gameId: "g1" });
  });

  it("refuses when the records are active on different teams in one season", () => {
    const rosters: RosterRow[] = [
      r({ id: "a", playerId: "keep", teamId: "t1", jerseyNumber: 9 }),
      r({ id: "b", playerId: "dupe1", teamId: "t2", jerseyNumber: 9 }),
    ];
    const plan = planMerge("keep", rosters, []);
    expect(plan).toMatchObject({ ok: false, reason: "different-active-teams" });
  });

  it("allows two teams in one season when one of them is a departure", () => {
    // The shape a transferred player has. Refusing it would make everyone who
    // ever moved teams permanently unmergeable.
    const rosters: RosterRow[] = [
      r({ id: "a", playerId: "keep", teamId: "t1", leftOn: "2026-02-01" }),
      r({ id: "b", playerId: "dupe1", teamId: "t2" }),
    ];
    const plan = planMerge("keep", rosters, []);
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    // Different teams, so both rows survive and both repoint at keepId.
    expect(plan.rosterKeep).toEqual(["a", "b"]);
    expect(plan.rosterDelete).toEqual([]);
  });

  it("keeps the active row over a departed one on the same team", () => {
    // richer would otherwise pick the departed row on its jersey and file the
    // merged player as gone from a team they are currently on.
    const rosters: RosterRow[] = [
      r({
        id: "gone",
        playerId: "keep",
        jerseyNumber: 17,
        isCaptain: true,
        leftOn: "2026-02-01",
      }),
      r({ id: "here", playerId: "dupe1" }),
    ];
    const plan = planMerge("keep", rosters, []);
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.rosterKeep).toEqual(["here"]);
    expect(plan.rosterDelete).toEqual(["gone"]);
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
      r({ id: "r1", playerId: "keep" }),
      r({ id: "r2", playerId: "dupe1", jerseyNumber: 17, isCaptain: true }),
    ];
    const plan = planMerge("keep", rosters, []);
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.rosterKeep).toEqual(["r2"]);
    expect(plan.rosterDelete).toEqual(["r1"]);
  });
});
