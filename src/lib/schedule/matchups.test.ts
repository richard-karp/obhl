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

describe("assignMatchups night constraints", () => {
  const base = () => {
    const { T, plays, nightWeek, nightWeekday } = scenario(28);
    const targets = Array.from({ length: T }, (_, a) =>
      Array.from({ length: T }, (_, b) => (a === b ? 0 : 3)),
    );
    return { T, plays, nightWeek, nightWeekday, targets };
  };

  it("carries a pinned night through untouched", () => {
    const { T, plays, nightWeek, nightWeekday, targets } = base();
    const free = assignMatchups({ teamCount: T, plays, nightWeek, nightWeekday, targets })!;
    const pinned = free.pairsByNight[5];
    const res = assignMatchups({
      teamCount: T,
      plays,
      nightWeek,
      nightWeekday,
      targets,
      nightConstraints: plays[0].map((_, n) =>
        n === 5 ? ({ kind: "fixed", pairs: pinned } as const) : null,
      ),
    })!;
    expect(res.pairsByNight[5]).toEqual(pinned);
  });

  it("puts a required pair on the night that requires it", () => {
    const { T, plays, nightWeek, nightWeekday, targets } = base();
    // Night 3 sits teams 6 and 7; 0 and 1 both play, and aren't a forced pair.
    const res = assignMatchups({
      teamCount: T,
      plays,
      nightWeek,
      nightWeekday,
      targets,
      nightConstraints: plays[0].map((_, n) =>
        n === 3 ? ({ kind: "require", pairs: [[0, 1]] } as const) : null,
      ),
    })!;
    const keys = res.pairsByNight[3].map((p) => [...p].sort().join("-"));
    expect(keys).toContain("0-1");
  });

  it("declines when nothing satisfies the requirement", () => {
    const { T, plays, nightWeek, nightWeekday, targets } = base();
    // Teams 0 and 1 are the bye pair on night 0, so no matching contains them.
    expect(plays[0][0]).toBe(false);
    expect(plays[1][0]).toBe(false);
    const res = assignMatchups({
      teamCount: T,
      plays,
      nightWeek,
      nightWeekday,
      targets,
      nightConstraints: plays[0].map((_, n) =>
        n === 0 ? ({ kind: "require", pairs: [[0, 1]] } as const) : null,
      ),
    });
    expect(res).toBeNull();
  });

  it("leaves the incumbent alone when a night penalty makes churn cost", () => {
    const { T, plays, nightWeek, nightWeekday, targets } = base();
    const incumbent = assignMatchups({
      teamCount: T,
      plays,
      nightWeek,
      nightWeekday,
      targets,
    })!.pairsByNight;
    const key = (ps: [number, number][]) =>
      ps.map((p) => [...p].sort().join("-")).sort().join(",");
    const res = assignMatchups({
      teamCount: T,
      plays,
      nightWeek,
      nightWeekday,
      targets,
      restarts: 1,
      initial: incumbent,
      nightPenalty: (n, pairs) => (key(pairs) === key(incumbent[n]) ? 0 : 5_000),
    })!;
    // Already optimal, so a churn cost means there's no reason to move at all.
    expect(res.pairsByNight.map(key)).toEqual(incumbent.map(key));
    // And churn must not be reported as though it were bad spacing.
    expect(res.spacingCost).toBeLessThan(5_000);
  });
});

describe("assignSlots", () => {
  it("uses each of a night's slots exactly once", () => {
    const { T, plays, nightWeek, nightWeekday } = scenario(24);
    // Targets are irrelevant here; we just need a valid pairing to slot.
    const targets = Array.from({ length: T }, () => new Array(T).fill(0));
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

  it("starts from `initial` and never moves a frozen night", () => {
    const { T, plays, nightWeek, nightWeekday } = scenario(24);
    const targets = Array.from({ length: T }, () => new Array(T).fill(0));
    const m = assignMatchups({ teamCount: T, plays, nightWeek, nightWeekday, targets })!;
    // A deliberately bad starting layout, with the first half held there.
    const initial = m.pairsByNight.map(() => [2, 1, 0]);
    const frozen = m.pairsByNight.map((_, n) => n < 12);
    const slotOf = assignSlots({
      teamCount: T,
      pairsByNight: m.pairsByNight,
      slotsPerNight: new Array(24).fill(3),
      initial,
      frozen,
    });
    for (let n = 0; n < 12; n++) expect(slotOf[n]).toEqual([2, 1, 0]);
    // The free half is still a valid permutation and free to have moved.
    for (let n = 12; n < 24; n++) expect([...slotOf[n]].sort()).toEqual([0, 1, 2]);
  });

  it("holds a pinned game on its slot while the night permutes around it", () => {
    const { T, plays, nightWeek, nightWeekday } = scenario(24);
    const targets = Array.from({ length: T }, () => new Array(T).fill(0));
    const m = assignMatchups({ teamCount: T, plays, nightWeek, nightWeekday, targets })!;
    const slotOf = assignSlots({
      teamCount: T,
      pairsByNight: m.pairsByNight,
      slotsPerNight: new Array(24).fill(3),
      initial: m.pairsByNight.map(() => [0, 1, 2]),
      // Game 2 keeps the last ice time on every night — the "Final" case.
      pinned: m.pairsByNight.map(() => [2]),
    });
    for (const slots of slotOf) {
      expect(slots[2]).toBe(2);
      expect([...slots].sort()).toEqual([0, 1, 2]);
    }
  });
});
