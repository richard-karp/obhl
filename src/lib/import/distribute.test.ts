import { describe, it, expect } from "vitest";
import { distributeStats, type DistGame, type DistPlayer } from "./distribute";

const sum = (dist: Map<number, { goals: number; assists: number; pim: number }>) => {
  let g = 0,
    a = 0,
    pim = 0;
  for (const c of dist.values()) {
    g += c.goals;
    a += c.assists;
    pim += c.pim;
  }
  return { g, a, pim, games: dist.size };
};

// A realistic-shaped fixture: 20 games, per-game team goals, a handful of
// players whose season totals sum to less than the team's goals-for (as in the
// real esportsdesk data, where many goals have no recorded scorer).
const games: DistGame[] = [4, 2, 6, 3, 5, 1, 3, 4, 2, 7, 3, 5, 2, 4, 6, 1, 3, 5, 2, 4].map(
  (cap) => ({ cap }),
);
const players: DistPlayer[] = [
  { gp: 18, g: 20, a: 15, pim: 8 },
  { gp: 16, g: 12, a: 18, pim: 0 },
  { gp: 20, g: 5, a: 9, pim: 22 },
  { gp: 10, g: 8, a: 3, pim: 4 },
  { gp: 14, g: 0, a: 0, pim: 6 }, // dresses, never scores
  { gp: 5, g: 2, a: 1, pim: 0 },
];

describe("distributeStats", () => {
  const dist = distributeStats(games, players);

  it("reproduces every player's season G / A / PIM exactly", () => {
    players.forEach((p, i) => {
      const s = sum(dist[i]);
      expect(s.g, `player ${i} goals`).toBe(p.g);
      expect(s.a, `player ${i} assists`).toBe(p.a);
      expect(s.pim, `player ${i} pim`).toBe(p.pim);
    });
  });

  it("rosters each player in exactly GP games (GP is exact)", () => {
    players.forEach((p, i) => {
      expect(dist[i].size, `player ${i} GP`).toBe(Math.min(p.gp, games.length));
    });
  });

  it("never records more skater goals in a game than the team scored", () => {
    const perGame = games.map(() => 0);
    dist.forEach((d) => {
      for (const [gi, c] of d) perGame[gi] += c.goals;
    });
    perGame.forEach((scored, gi) => {
      expect(scored, `game ${gi} goal overflow`).toBeLessThanOrEqual(games[gi].cap);
    });
  });

  it("only records stats in games a player dressed for", () => {
    players.forEach((_, i) => {
      for (const gi of dist[i].keys()) {
        expect(gi).toBeGreaterThanOrEqual(0);
        expect(gi).toBeLessThan(games.length);
      }
    });
  });

  it("handles a season with no games (everyone empty)", () => {
    const empty = distributeStats([], players);
    empty.forEach((d) => expect(d.size).toBe(0));
  });
});
