import { describe, it, expect } from "vitest";
import { assignMatchups } from "./matchups";
import { assignSlots } from "./slots";
import { weekdayExcessScaled } from "./spacing";

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
  const nightWeek = Array.from({ length: nightCount }, (_, n) =>
    Math.floor(n / 2),
  );
  const nightWeekday = Array.from({ length: nightCount }, (_, n) => n % 2);
  return { T, plays, nightWeek, nightWeekday };
}

/** Six teams all playing every night over a `[week, weekday]` cadence; three meetings a pair
 *  fill 15 nights of three games exactly, so the split has an exact answer. */
function cadence(nights: [number, number][]) {
  const T = 6;
  return {
    T,
    plays: Array.from({ length: T }, () => new Array(nights.length).fill(true)),
    nightWeek: nights.map((n) => n[0]),
    nightWeekday: nights.map((n) => n[1]),
    targets: Array.from({ length: T }, (_, a) =>
      Array.from({ length: T }, (_, b) => (a === b ? 0 : 3)),
    ),
  };
}

function countsByWeekday(
  pairsByNight: [number, number][][],
  nightWeekday: number[],
) {
  const wds = [...new Set(nightWeekday)].sort((a, b) => a - b);
  const counts = new Map<string, number[]>();
  pairsByNight.forEach((pairs, n) => {
    for (const [a, b] of pairs) {
      const k = `${Math.min(a, b)}|${Math.max(a, b)}`;
      const v = counts.get(k) ?? wds.map(() => 0);
      v[wds.indexOf(nightWeekday[n])]++;
      counts.set(k, v);
    }
  });
  return counts;
}

