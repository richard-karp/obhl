import { describe, it, expect } from "vitest";
import {
  assignHomeAway,
  homeAwaySpread,
  type OrientableGame,
} from "./homeAway";

/** Every unordered pair of `n` teams, `cycles` times over. */
function roundRobinPairs(n: number, cycles = 1): [number, number][] {
  const out: [number, number][] = [];
  for (let c = 0; c < cycles; c++) {
    for (let a = 0; a < n; a++) {
      for (let b = a + 1; b < n; b++) out.push([a, b]);
    }
  }
  return out;
}

const free = (pairs: [number, number][]): OrientableGame[] =>
  pairs.map((pair) => ({ pair, locked: false }));

describe("assignHomeAway", () => {
  it("reaches a perfectly even split when parity allows", () => {
    // 6 teams, double round robin: every team plays 10 games, so every team can
    // reach exactly 5 home / 5 away and the floor is 0.
    const pairs = roundRobinPairs(6, 2);
    const out = assignHomeAway({ teamCount: 6, games: free(pairs) });
    expect(homeAwaySpread(6, out)).toBe(0);
  });

  it("reaches the parity floor when an even split is impossible", () => {
    // Single round robin over 6 teams: 5 games each, so every team is stuck at
    // |home − away| = 1 and the best achievable Σ diff² is 6.
    const pairs = roundRobinPairs(6, 1);
    const out = assignHomeAway({ teamCount: 6, games: free(pairs) });
    expect(homeAwaySpread(6, out)).toBe(6);
  });

  it("escapes the local optimum a strict descent gets stuck in", () => {
    // Team 0 at +2 and team 2 at −2, reconciled only through team 1, which sits
    // at 0. Flipping game i changes Σ diff² by 4·(diff[away] − diff[home] + 2),
    // so a flip only pays when diff[home] − diff[away] > 2. Here both edges sit
    // at exactly 2: every single flip is cost-neutral and strict descent stops.
    // The fix is two flips — 0→1 then 1→2 — and only the kick finds it.
    const games: OrientableGame[] = [
      { pair: [0, 1], locked: false, current: [0, 1] },
      { pair: [0, 1], locked: false, current: [0, 1] },
      { pair: [1, 2], locked: false, current: [1, 2] },
      { pair: [1, 2], locked: false, current: [1, 2] },
    ];
    // Every team plays an even number of games, so 0 is reachable.
    expect(
      homeAwaySpread(
        3,
        games.map((g) => g.current!),
      ),
    ).toBe(8);
    // Descent alone is stuck at the starting point...
    const stuck = assignHomeAway({ teamCount: 3, games, restarts: 0 });
    expect(homeAwaySpread(3, stuck)).toBe(8);
    // ...and the kick is what gets it out.
    const out = assignHomeAway({ teamCount: 3, games });
    expect(homeAwaySpread(3, out)).toBe(0);
  });

  it("counts locked games but never flips them", () => {
    // Two locked games hand team 0 a +2 head start; the free games have to
    // absorb it rather than the locked ones being rewritten.
    const games: OrientableGame[] = [
      { pair: [0, 1], locked: true, current: [0, 1] },
      { pair: [0, 2], locked: true, current: [0, 2] },
      { pair: [0, 1], locked: false },
      { pair: [0, 2], locked: false },
    ];
    const out = assignHomeAway({ teamCount: 3, games });
    expect(out[0]).toEqual([0, 1]);
    expect(out[1]).toEqual([0, 2]);
    expect(out[2]).toEqual([1, 0]);
    expect(out[3]).toEqual([2, 0]);
    expect(homeAwaySpread(3, out)).toBe(0);
  });

  it("leaves an already-balanced schedule untouched", () => {
    // Nothing to gain, so no game should flip — the churn tiebreaker.
    const current: [number, number][] = [
      [0, 1],
      [1, 0],
      [2, 3],
      [3, 2],
    ];
    const games: OrientableGame[] = current.map((c) => ({
      pair: c,
      locked: false,
      current: c,
    }));
    const out = assignHomeAway({ teamCount: 4, games });
    expect(out).toEqual(current);
  });

  it("is deterministic for a given seed", () => {
    const pairs = roundRobinPairs(8, 2);
    const a = assignHomeAway({ teamCount: 8, games: free(pairs), seed: 7 });
    const b = assignHomeAway({ teamCount: 8, games: free(pairs), seed: 7 });
    expect(a).toEqual(b);
  });
});
