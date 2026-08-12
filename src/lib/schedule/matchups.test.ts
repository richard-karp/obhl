import { describe, it, expect } from "vitest";
import { assignMatchups } from "./matchups";
import { assignSlots } from "./slots";
import { proportionalSplit, weekdayExcessScaled } from "./spacing";

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

/**
 * Six teams all playing every night, over an arbitrary cadence given as
 * `[week, weekday]` per night. Three meetings per pair, which 15 nights of three
 * games fills exactly — so the weekday split has an exact answer to hit, and the
 * cadence is the only thing varying between these cases.
 */
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

/** Per pairing, how many times it meets on each weekday, in weekday order. */
function countsByWeekday(pairsByNight: [number, number][][], nightWeekday: number[]) {
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
function pairingExcess(pairsByNight: [number, number][][], nightWeekday: number[]) {
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

/** The four rematch-clustering counts, summed over every pair. */
function rematchCounts(
  pairsByNight: [number, number][][],
  nightWeek: number[],
  nightWeekday: number[],
) {
  const nights = new Map<string, number[]>();
  pairsByNight.forEach((pairs, n) => {
    for (const [a, b] of pairs) {
      const k = `${Math.min(a, b)}|${Math.max(a, b)}`;
      nights.set(k, [...(nights.get(k) ?? []), n]);
    }
  });
  let sameWeek = 0;
  let adjNight = 0;
  let consecWeek = 0;
  let consecWeekSameDay = 0;
  for (const ns of nights.values()) {
    const s = [...ns].sort((a, b) => a - b);
    for (let i = 1; i < s.length; i++) {
      if (s[i] - s[i - 1] === 1) adjNight++;
      const wa = nightWeek[s[i - 1]];
      const wb = nightWeek[s[i]];
      if (wa === wb) sameWeek++;
      else if (wb - wa === 1) {
        consecWeek++;
        if (nightWeekday[s[i]] === nightWeekday[s[i - 1]]) consecWeekSameDay++;
      }
    }
  }
  return { sameWeek, adjNight, consecWeek, consecWeekSameDay };
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

describe("assignMatchups weekday split", () => {
  it("splits every pairing evenly over three weekdays", () => {
    // Mon/Wed/Fri for five weeks. 15 pairs × 3 meetings over 5 nights of each
    // weekday means one meeting per pair per weekday, exactly.
    const nights: [number, number][] = [];
    for (let w = 0; w < 5; w++) for (const d of [1, 3, 5]) nights.push([w, d]);
    const { T, plays, nightWeek, nightWeekday, targets } = cadence(nights);
    const res = assignMatchups({ teamCount: T, plays, nightWeek, nightWeekday, targets })!;
    expect(res.multiplicityError).toBe(0);
    const { excess, off, pairs } = pairingExcess(res.pairsByNight, nightWeekday);
    expect(pairs).toBe(15);
    expect(off).toBe(0);
    expect(excess).toBe(0);
  });

  it("splits every pairing proportionally when the weekdays run unequally", () => {
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
    const res = assignMatchups({ teamCount: T, plays, nightWeek, nightWeekday, targets })!;
    expect(res.multiplicityError).toBe(0);
    const { excess, off } = pairingExcess(res.pairsByNight, nightWeekday);
    expect(off).toBe(0);
    expect(excess).toBe(0);
    // Spelled out, so a regression can't hide behind the metric being 0 for the
    // wrong reason: every pairing really is 2 Mon / 1 Thu.
    for (const [, v] of countsByWeekday(res.pairsByNight, nightWeekday)) {
      expect(v).toEqual([2, 1]);
    }
  });

  it("is a no-op on a single-weekday cadence rather than double-counting it", () => {
    // One weekday means every split is the only split. The term must read 0
    // rather than dividing by a weekday count of one and charging for nothing.
    const nights: [number, number][] = [];
    for (let w = 0; w < 15; w++) nights.push([w, 4]);
    const { T, plays, nightWeek, nightWeekday, targets } = cadence(nights);
    const res = assignMatchups({ teamCount: T, plays, nightWeek, nightWeekday, targets })!;
    expect(res.multiplicityError).toBe(0);
    expect(pairingExcess(res.pairsByNight, nightWeekday).excess).toBe(0);
  });

  it("does not buy the weekday split with rematch spacing", () => {
    // The locked priority: rematch spacing outranks the weekday split, so the
    // term must not create a rematch violation to straighten a pairing out.
    const nights: [number, number][] = [];
    for (let w = 0; w < 5; w++) for (const d of [1, 3, 5]) nights.push([w, d]);
    const { T, plays, nightWeek, nightWeekday, targets } = cadence(nights);
    const res = assignMatchups({ teamCount: T, plays, nightWeek, nightWeekday, targets })!;
    // Three meetings each over five weeks: same-week and back-to-back-night
    // repeats are avoidable here, consecutive weeks are not.
    const r = rematchCounts(res.pairsByNight, nightWeek, nightWeekday);
    expect(r.sameWeek).toBe(0);
    expect(r.adjNight).toBe(0);
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
      // `assignSlots` defaults to 60 restarts, which is a library default rather
      // than what generation uses (20 000). An even share is reachable on this
      // layout but not from 60 restarts, and the claim under test is that the
      // search gets there — not how cheaply. Measured: 0 spread from 1 000.
      restarts: 1_000,
      timeBudgetMs: 4_000,
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

/**
 * The shape generation actually produces: 8 teams with a rotating bye pair, so
 * six play each night over three ice times, paired by Phase M itself. Which
 * weekday each night falls on is the only thing these cases vary.
 *
 * Per-weekday game counts come out uneven here — a team's byes do not divide
 * neatly across weekdays — which is the point: it is the proportional target
 * that gets exercised, not an even one.
 */
function slotCadence(weekdayOfNight: number[]) {
  const T = 8;
  const N = weekdayOfNight.length;
  const plays: boolean[][] = Array.from({ length: T }, () => new Array(N).fill(true));
  for (let n = 0; n < N; n++) {
    plays[(2 * n) % T][n] = false;
    plays[(2 * n + 1) % T][n] = false;
  }
  const targets = Array.from({ length: T }, (_, a) =>
    Array.from({ length: T }, (_, b) => (a === b ? 0 : 3)),
  );
  const m = assignMatchups({
    teamCount: T,
    plays,
    nightWeek: weekdayOfNight.map((_, n) => Math.floor(n / 2)),
    nightWeekday: weekdayOfNight,
    targets,
  })!;
  return { T, pairsByNight: m.pairsByNight };
}

/**
 * The arithmetic floor of `slotWeekdaySpread` for a given season: per team and
 * weekday, the spread of the flattest split its game count allows over the ice
 * times those nights actually offer. Computed from `proportionalSplit` — the
 * same function the cost uses — so these tests state a floor rather than a
 * number someone measured once and pasted in.
 */
function weekdayFloor(
  T: number,
  pairsByNight: [number, number][][],
  weekdayOfNight: number[],
  numSlots: number,
) {
  const wds = [...new Set(weekdayOfNight)].sort((a, b) => a - b);
  let floor = 0;
  for (let t = 0; t < T; t++) {
    for (const d of wds) {
      const avail = new Array(numSlots).fill(0);
      let total = 0;
      pairsByNight.forEach((pairs, n) => {
        if (weekdayOfNight[n] !== d) return;
        if (!pairs.some((p) => p[0] === t || p[1] === t)) return;
        total++;
        for (let s = 0; s < Math.min(pairs.length, numSlots); s++) avail[s]++;
      });
      const ideal = proportionalSplit(total, avail);
      floor += Math.max(...ideal) - Math.min(...ideal);
    }
  }
  return floor;
}

/**
 * The three Phase S metrics, recomputed here from the raw assignment rather than
 * taken from `spacingReport`, so these tests pin what `assignSlots` returns and
 * not what a second implementation agrees it means.
 */
function slotMetrics(
  T: number,
  pairsByNight: [number, number][][],
  slotOf: number[][],
  weekdayOfNight: number[],
  numSlots: number,
) {
  const wds = [...new Set(weekdayOfNight)].sort((a, b) => a - b);
  const seq: number[][] = Array.from({ length: T }, () => []);
  const perWd = Array.from({ length: T }, () =>
    wds.map(() => new Array(numSlots).fill(0)),
  );
  pairsByNight.forEach((pairs, n) => {
    pairs.forEach(([a, b], gi) => {
      for (const t of [a, b]) {
        seq[t].push(slotOf[n][gi]);
        perWd[t][wds.indexOf(weekdayOfNight[n])][slotOf[n][gi]]++;
      }
    });
  });
  let weekdaySpread = 0;
  let seasonSpread = 0;
  let streak3 = 0;
  let consec = 0;
  for (let t = 0; t < T; t++) {
    for (const counts of perWd[t]) weekdaySpread += Math.max(...counts) - Math.min(...counts);
    const all = new Array(numSlots).fill(0);
    for (const s of seq[t]) all[s]++;
    seasonSpread += Math.max(...all) - Math.min(...all);
    for (let i = 1; i < seq[t].length; i++) {
      if (seq[t][i] !== seq[t][i - 1]) continue;
      consec++;
      if (i > 1 && seq[t][i] === seq[t][i - 2]) streak3++;
    }
  }
  return { weekdaySpread, seasonSpread, streak3, consec };
}

/**
 * Cadence coverage for the *ice-time* metrics, matching what
 * `assignMatchups weekday split` above does for the pairing split. The rest of
 * the suite is two-weekday throughout, so a surviving two-weekday assumption in
 * Phase S would hide everywhere except here.
 *
 * Each row is stated against two references rather than a pasted number: the
 * arithmetic floor `weekdayFloor` computes for that shape, and the same search
 * run weekday-blind. Together they say the term is both near the best available
 * and the reason the result is there at all.
 *
 * These pass `restarts` low enough and `timeBudgetMs` high enough that the
 * restart count, not the clock, is what stops the search — so unlike the rest of
 * Phase S these numbers are reproducible under either vitest config, and on a
 * slower machine.
 */
describe("assignSlots weekday split", () => {
  const BOUNDED = { restarts: 300, timeBudgetMs: 60_000 };

  const run = (weekdayOfNight: number[], pairs?: [number, number][][]) => {
    const { T, pairsByNight } = pairs
      ? { T: 8, pairsByNight: pairs }
      : slotCadence(weekdayOfNight);
    const opts = {
      teamCount: T,
      pairsByNight,
      slotsPerNight: pairsByNight.map((p) => p.length),
      ...BOUNDED,
    };
    const aware = assignSlots({ ...opts, weekdayOfNight });
    const blind = assignSlots(opts);
    return {
      floor: weekdayFloor(T, pairsByNight, weekdayOfNight, 3),
      aware: slotMetrics(T, pairsByNight, aware, weekdayOfNight, 3),
      blind: slotMetrics(T, pairsByNight, blind, weekdayOfNight, 3),
    };
  };

  it("splits the ice times as evenly as it can within each of three weekdays", () => {
    // Mon/Wed/Fri over 28 nights. Measured: 24 against a floor of 20, where the
    // weekday-blind search of the same season reads 54.
    const wd = Array.from({ length: 28 }, (_, n) => [1, 3, 5][n % 3]);
    const r = run(wd);
    expect(r.aware.weekdaySpread).toBeGreaterThanOrEqual(r.floor);
    expect(r.aware.weekdaySpread).toBeLessThanOrEqual(r.floor + 6);
    // The excess over the floor, not the raw spread: that is the part a search
    // can do anything about, and modelling the weekday at least halves it.
    expect(r.aware.weekdaySpread - r.floor).toBeLessThan(
      (r.blind.weekdaySpread - r.floor) / 2,
    );
    expect(r.aware.streak3).toBe(0);
  });

  it("splits them as evenly within each of two weekdays", () => {
    // The reference cadence's shape. Measured: 17 against a floor of 16, blind 40.
    const wd = Array.from({ length: 28 }, (_, n) => [1, 4][n % 2]);
    const r = run(wd);
    expect(r.aware.weekdaySpread).toBeGreaterThanOrEqual(r.floor);
    expect(r.aware.weekdaySpread).toBeLessThanOrEqual(r.floor + 6);
    // The excess over the floor, not the raw spread: that is the part a search
    // can do anything about, and modelling the weekday at least halves it.
    expect(r.aware.weekdaySpread - r.floor).toBeLessThan(
      (r.blind.weekdaySpread - r.floor) / 2,
    );
    expect(r.aware.streak3).toBe(0);
  });

  it("does not double-count the season share on a single-weekday cadence", () => {
    // With one weekday the per-weekday split *is* the season split, so the two
    // terms say the same thing and the weekday one can add nothing. What it must
    // not do is charge twice and land somewhere the blind search would not: this
    // is the row that would catch a cost that divides by a weekday count of one
    // or double-charges the same deviation.
    const wd = new Array(28).fill(4);
    const r = run(wd);
    expect(r.floor).toBe(0);
    expect(r.aware.weekdaySpread).toBe(0);
    expect(r.aware.weekdaySpread).toBe(r.aware.seasonSpread);
  });

  it("reaches the flattest split allowed when the weekdays run unequally", () => {
    // Mon every week, Thu every other: an even split is arithmetically
    // impossible, so only the proportional target is reachable. Code that aimed
    // for "equal" passes every row above and fails here. Measured: 14 against a
    // floor of 12, blind 26.
    const wd: number[] = [];
    for (let i = 0; wd.length < 28; i++) {
      wd.push(1);
      if (wd.length < 28 && i % 2 === 0) wd.push(4);
    }
    const r = run(wd);
    expect(new Set(wd).size).toBe(2);
    expect(r.aware.weekdaySpread).toBeGreaterThanOrEqual(r.floor);
    expect(r.aware.weekdaySpread).toBeLessThanOrEqual(r.floor + 6);
    // The excess over the floor, not the raw spread: that is the part a search
    // can do anything about, and modelling the weekday at least halves it.
    expect(r.aware.weekdaySpread - r.floor).toBeLessThan(
      (r.blind.weekdaySpread - r.floor) / 2,
    );
    expect(r.aware.streak3).toBe(0);
  });

  it("targets the ice a night actually has, not a uniform share of it", () => {
    // An under-filled night drops its latest slot, so slot 2 runs on fewer
    // nights than 0 and 1 and an equal per-team split stops being possible. The
    // target has to follow availability, which is what `weekdayFloor` — built
    // from the same `proportionalSplit` the cost uses — is asserting here.
    // Two weekdays, so availability and the weekday split interact and the
    // blind control still means something.
    const wd = Array.from({ length: 28 }, (_, n) => [1, 4][n % 2]);
    const full = slotCadence(wd).pairsByNight;
    const pairs = full.map((p, n) => (n % 3 === 0 ? p.slice(0, 2) : p));
    const r = run(wd, pairs);
    // A uniform target would call this shape's ideal a flat split and read a
    // floor of 0; it is 13. Measured: 23 against that floor, blind 43.
    expect(r.floor).toBeGreaterThan(0);
    expect(r.aware.weekdaySpread - r.floor).toBeLessThan(
      (r.blind.weekdaySpread - r.floor) / 2,
    );
  });

  it("still works, and stays season-flat, when no weekdays are given", () => {
    // The option is optional: without it Phase S must produce what every caller
    // predating goal 3 got — a valid permutation per night and a flat season.
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
    expect(slotMetrics(T, pairsByNight, slotOf, wd, 3).seasonSpread).toBe(0);
  });
});