/** `pairingWeekdayExcess` over a Phase M result, in the units the report uses. */
function pairingExcess(
  pairsByNight: [number, number][][],
  nightWeekday: number[],
) {
  const wds = [...new Set(nightWeekday)].sort((a, b) => a - b);
  const perWd = wds.map((d) => nightWeekday.filter((x) => x === d).length);
  const counts = countsByWeekday(pairsByNight, nightWeekday);
  let scaled = 0;
  let off = 0;
  for (const v of counts.values()) {
    const e = weekdayExcessScaled(v, perWd);
    if (e > 0) off++;
    scaled += e;
  }
  return { excess: scaled / nightWeekday.length ** 2, off, pairs: counts.size };
}

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
    const res = assignMatchups({
      teamCount: T,
      plays,
      nightWeek,
      nightWeekday,
      targets,
    });
    expect(res).not.toBeNull();
    expect(res!.multiplicityError).toBe(0);
    expect(counts(T, res!.pairsByNight)).toEqual(targets);
  });

  it("plays exactly the teams the participation matrix says, once each", () => {
    const { T, plays, nightWeek, nightWeekday } = scenario(28);
    const targets = Array.from({ length: T }, (_, a) =>
      Array.from({ length: T }, (_, b) => (a === b ? 0 : 3)),
    );
    const res = assignMatchups({
      teamCount: T,
      plays,
      nightWeek,
      nightWeekday,
      targets,
    })!;
    res.pairsByNight.forEach((pairs, n) => {
      const seen = pairs.flat();
      expect(new Set(seen).size).toBe(seen.length); // nobody twice a night
      const expected = plays
        .map((row, t) => (row[n] ? t : -1))
        .filter((t) => t >= 0);
      expect([...seen].sort((a, b) => a - b)).toEqual(expected);
    });
  });

  it("declines rather than guessing when a night has too many pairings", () => {
    // 14 teams all playing is 135135 matchings a night: past enumeration, and a slice misses.
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

describe("assignMatchups weekday split", () => {
  it("meets every target over three weekdays", () => {
    // Mon/Wed/Fri for five weeks. 15 pairs × 3 meetings over 5 nights of each
    // weekday means one meeting per pair per weekday, exactly.
    const nights: [number, number][] = [];
    for (let w = 0; w < 5; w++) for (const d of [1, 3, 5]) nights.push([w, d]);
    const { T, plays, nightWeek, nightWeekday, targets } = cadence(nights);
    const res = assignMatchups({
      teamCount: T,
      plays,
      nightWeek,
      nightWeekday,
      targets,
    })!;
    expect(res.multiplicityError).toBe(0);
    const { pairs } = pairingExcess(res.pairsByNight, nightWeekday);
    expect(pairs).toBe(15);
  });

  it("meets every target when the weekdays run unequally", () => {
    // Mon every week, Thu every other week: 10 Mon nights to 5 Thu. An even
    // split is arithmetically impossible; the flattest one is 2 Mon / 1 Thu per
    // pairing, and code that aimed for "equal" would fail only on this shape.
    const nights: [number, number][] = [];
    for (let w = 0; w < 10; w++) {
      nights.push([w, 1]);
      if (w % 2 === 0) nights.push([w, 4]);
    }
    const { T, plays, nightWeek, nightWeekday, targets } = cadence(nights);
    expect(nightWeekday.filter((d) => d === 1).length).toBe(10);
    expect(nightWeekday.filter((d) => d === 4).length).toBe(5);
    const res = assignMatchups({
      teamCount: T,
      plays,
      nightWeek,
      nightWeekday,
      targets,
    })!;
    expect(res.multiplicityError).toBe(0);
  });

  it("is a no-op on a single-weekday cadence rather than double-counting it", () => {
    const nights: [number, number][] = [];
    for (let w = 0; w < 15; w++) nights.push([w, 4]);
    const { T, plays, nightWeek, nightWeekday, targets } = cadence(nights);
    const res = assignMatchups({
      teamCount: T,
      plays,
      nightWeek,
      nightWeekday,
      targets,
    })!;
    expect(res.multiplicityError).toBe(0);
    expect(pairingExcess(res.pairsByNight, nightWeekday).excess).toBe(0);
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
    const free = assignMatchups({
      teamCount: T,
      plays,
      nightWeek,
      nightWeekday,
      targets,
    })!;
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
      ps
        .map((p) => [...p].sort().join("-"))
        .sort()
        .join(",");
    const res = assignMatchups({
      teamCount: T,
      plays,
      nightWeek,
      nightWeekday,
      targets,
      restarts: 1,
      initial: incumbent,
      nightPenalty: (n, pairs) =>
        key(pairs) === key(incumbent[n]) ? 0 : 5_000,
    })!;
    expect(res.pairsByNight.map(key)).toEqual(incumbent.map(key));
    // And churn must not be reported as though it were bad spacing.
    expect(res.spacingCost).toBeLessThan(5_000);
  });
});

describe("assignSlots", () => {
  it("uses each of a night's slots exactly once", () => {
    const { T, plays, nightWeek, nightWeekday } = scenario(24);
    const targets = Array.from({ length: T }, () => new Array(T).fill(0));
    const m = assignMatchups({
      teamCount: T,
      plays,
      nightWeek,
      nightWeekday,
      targets,
    })!;
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

  it("starts from `initial` and never moves a frozen night", () => {
    const { T, plays, nightWeek, nightWeekday } = scenario(24);
    const targets = Array.from({ length: T }, () => new Array(T).fill(0));
    const m = assignMatchups({
      teamCount: T,
      plays,
      nightWeek,
      nightWeekday,
      targets,
    })!;
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
    for (let n = 12; n < 24; n++)
      expect([...slotOf[n]].sort()).toEqual([0, 1, 2]);
  });
});

/** Eight teams, a rotating bye pair, pairs fixed by the circle method. ⚠️ Built here, not by
 *  Phase M: routed through it, every Phase M change re-rolled the instance Phase S is judged on. */
function slotCadence(weekdayOfNight: number[]) {
  const T = 8;
  const N = weekdayOfNight.length;
  const pairsByNight: [number, number][][] = [];
  for (let n = 0; n < N; n++) {
    const bye = new Set([(2 * n) % T, (2 * n + 1) % T]);
    const playing = Array.from({ length: T }, (_, t) => t).filter(
      (t) => !bye.has(t),
    );
    const [head, ...rest] = playing;
    const k = n % rest.length;
    const order = [head, ...rest.slice(k), ...rest.slice(0, k)];
    const pairs: [number, number][] = [];
    for (let i = 0; i < order.length / 2; i++) {
      pairs.push([order[i], order[order.length - 1 - i]]);
    }
    pairsByNight.push(pairs);
  }
  return { T, pairsByNight };
}

describe("assignSlots without weekdays", () => {
  const BOUNDED = { restarts: 300, timeBudgetMs: 60_000 };

  it("still gives each night a valid ice-time permutation when no weekdays are given", () => {
    const wd = new Array(28).fill(4);
    const { T, pairsByNight } = slotCadence(wd);
    const slotOf = assignSlots({
      teamCount: T,
      pairsByNight,
      slotsPerNight: pairsByNight.map((p) => p.length),
      ...BOUNDED,
    });
    slotOf.forEach((slots, n) =>
      expect([...slots].sort()).toEqual(pairsByNight[n].map((_, gi) => gi)),
    );
  });
});
