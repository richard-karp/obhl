// Phase M: who plays whom. Meeting counts are effectively hard; rematch spacing is scored.

import { SPACING_W, weekdayExcessScaled } from "./spacing";
import { mulberry32 } from "./rng";

/** ⛔ Meeting-count error dominates spacing: opponent balance is not tradeable. Moves with
 *  `SPACING_W` and `oneOff.ts`'s `CHURN_W`; `weightCoupling.test.ts` pins the ratios. */
export const MULT_W = 50_000;
// ⛔ An order of magnitude below the rematch weights (40–120): at 10 it bought the weekday
// split with rematch breaches; `compoundPass` wins it instead. RUNBOOK.md, _Schedule generator_.
const WD_SPLIT_W = 5;
// ⚠️ In `seedGreedy`'s units: must outrank its recency term (≤600), never the owed-meeting
// term (×1000). A weekday-blind seed strands the descent where only rematch spacing can pay.
const WD_SPLIT_SEED_W = 500;
// ⚠️ Past this (945 matchings at ten teams a night, 10395 at twelve) the enumeration is an
// arbitrary prefix that misses meeting targets, so decline and let the caller fall back.
const MAX_MATCHINGS = 1_000;
// Past this a night pair is skipped, so a wide cadence can't spend the budget here.
const MAX_JOINT_MATCHINGS = 5_000;

/** `fixed` pins a night to one matching (played, or off limits); `require` forces a pair in. */
export type NightConstraint =
  | { kind: "fixed"; pairs: [number, number][] }
  | { kind: "require"; pairs: [number, number][] };

export type MatchupOptions = {
  teamCount: number;
  plays: boolean[][];
  nightWeek: number[];
  /** Weekday per night (any stable encoding). */
  nightWeekday: number[];
  /** Symmetric `targets[a][b]`: how many times that pair should meet. */
  targets: number[][];
  seed?: number;
  restarts?: number;
  /** Wall-clock cap. On expiry the best choice found so far is returned. */
  timeBudgetMs?: number;
  nightConstraints?: (NightConstraint | null)[];
  /** Extra per-night cost (repair's churn), evaluated once up front, so it must be pure.
   *  ⚠️ Keep it well under `MULT_W`: opponent balance is not tradeable against churn. */
  nightPenalty?: (night: number, pairs: [number, number][]) => number;
  /** Seeds the first restart; a night whose matching isn't a candidate falls back to greedy. */
  initial?: ([number, number][] | null)[];
};

export type MatchupResult = {
  pairsByNight: [number, number][][];
  /** Σ (actual − target)² over all pairs; 0 means opponent balance is exact. */
  multiplicityError: number;
  spacingCost: number;
};

/** Every way to pair up `teams` (must be even-sized), capped at `limit`. */
function perfectMatchings(
  teams: number[],
  limit: number,
): [number, number][][] {
  const out: [number, number][][] = [];
  const cur: [number, number][] = [];
  const used = new Array(teams.length).fill(false);
  const rec = (): boolean => {
    if (out.length >= limit) return false;
    let first = -1;
    for (let i = 0; i < teams.length; i++) {
      if (!used[i]) {
        first = i;
        break;
      }
    }
    if (first < 0) {
      out.push(cur.map((p) => [p[0], p[1]] as [number, number]));
      return out.length < limit;
    }
    used[first] = true;
    for (let j = first + 1; j < teams.length; j++) {
      if (used[j]) continue;
      used[j] = true;
      cur.push([teams[first], teams[j]]);
      const more = rec();
      cur.pop();
      used[j] = false;
      if (!more) {
        used[first] = false;
        return false;
      }
    }
    used[first] = false;
    return true;
  };
  rec();
  return out;
}

function matchingKey(m: [number, number][]): string {
  return m
    .map(([a, b]) => (a < b ? `${a}-${b}` : `${b}-${a}`))
    .sort()
    .join(",");
}

const hasPair = (m: [number, number][], p: [number, number]): boolean =>
  m.some(([a, b]) => (a === p[0] && b === p[1]) || (a === p[1] && b === p[0]));

