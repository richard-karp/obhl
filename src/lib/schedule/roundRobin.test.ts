import { describe, it, expect } from "vitest";
import { roundRobinRounds, buildBalancedPairings, BYE } from "./roundRobin";

const teams = (n: number) => Array.from({ length: n }, (_, i) => `t${i + 1}`);
const pairKey = (a: string, b: string) => [a, b].sort().join("|");

function gamesPerTeam(ps: { home: string; away: string }[]) {
  const gp = new Map<string, number>();
  for (const p of ps) {
    gp.set(p.home, (gp.get(p.home) ?? 0) + 1);
    gp.set(p.away, (gp.get(p.away) ?? 0) + 1);
  }
  return gp;
}

describe("roundRobinRounds — whole cycles", () => {
  it("6 teams single: 15 games, each pair once, no byes, 5 games each", () => {
    const ts = teams(6);
    const ps = roundRobinRounds(ts, 5);
    expect(ps.length).toBe(15);
    for (const p of ps) {
      expect(p.home).not.toBe(p.away);
      expect(p.home).not.toBe(BYE);
      expect(p.away).not.toBe(BYE);
    }
    const counts = new Map<string, number>();
    for (const p of ps) {
      const k = pairKey(p.home, p.away);
      counts.set(k, (counts.get(k) ?? 0) + 1);
    }
    expect(counts.size).toBe(15);
    for (const c of counts.values()) expect(c).toBe(1);
    const gp = gamesPerTeam(ps);
    for (const t of ts) expect(gp.get(t)).toBe(5);
  });

  it("6 teams double: 30 games, each pair exactly twice", () => {
    const ps = roundRobinRounds(teams(6), 10);
    expect(ps.length).toBe(30);
    const counts = new Map<string, number>();
    for (const p of ps) {
      const k = pairKey(p.home, p.away);
      counts.set(k, (counts.get(k) ?? 0) + 1);
    }
    expect(counts.size).toBe(15);
    for (const c of counts.values()) expect(c).toBe(2);
  });

  it("7 teams (odd): bye team excluded, each pair once, 6 games each", () => {
    const ts = teams(7);
    const ps = roundRobinRounds(ts, 7);
    expect(ps.length).toBe(21);
    for (const p of ps) {
      expect(p.home).not.toBe(BYE);
      expect(p.away).not.toBe(BYE);
    }
    const gp = gamesPerTeam(ps);
    for (const t of ts) expect(gp.get(t)).toBe(6);
  });
});

describe("roundRobinRounds", () => {
  it("even teams: emits exactly numRounds games per team", () => {
    const ts = teams(6);
    const gp = gamesPerTeam(roundRobinRounds(ts, 8));
    for (const t of ts) expect(gp.get(t)).toBe(8);
  });

  it("even teams: pairwise counts differ by at most 1", () => {
    const counts = new Map<string, number>();
    for (const p of roundRobinRounds(teams(6), 8)) {
      const k = pairKey(p.home, p.away);
      counts.set(k, (counts.get(k) ?? 0) + 1);
    }
    const vals = [...counts.values()];
    expect(Math.max(...vals) - Math.min(...vals)).toBeLessThanOrEqual(1);
  });

  it("odd teams: games per team differ by at most 1", () => {
    const ts = teams(7);
    const gp = gamesPerTeam(roundRobinRounds(ts, 10));
    const vals = ts.map((t) => gp.get(t) ?? 0);
    expect(Math.max(...vals) - Math.min(...vals)).toBeLessThanOrEqual(1);
  });

  it("attaches sequential round numbers 1..numRounds", () => {
    const rounds = roundRobinRounds(teams(6), 8).map((p) => p.round);
    expect(Math.min(...rounds)).toBe(1);
    expect(Math.max(...rounds)).toBe(8);
  });
});

describe("buildBalancedPairings", () => {
  it("even teams: everyone plays exactly the target games", () => {
    const ts = teams(8);
    const gp = gamesPerTeam(buildBalancedPairings(ts, 21));
    for (const t of ts) expect(gp.get(t)).toBe(21);
  });

  it("odd teams: everyone plays at least the target, spread <= 1", () => {
    const ts = teams(7);
    const gp = gamesPerTeam(buildBalancedPairings(ts, 20));
    const vals = ts.map((t) => gp.get(t) ?? 0);
    expect(Math.min(...vals)).toBeGreaterThanOrEqual(20);
    expect(Math.max(...vals) - Math.min(...vals)).toBeLessThanOrEqual(1);
  });
});
