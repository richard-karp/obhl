import { describe, it, expect } from "vitest";
import { roundRobin, BYE } from "./roundRobin";

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

describe("roundRobin", () => {
  it("6 teams single: 15 games, each pair once, no byes, 5 games each", () => {
    const ts = teams(6);
    const ps = roundRobin(ts, 1);
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
    const ps = roundRobin(teams(6), 2);
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
    const ps = roundRobin(ts, 1);
    expect(ps.length).toBe(21);
    for (const p of ps) {
      expect(p.home).not.toBe(BYE);
      expect(p.away).not.toBe(BYE);
    }
    const gp = gamesPerTeam(ps);
    for (const t of ts) expect(gp.get(t)).toBe(6);
  });

  it("home/away counts are roughly balanced (diff <= 2)", () => {
    const ts = teams(6);
    const ps = roundRobin(ts, 2);
    const home = new Map<string, number>();
    const away = new Map<string, number>();
    for (const p of ps) {
      home.set(p.home, (home.get(p.home) ?? 0) + 1);
      away.set(p.away, (away.get(p.away) ?? 0) + 1);
    }
    for (const t of ts) {
      expect(Math.abs((home.get(t) ?? 0) - (away.get(t) ?? 0))).toBeLessThanOrEqual(2);
    }
  });
});
