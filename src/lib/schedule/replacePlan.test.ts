import { describe, it, expect } from "vitest";
import { candidatesFor } from "./replacePlan";
import type { GuardRow } from "./editGuards";

const row = (
  id: string,
  home: string,
  away: string,
  at: string,
  extra: Partial<GuardRow> = {},
): GuardRow => ({
  id,
  home_team_id: home,
  away_team_id: away,
  scheduled_at: at,
  status: "scheduled",
  home_goals: null,
  away_goals: null,
  ...extra,
});

const at = (day: number, hour = 19) =>
  `2027-01-${String(day).padStart(2, "0")}T${String(hour).padStart(2, "0")}:00:00-05:00`;

describe("candidatesFor", () => {
  /**
   * The shape of the whole feature: "replace B with C in g1" is only legal if C
   * gives B its place somewhere else. Anything else leaves B a game short and C
   * a game long, forever.
   */
  it("offers the games where the arriving team can hand its place back", () => {
    const rows = [
      row("g1", "A", "B", at(5)),
      row("g2", "C", "D", at(7)),
      row("g3", "E", "F", at(9)),
    ];
    const found = candidatesFor(rows, "g1", "B", "C");
    expect(found.map((g) => g.id)).toEqual(["g2"]);
  });

  it("returns nothing when the arriving team plays no other game", () => {
    const rows = [row("g1", "A", "B", at(5)), row("g2", "D", "E", at(7))];
    expect(candidatesFor(rows, "g1", "B", "C")).toEqual([]);
  });

  it("never offers the game being edited", () => {
    const rows = [row("g1", "A", "B", at(5)), row("g2", "B", "C", at(7))];
    // C is already in g2 with B — trading there would put B against itself.
    expect(candidatesFor(rows, "g1", "B", "C").map((g) => g.id)).not.toContain(
      "g1",
    );
  });

  it("rejects a trade that would make a team play twice on one night", () => {
    const rows = [
      row("g1", "A", "B", at(5)),
      // B already plays on the 7th, so taking C's place there is a doubleheader.
      row("g2", "C", "D", at(7)),
      row("g3", "B", "E", at(7, 20)),
    ];
    expect(candidatesFor(rows, "g1", "B", "C")).toEqual([]);
  });

  it("rejects a trade against a game that has been played", () => {
    const rows = [
      row("g1", "A", "B", at(5)),
      row("g2", "C", "D", at(7), {
        status: "final",
        home_goals: 3,
        away_goals: 1,
      }),
    ];
    expect(candidatesFor(rows, "g1", "B", "C")).toEqual([]);
  });

  it("rejects a trade that would put a team against itself", () => {
    // The partner already holds B, so handing B into C's place makes B v B.
    const rows = [row("g1", "A", "B", at(5)), row("g2", "C", "B", at(7))];
    expect(candidatesFor(rows, "g1", "B", "C")).toEqual([]);
  });

  /**
   * A manager fixing one week's matchup wants the nearest trade, not one in
   * April — the further the partner game, the more of the season the change
   * ripples through.
   */
  it("orders candidates by closeness to the game being edited", () => {
    const rows = [
      row("g1", "A", "B", at(15)),
      row("g2", "C", "D", at(25)),
      row("g3", "C", "E", at(17)),
      row("g4", "C", "F", at(5)),
    ];
    const found = candidatesFor(rows, "g1", "B", "C");
    expect(found.map((g) => g.id)).toEqual(["g3", "g4", "g2"]);
  });
});
