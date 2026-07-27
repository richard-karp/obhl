import { describe, it, expect } from "vitest";
import { assignMatchups } from "./matchups";
import { assignSlots } from "./slots";

/** 8 teams, 6 of them playing each night on a rotating bye pair. */
function scenario(nightCount: number) {
  const T = 8;
  const plays: boolean[][] = Array.from({ length: T }, () =>
    new Array(nightCount).fill(true),
  );
  for (let n = 0; n < nightCount; n++) {
    plays[(2 * n) % T][n] = false;
    plays[(2 * n + 1) % T][n] = false;
  }
  const nightWeek = Array.from({ length: nightCount }, (_, n) => Math.floor(n / 2));
  const nightWeekday = Array.from({ length: nightCount }, (_, n) => n % 2);
  return { T, plays, nightWeek, nightWeekday };
}

/** Meeting counts implied by a result, as a symmetric matrix. */
function counts(T: number, pairsByNight: [number, number][][]) {
  const m = Array.from({ length: T }, () => new Array(T).fill(0));
  for (const pairs of pairsByNight) {
    for (const [a, b] of pairs) {
      m[a][b]++;
      m[b][a]++;
    }
  }
  return m;
}

describe("assignMatchups", () => {
  it("hits the requested meeting counts exactly", () => {
    const { T, plays, nightWeek, nightWeekday } = scenario(28);
    // 28 nights × 3 games = 84 games over 28 pairs = 3 meetings each.
    const targets = Array.from({ length: T }, (_, a) =>
      Array.from({ length: T }, (_, b) => (a === b ? 0 : 3)),
    );
    const res = assignMatchups({ teamCount: T, plays, nightWeek, nightWeekday, targets });
    expect(res).not.toBeNull();
    expect(res!.multiplicityError).toBe(0);
    expect(counts(T, res!.pairsByNight)).toEqual(targets);
  });

  it("plays exactly the teams the participation matrix says, once each", () => {
    const { T, plays, nightWeek, nightWeekday } = scenario(28);
    const targets = Array.from({ length: T }, (_, a) =>
      Array.from({ length: T }, (_, b) => (a === b ? 0 : 3)),
    );
    const res = assignMatchups({ teamCount: T, plays, nightWeek, nightWeekday, targets })!;
    res.pairsByNight.forEach((pairs, n) => {
      const seen = pairs.flat();
      expect(new Set(seen).size).toBe(seen.length); // nobody twice a night
      const expected = plays.map((row, t) => (row[n] ? t : -1)).filter((t) => t >= 0);
      expect([...seen].sort((a, b) => a - b)).toEqual(expected);
    });
  });

  it("declines rather than guessing when a night has too many pairings", () => {
    // 14 teams all playing means 135135 perfect matchings a night — far past
    // what can be enumerated, and sampling a slice of them misses the targets.
    const T = 14;
    const plays = Array.from({ length: T }, () => [true, true]);
    const targets = Array.from({ length: T }, () => new Array(T).fill(1));
    const res = assignMatchups({
      teamCount: T,
      plays,
      nightWeek: [0, 0],
      nightWeekday: [0, 1],
      targets,
    });
    expect(res).toBeNull();
  });
});

describe("assignSlots", () => {
  it("uses each of a night's slots exactly once", () => {
    const { T, plays, nightWeek, nightWeekday } = scenario(24);
    const targets = Array.from({ length: T }, (_, a) =>
      Array.from({ length: T }, (_, b) => (a === b ? 0 : 0)),
    );
    // Targets are irrelevant here; we just need a valid pairing to slot.
    const m = assignMatchups({ teamCount: T, plays, nightWeek, nightWeekday, targets })!;
    const slotOf = assignSlots({
      teamCount: T,
      pairsByNight: m.pairsByNight,
      slotsPerNight: new Array(24).fill(3),
    });
    slotOf.forEach((slots, n) => {
      expect(slots.length).toBe(m.pairsByNight[n].length);
      expect([...slots].sort()).toEqual([0, 1, 2]);
    });
  });

  it("shares the ice times evenly across teams", () => {
    const { T, plays, nightWeek, nightWeekday } = scenario(28);
    const targets = Array.from({ length: T }, (_, a) =>
      Array.from({ length: T }, (_, b) => (a === b ? 0 : 3)),
    );
    const m = assignMatchups({ teamCount: T, plays, nightWeek, nightWeekday, targets })!;
    const slotOf = assignSlots({
      teamCount: T,
      pairsByNight: m.pairsByNight,
      slotsPerNight: new Array(28).fill(3),
    });
    const share = Array.from({ length: T }, () => [0, 0, 0]);
    m.pairsByNight.forEach((pairs, n) => {
      pairs.forEach(([a, b], gi) => {
        share[a][slotOf[n][gi]]++;
        share[b][slotOf[n][gi]]++;
      });
    });
    for (const s of share) expect(Math.max(...s) - Math.min(...s)).toBeLessThanOrEqual(1);
  });
});