export function assignMatchups(opts: MatchupOptions): MatchupResult | null {
  const {
    teamCount: T,
    plays,
    nightWeek,
    nightWeekday,
    targets,
    seed = 1,
    restarts = 12,
    timeBudgetMs = 600,
    nightConstraints,
    nightPenalty,
    initial,
  } = opts;
  const N = nightWeek.length;
  const rnd = mulberry32(seed);
  const deadline = Date.now() + timeBudgetMs;

  const weekdays = [...new Set(nightWeekday.slice(0, N))].sort((a, b) => a - b);
  const wIndex = new Map(weekdays.map((d, i) => [d, i]));
  const D = weekdays.length;
  const nightsPerWd = new Array<number>(D).fill(0);
  const nightsOfWd: number[][] = weekdays.map(() => []);
  for (let n = 0; n < N; n++) {
    const d = wIndex.get(nightWeekday[n])!;
    nightsPerWd[d]++;
    nightsOfWd[d].push(n);
  }
  const wdScale = N > 0 ? WD_SPLIT_W / (N * N) : 0;
  // Reused: `pairCost` runs per candidate per night per pass, so allocating here is the hot path.
  const wdCounts = new Array<number>(D).fill(0);
  /** Memoises the shared helper rather than reimplementing it, so cost and report agree.
   *  ⚠️ Keys pack five bits a count: exact up to ten weekdays and 31 meetings, else uncached. */
  const excessCache = new Map<number, number>();
  const cacheable = D <= 10;
  const cachedExcess = (counts: number[]): number => {
    if (!cacheable) return weekdayExcessScaled(counts, nightsPerWd);
    let key = 0;
    for (let d = 0; d < D; d++) {
      if (counts[d] >= 32) return weekdayExcessScaled(counts, nightsPerWd);
      key = key * 32 + counts[d];
    }
    let v = excessCache.get(key);
    if (v === undefined) {
      v = weekdayExcessScaled(counts, nightsPerWd);
      excessCache.set(key, v);
    }
    return v;
  };

  const countOnWeekday = (ns: number[], d: number): number => {
    let c = 0;
    for (const n of ns) if (wIndex.get(nightWeekday[n])! === d) c++;
    return c;
  };
  /** Ceiling of any flattest split on `d`. ⚠️ A ceiling, not `proportionalSplit`, which hands
   *  a leftover to one weekday: every odd-total pairing would chase the same one. */
  const weekdayAllowance = (total: number, d: number): number =>
    Math.ceil((total * nightsPerWd[d]) / N);
  const weekdayFloor = (total: number, d: number): number =>
    Math.floor((total * nightsPerWd[d]) / N);

  const options: [number, number][][][] = [];
  for (let n = 0; n < N; n++) {
    const constraint = nightConstraints?.[n] ?? null;
    // A one-candidate night: `descend` skips it, but its pairs still count toward meeting totals.
    if (constraint?.kind === "fixed") {
      options.push([constraint.pairs]);
      continue;
    }
    const playing: number[] = [];
    for (let t = 0; t < T; t++) if (plays[t][n]) playing.push(t);
    if (playing.length % 2 !== 0) return null;
    if (playing.length === 0) {
      options.push([[]]);
      continue;
    }
    // Ask for one more than the cap so a truncated enumeration is detectable.
    const ms = perfectMatchings(playing, MAX_MATCHINGS + 1);
    if (ms.length === 0 || ms.length > MAX_MATCHINGS) return null;
    const kept =
      constraint?.kind === "require"
        ? ms.filter((m) => constraint.pairs.every((p) => hasPair(m, p)))
        : ms;
    if (kept.length === 0) return null;
    options.push(kept);
  }

  const penalty: number[][] = options.map((ms, n) =>
    nightPenalty ? ms.map((m) => nightPenalty(n, m)) : ms.map(() => 0),
  );
  const initialIdx: (number | null)[] = options.map((ms, n) => {
    const want = initial?.[n];
    if (!want) return null;
    const key = matchingKey(want);
    const i = ms.findIndex((m) => matchingKey(m) === key);
    return i >= 0 ? i : null;
  });

  const pairKey = (a: number, b: number) => (a < b ? a * T + b : b * T + a);
  const meets = new Map<number, number[]>();
  const pairOf = new Map<number, [number, number]>();
  for (let a = 0; a < T; a++) {
    for (let b = a + 1; b < T; b++) {
      const k = pairKey(a, b);
      meets.set(k, []);
      pairOf.set(k, [a, b]);
    }
  }

  const keysOfNight: number[][] = options.map((ms) => {
    const set = new Set<number>();
    for (const m of ms) for (const [a, b] of m) set.add(pairKey(a, b));
    return [...set];
  });
  // ⚠️ Empty on a one-weekday cadence, which `compoundPass` never runs on: change both together.
  const candKeys: number[][][] =
    D > 1
      ? options.map((ms) =>
          ms.map((m) => m.map(([a, b]) => pairKey(a, b)).sort((x, y) => x - y)),
        )
      : [];
  const withPair: Map<number, number[]>[] = candKeys.map((ks) => {
    const byKey = new Map<number, number[]>();
    ks.forEach((keys, idx) => {
      for (const k of keys) {
        const list = byKey.get(k);
        if (list) list.push(idx);
        else byKey.set(k, [idx]);
      }
    });
    return byKey;
  });
  const wantBuf = new Array<number>(T);
  const gotBuf = new Array<number>(T);
  const mergeKeys = (out: number[], x: number[], y: number[]): number => {
    let i = 0;
    let j = 0;
    let o = 0;
    while (i < x.length && j < y.length)
      out[o++] = x[i] <= y[j] ? x[i++] : y[j++];
    while (i < x.length) out[o++] = x[i++];
    while (j < y.length) out[o++] = y[j++];
    return o;
  };

  /** The rematch part of `pairCost`, split out so there is still one definition. */
  const rematchCost = (ns: number[]): number => {
    let c = 0;
    for (let i = 1; i < ns.length; i++) {
      const prev = ns[i - 1];
      const cur = ns[i];
      if (cur - prev === 1) c += SPACING_W.rematchAdjNight;
      const wa = nightWeek[prev];
      const wb = nightWeek[cur];
      if (wa === wb) c += SPACING_W.rematchSameWeek;
      else if (wb - wa === 1) {
        c += SPACING_W.rematchConsecWeek;
        if (nightWeekday[cur] === nightWeekday[prev]) {
          c += SPACING_W.rematchConsecWeekSameDay;
        }
      }
    }
    return c;
  };

  const pairCost = (k: number): number => {
    const [a, b] = pairOf.get(k)!;
    const ns = meets.get(k)!;
    const diff = ns.length - (targets[a]?.[b] ?? 0);
    let c = MULT_W * diff * diff;
    if (D > 1) {
      wdCounts.fill(0);
      for (const n of ns) wdCounts[wIndex.get(nightWeekday[n])!]++;
      c += wdScale * cachedExcess(wdCounts);
    }
    return c + rematchCost(ns);
  };

  const addMeeting = (a: number, b: number, n: number) => {
    const ns = meets.get(pairKey(a, b))!;
    let i = ns.length;
    while (i > 0 && ns[i - 1] > n) i--;
    ns.splice(i, 0, n);
  };
  const removeMeeting = (a: number, b: number, n: number) => {
    const ns = meets.get(pairKey(a, b))!;
    const i = ns.indexOf(n);
    if (i >= 0) ns.splice(i, 1);
  };

  const choice = new Array<number>(N).fill(0);
  const applyNight = (n: number, idx: number) => {
    choice[n] = idx;
    for (const [a, b] of options[n][idx]) addMeeting(a, b, n);
  };
  const clearNight = (n: number) => {
    for (const [a, b] of options[n][choice[n]]) removeMeeting(a, b, n);
  };

  const totalCost = (): number => {
    let c = 0;
    for (const k of meets.keys()) c += pairCost(k);
    for (let n = 0; n < N; n++) c += penalty[n][choice[n]];
    return c;
  };

  const localCost = (keys: number[]): number => {
    let c = 0;
    for (const k of keys) c += pairCost(k);
    return c;
  };

  const localRematch = (keys: number[]): number => {
    let c = 0;
    for (const k of keys) c += rematchCost(meets.get(k)!);
    return c;
  };

  const splitCost = (): number => {
    if (D < 2) return 0;
    let c = 0;
    for (const ns of meets.values()) {
      wdCounts.fill(0);
      for (const n of ns) wdCounts[wIndex.get(nightWeekday[n])!]++;
      c += wdScale * cachedExcess(wdCounts);
    }
    return c;
  };

  const seedGreedy = (jitter: number) => {
    choice.fill(0);
    for (const ns of meets.values()) ns.length = 0;
    for (let n = 0; n < N; n++) {
      const d = D > 1 ? wIndex.get(nightWeekday[n])! : 0;
      let bestIdx = 0;
      let bestVal = Number.POSITIVE_INFINITY;
      for (let idx = 0; idx < options[n].length; idx++) {
        let v = 0;
        for (const [a, b] of options[n][idx]) {
          const k = pairKey(a, b);
          const ns = meets.get(k)!;
          const total = targets[a]?.[b] ?? 0;
          const remaining = total - ns.length;
          v -= remaining * 1000;
          const last = ns.length ? ns[ns.length - 1] : -1000;
          v += Math.max(0, 20 - (n - last)) * 30;
          if (D > 1 && countOnWeekday(ns, d) >= weekdayAllowance(total, d)) {
            v += WD_SPLIT_SEED_W;
          }
        }
        v += rnd() * jitter;
        if (v < bestVal) {
          bestVal = v;
          bestIdx = idx;
        }
      }
      applyNight(n, bestIdx);
    }
  };

  const tryJoint = (k: number, n1: number, n2: number): boolean => {
    const cur1 = choice[n1];
    const cur2 = choice[n2];
    const with2 = withPair[n2].get(k)!;
    const keys = [...new Set([...keysOfNight[n1], ...keysOfNight[n2]])];
    const curVal = localCost(keys) + penalty[n1][cur1] + penalty[n2][cur2];
    const curRematch = localRematch(keys);
    // Every joint choice must hold the same games as now, dealt differently: anything else
    // moves a meeting count, which `MULT_W` prices out, so it is filtered, not scored.
    const wantLen = mergeKeys(wantBuf, candKeys[n1][cur1], candKeys[n2][cur2]);
    clearNight(n1);
    clearNight(n2);
    let best1 = -1;
    let best2 = -1;
    // Seeded with the incumbent: only a strict gain is taken, or restarts flip between ties.
    let bestVal = curVal - 1e-9;
    for (let i1 = 0; i1 < options[n1].length; i1++) {
      if (candKeys[n1][i1].includes(k)) continue;
      for (const [a, b] of options[n1][i1]) addMeeting(a, b, n1);
      for (const i2 of with2) {
        const len = mergeKeys(gotBuf, candKeys[n1][i1], candKeys[n2][i2]);
        let same = len === wantLen;
        for (let z = 0; same && z < len; z++) same = gotBuf[z] === wantBuf[z];
        if (!same) continue;
        for (const [a, b] of options[n2][i2]) addMeeting(a, b, n2);
        // ⚠️ Spacing is a filter, not a term: one `rematchConsecWeek` and the residual weekday
        // excess can tie at 40, and taking that trade is what the league rejected.
        const rem = localRematch(keys);
        const v = localCost(keys) + penalty[n1][i1] + penalty[n2][i2];
        for (const [a, b] of options[n2][i2]) removeMeeting(a, b, n2);
        if (rem <= curRematch + 1e-9 && v < bestVal) {
          bestVal = v;
          best1 = i1;
          best2 = i2;
        }
      }
      for (const [a, b] of options[n1][i1]) removeMeeting(a, b, n1);
    }
    // The incumbent (the pair still on `n1`) is not a candidate, so a miss puts it back.
    applyNight(n1, best1 < 0 ? cur1 : best1);
    applyNight(n2, best2 < 0 ? cur2 : best2);
    return best1 >= 0;
  };

  /** Re-chooses two nights together. ⚠️ Each half alone breaks a meeting count (`MULT_W`), so
   *  `descend` refuses it at any weight; raising `WD_SPLIT_W` only broke something else. */
  const compoundPass = (): boolean => {
    if (D < 2) return false;
    for (const [k, ns] of meets) {
      if (ns.length === 0) continue;
      wdCounts.fill(0);
      for (const n of ns) wdCounts[wIndex.get(nightWeekday[n])!]++;
      if (cachedExcess(wdCounts) <= 0) continue;
      const [a, b] = pairOf.get(k)!;
      const total = ns.length;
      // ⚠️ Read `wdCounts` now: `pairCost` shares the buffer, and `ns` is the live list.
      const under: number[] = [];
      const over = new Set<number>();
      for (let d = 0; d < D; d++) {
        if (wdCounts[d] > weekdayFloor(total, d)) over.add(d);
        if (wdCounts[d] < weekdayAllowance(total, d)) under.push(d);
      }
      const from = ns.filter((n) => over.has(wIndex.get(nightWeekday[n])!));
      for (const n1 of from) {
        if (options[n1].length < 2) continue;
        for (const d of under) {
          for (const n2 of nightsOfWd[d]) {
            if (n2 === n1 || !plays[a][n2] || !plays[b][n2]) continue;
            const with2 = withPair[n2].get(k);
            if (!with2 || options[n2].length < 2) continue;
            if (hasPair(options[n2][choice[n2]], [a, b])) continue;
            if (options[n1].length * with2.length > MAX_JOINT_MATCHINGS)
              continue;
            if (Date.now() > deadline) return false;
            // Accepting invalidates every list above: return, and rescan next pass.
            if (tryJoint(k, n1, n2)) return true;
          }
        }
      }
    }
    return false;
  };

  const descend = () => {
    let improved = true;
    let pass = 0;
    while (improved && pass++ < 60) {
      improved = false;
      if (Date.now() > deadline) return;
      for (let n = 0; n < N; n++) {
        if (options[n].length < 2) continue;
        const cur = choice[n];
        const keys = keysOfNight[n];
        const curVal = localCost(keys) + penalty[n][cur];
        clearNight(n);
        let bestIdx = cur;
        let bestVal = Number.POSITIVE_INFINITY;
        for (let idx = 0; idx < options[n].length; idx++) {
          for (const [a, b] of options[n][idx]) addMeeting(a, b, n);
          const v = localCost(keys) + penalty[n][idx];
          for (const [a, b] of options[n][idx]) removeMeeting(a, b, n);
          if (v < bestVal) {
            bestVal = v;
            bestIdx = idx;
          }
        }
        applyNight(n, bestIdx);
        // Only a strict gain counts — equal-cost flips would loop forever.
        if (bestVal < curVal - 1e-9) improved = true;
      }
      if (!improved) improved = compoundPass();
    }
  };

  /** Starts from the incumbent: low-churn repairs rely on moving only for a strict gain. */
  const seedInitial = () => {
    choice.fill(0);
    for (const ns of meets.values()) ns.length = 0;
    for (let n = 0; n < N; n++) applyNight(n, initialIdx[n] ?? 0);
  };

  let bestChoice: number[] | null = null;
  let bestTotal = Number.POSITIVE_INFINITY;
  // Everything but the weekday split, at `pairCost`'s prices.
  let bestPrimary = Number.POSITIVE_INFINITY;
  for (let r = 0; r < Math.max(1, restarts); r++) {
    if (r > 0 && Date.now() > deadline) break;
    if (r === 0 && initial) seedInitial();
    else seedGreedy(r === 0 ? 0 : 400);
    descend();
    const total = totalCost();
    // ⚠️ Ranked on two keys, not the sum: 20 units of weekday excess and one
    // `rematchConsecWeek` both cost 40, so a sum can sell spacing for split.
    const primary = total - splitCost();
    const better =
      primary < bestPrimary - 1e-9 ||
      (primary < bestPrimary + 1e-9 && total < bestTotal - 1e-9);
    if (better) {
      bestPrimary = primary;
      bestTotal = total;
      bestChoice = [...choice];
    }
    if (bestTotal === 0) break;
  }
  if (!bestChoice) return null;

  for (const ns of meets.values()) ns.length = 0;
  for (let n = 0; n < N; n++) applyNight(n, bestChoice[n]);

  let multiplicityError = 0;
  for (const [k, ns] of meets) {
    const [a, b] = pairOf.get(k)!;
    const diff = ns.length - (targets[a]?.[b] ?? 0);
    multiplicityError += diff * diff;
  }
  // Net the penalties out, or `spacingCost` reports churn as bad spacing.
  let penaltyTotal = 0;
  for (let n = 0; n < N; n++) penaltyTotal += penalty[n][bestChoice[n]];
  return {
    pairsByNight: bestChoice.map((idx, n) => options[n][idx]),
    multiplicityError,
    spacingCost: bestTotal - MULT_W * multiplicityError - penaltyTotal,
  };
}
