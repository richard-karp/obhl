import { describe, it, expect } from "vitest";
import { rankStandings, type RankableTeam, type HeadToHeadGame } from "./tiebreakers";

const team = (
  teamId: string,
  points: number,
  wins: number,
  gd: number,
  gf: number,
): RankableTeam => ({ teamId, points, wins, gd, gf });

describe("rankStandings", () => {
  it("orders by points then wins, assigns sequential ranks", () => {
    const rows = [
      team("a", 4, 2, 1, 10),
      team("b", 6, 3, 5, 12),
      team("c", 2, 1, -3, 6),
    ];
    const ranked = rankStandings(rows, []);
    expect(ranked.map((r) => r.teamId)).toEqual(["b", "a", "c"]);
    expect(ranked.map((r) => r.rank)).toEqual([1, 2, 3]);
  });

  it("breaks a two-way points tie by head-to-head before goal differential", () => {
    // a and b are tied on points & wins. b has the better GD, but a beat b
    // head-to-head, so a should rank ahead.
    const rows = [team("a", 4, 2, 1, 8), team("b", 4, 2, 5, 12)];
    const games: HeadToHeadGame[] = [
      { homeTeamId: "a", awayTeamId: "b", homeGoals: 3, awayGoals: 1 },
    ];
    const ranked = rankStandings(rows, games);
    expect(ranked.map((r) => r.teamId)).toEqual(["a", "b"]);
  });

  it("falls through to goal differential when head-to-head is even", () => {
    // a and b split their head-to-head (1 win each) -> equal H2H points,
    // so GD decides: b (GD 5) over a (GD 1).
    const rows = [team("a", 4, 2, 1, 8), team("b", 4, 2, 5, 12)];
    const games: HeadToHeadGame[] = [
      { homeTeamId: "a", awayTeamId: "b", homeGoals: 3, awayGoals: 1 },
      { homeTeamId: "b", awayTeamId: "a", homeGoals: 4, awayGoals: 2 },
    ];
    const ranked = rankStandings(rows, games);
    expect(ranked.map((r) => r.teamId)).toEqual(["b", "a"]);
  });

  it("resolves a three-way tie by mini-table head-to-head, then GD", () => {
    // a, b, c all tied on points/wins. Within the group:
    //   a beat b, b beat c, c beat a  -> all 2 H2H pts -> fall to GD.
    // GD: a=3, b=2, c=1  -> a, b, c.
    const rows = [
      team("a", 4, 2, 3, 12),
      team("b", 4, 2, 2, 10),
      team("c", 4, 2, 1, 9),
      team("d", 1, 0, -6, 4),
    ];
    const games: HeadToHeadGame[] = [
      { homeTeamId: "a", awayTeamId: "b", homeGoals: 2, awayGoals: 1 },
      { homeTeamId: "b", awayTeamId: "c", homeGoals: 3, awayGoals: 2 },
      { homeTeamId: "c", awayTeamId: "a", homeGoals: 4, awayGoals: 3 },
    ];
    const ranked = rankStandings(rows, games);
    expect(ranked.map((r) => r.teamId)).toEqual(["a", "b", "c", "d"]);
    expect(ranked.find((r) => r.teamId === "d")?.rank).toBe(4);
  });

  it("ignores head-to-head games involving teams outside the tied group", () => {
    // a and b tied; a lost to outside team x badly (shouldn't affect H2H).
    const rows = [team("a", 4, 2, 4, 10), team("b", 4, 2, 1, 7)];
    const games: HeadToHeadGame[] = [
      { homeTeamId: "b", awayTeamId: "a", homeGoals: 5, awayGoals: 0 }, // b won H2H
      { homeTeamId: "a", awayTeamId: "x", homeGoals: 0, awayGoals: 9 },
    ];
    const ranked = rankStandings(rows, games);
    // b won the head-to-head, so b ranks first despite a's better GD.
    expect(ranked.map((r) => r.teamId)).toEqual(["b", "a"]);
  });
});
