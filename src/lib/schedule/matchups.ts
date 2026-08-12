/**
 * Phase M — with participation fixed (Phase P decided who plays each night),
 * choose *who plays whom*: pair up each night's playing teams into that night's
 * games.
 *
 * Because every playing team is matched exactly once per night, games-played and
 * the no-team-twice-a-night invariant hold by construction whatever this picks.
 * What's left to optimise is opponent balance — hitting the caller's per-matchup
 * meeting counts exactly — and rematch spacing (#3), which is why the search
 * scores both together and treats the meeting counts as effectively hard.
 */

import { SPACING_W, weekdayExcessScaled } from "./spacing";

/** Meeting-count error dominates spacing: opponent balance is not tradeable. */
const MULT_W = 50_000;
/**
 * How hard to push each pairing's meetings towards an even weekday split, per
 * unit of `pairingWeekdayExcess` — the number `spacingReport` prints, so the
 * cost this search minimises and the metric it is judged on cannot drift apart.
 *
 * ⚠️ Deliberately an order of magnitude *below* the rematch weights (40–120), so
 * the descent can only straighten a split where rematch spacing is indifferent.
 * Weekday split is the lower-priority goal and this is what keeps it there. The
 * seeding term below, not this weight, is what does the heavy lifting.
 *
 * Measured on the reference season: 1, 5 and 8 all reach the same schedule
 * (`pairingWeekdayExcess` 8, all four rematch metrics 0); at 10 the search buys
 * a perfect weekday split for 2 `rematchConsecWeek` violations, which is the
 * trade the league has already rejected. 5 sits mid-band rather than against
 * that cliff. Anything above it needs the rematch metrics re-measured — and
 * raising it past `oneOff`'s `CHURN_W.SPACING` scale means re-checking mid-season
 * repair churn in the same change (`SCHEDULE_HANDOFF.md` §5).
 */
const WD_SPLIT_W = 5;
/**
 * The same goal in `seedGreedy`'s units, which are its own — `remaining * 1000`
 * and a recency term topping out at 600. Sized to outrank recency but never the
 * outstanding meeting count, so the seed still hands the descent a matchup
 * multiset it can balance.
 *
 * This is where the weekday split is actually won. The descent starts from this
 * seed, and a weekday-blind seed lands in a local optimum it can only leave by
 * paying in rematch spacing: seeding blind and leaving the descent to it costs
 * either 12 of 28 pairings off ideal or a broken rematch metric, depending on
 * how hard `WD_SPLIT_W` pushes. Seeding aware, it is 2 of 28 with rematch at 0.
 */
const WD_SPLIT_SEED_W = 500;
/**
 * Perfect matchings of 2k teams number (2k−1)!! — 945 at ten teams a night,
 * 10395 at twelve. Past this the search would be choosing from an arbitrary
 * prefix of the enumeration rather than the real option set, which reliably
 * misses the meeting-count targets; better to decline and let the caller fall
 * back to a planner that handles that shape.
 */
const MAX_MATCHINGS = 1_000;

/**
 * A night the caller has already decided something about. `fixed` pins it to one
 * matching (a night that's been played, or is otherwise off limits); `require`
 * forces a pair to appear but leaves the rest of the night free.
 */
export type NightConstraint =
  | { kind: "fixed"; pairs: [number, number][] }
  | { kind: "require"; pairs: [number, number][] };

export type MatchupOptions = {
  teamCount: number;
  /** `plays[team][night]` from Phase P. */
  plays: boolean[][];
  /** Calendar-week index per night. */
  nightWeek: number[];
  /** Weekday per night (any stable encoding). */
  nightWeekday: number[];
  /** Symmetric `targets[a][b]`: how many times that pair should meet. */
  targets: number[][];
  seed?: number;
  /** Descent restarts. Generation is once-per-season, so exactness wins. */
  restarts?: number;
  /** Wall-clock cap. On expiry the best choice found so far is returned. */
  timeBudgetMs?: number;
  /** Per-night pins/requirements; absent or null leaves the night free. */
  nightConstraints?: (NightConstraint | null)[];
  /**
   * Extra per-night cost on top of the pair costs. Repairing a published
   * schedule uses it to prefer leaving nights alone; generation doesn't need it.
   * Evaluated once per candidate up front, so it must be a pure function.
   *
   * Keep it well under `MULT_W` — opponent balance is not tradeable against
   * churn.
   */
  nightPenalty?: (night: number, pairs: [number, number][]) => number;
  /**
   * Seed the first restart from these matchings instead of `seedGreedy`. A night
   * whose matching isn't among its candidates falls back to the greedy pick.
   */
  initial?: ([number, number][] | null)[];
};

export type MatchupResult = {
  /** Per night, the team-index pairs playing that night. */
  pairsByNight: [number, number][][];
  /** Σ (actual − target)² over all pairs; 0 means opponent balance is exact. */
  multiplicityError: number;
  spacingCost: number;
};

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Every way to pair up `teams` (must be even-sized), capped at `limit`. */
function perfectMatchings(teams: number[], limit: number): [number, number][][] {
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

/** Order-independent identity of a matching, for comparing two of them. */
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

  // Weekday frame for the pairing-split term, read off the calendar rather than
  // taken as a parameter, so any cadence works: one weekday, three or more, and
  // weekdays with unequal night counts (where the flattest split is uneven).
  const weekdays = [...new Set(nightWeekday.slice(0, N))].sort((a, b) => a - b);
  const wIndex = new Map(weekdays.map((d, i) => [d, i]));
  const D = weekdays.length;
  const nightsPerWd = new Array<number>(D).fill(0);
  for (let n = 0; n < N; n++) nightsPerWd[wIndex.get(nightWeekday[n])!]++;
  // `weekdayExcessScaled` returns an exact integer scaled by N²; divide by it
  // once here so `WD_SPLIT_W` is expressed against the reported metric.
  const wdScale = N > 0 ? WD_SPLIT_W / (N * N) : 0;
  // Reused across pairCost calls — it runs once per candidate matching per night
  // per pass, so an allocation here would be the hot path.
  const wdCounts = new Array<number>(D).fill(0);
  /**
   * `weekdayExcessScaled` over a counts vector, memoised on the vector itself.
   * A pairing meets a handful of times over two or three weekdays, so the
   * descent asks the same few hundred questions millions of times; caching the
   * shared helper's answer rather than reimplementing it keeps the cost the
   * search minimises identical to the metric the report prints.
   *
   * The key packs each count into five bits, so it stays an exact integer up to
   * ten weekdays. A wider cadence, or a pairing meeting 32 times on one weekday,
   * falls through to the uncached call rather than colliding.
   */
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
  /**
   * The most meetings any flattest split may put on weekday `d` — the ceiling
   * counterpart of `proportionalSplit`, which hands a leftover meeting to one
   * weekday or another arbitrarily. The greedy must allow either, or every
   * odd-total pairing would be pushed onto the same weekday and the split it
   * chases would be one no schedule can hold.
   *
   * Integer arithmetic throughout, for the same reason `proportionalSplit` is.
   */
  const weekdayAllowance = (total: number, d: number): number =>
    Math.ceil((total * nightsPerWd[d]) / N);

  // Candidate matchings per night.
  const options: [number, number][][][] = [];
  for (let n = 0; n < N; n++) {
    const constraint = nightConstraints?.[n] ?? null;
    // A pinned night is a one-candidate night. `descend` skips those, so its
    // pairs carry through untouched while still counting toward every pair's
    // meeting total — which is exactly what "already played" should mean.
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
    // Nothing satisfies the requirement — over-constrained, same as the other
    // shapes this phase declines rather than approximates.
    if (kept.length === 0) return null;
    options.push(kept);
  }

  // Penalties depend only on (night, candidate), so pay for them once rather
  // than on every evaluation inside the descent.
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
  // Per-pair state: meeting nights (kept sorted) and its current cost.
  const meets = new Map<number, number[]>();
  const pairOf = new Map<number, [number, number]>();
  for (let a = 0; a < T; a++) {
    for (let b = a + 1; b < T; b++) {
      const k = pairKey(a, b);
      meets.set(k, []);
      pairOf.set(k, [a, b]);
    }
  }

  const pairCost = (k: number): number => {
    const [a, b] = pairOf.get(k)!;
    const ns = meets.get(k)!;
    const diff = ns.length - (targets[a]?.[b] ?? 0);
    let c = MULT_W * diff * diff;
    // How far this pairing's meetings sit from an even spread over the weekdays,
    // against the flattest split the calendar's night counts allow. Identically
    // zero on a one-weekday cadence, so skip the work there.
    if (D > 1) {
      wdCounts.fill(0);
      for (const n of ns) wdCounts[wIndex.get(nightWeekday[n])!]++;
      c += wdScale * cachedExcess(wdCounts);
    }
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

  /** Cost over just the pairs any of a night's candidate matchings could touch. */
  const localCost = (keys: number[]): number => {
    let c = 0;
    for (const k of keys) c += pairCost(k);
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
          // Prefer pairs still owing meetings, and ones we haven't seen lately.
          v -= remaining * 1000;
          const last = ns.length ? ns[ns.length - 1] : -1000;
          v += Math.max(0, 20 - (n - last)) * 30;
          // Steer the seed towards an even weekday split too. Without this the
          // descent starts from a weekday-blind local optimum and can only leave
          // it by paying in rematch spacing, which is not tradeable.
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

  const descend = () => {
    let improved = true;
    let pass = 0;
    while (improved && pass++ < 60) {
      improved = false;
      if (Date.now() > deadline) return;
      for (let n = 0; n < N; n++) {
        if (options[n].length < 2) continue;
        const cur = choice[n];
        // Pairs any candidate could touch — the cost delta is confined to these.
        const keySet = new Set<number>();
        for (const m of options[n]) for (const [a, b] of m) keySet.add(pairKey(a, b));
        const keys = [...keySet];
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
    }
  };

  /** Start from the caller's incumbent, so the descent only moves off it for a
   * strict gain — the low-churn repairs depend on this. */
  const seedInitial = () => {
    choice.fill(0);
    for (const ns of meets.values()) ns.length = 0;
    for (let n = 0; n < N; n++) applyNight(n, initialIdx[n] ?? 0);
  };

  let bestChoice: number[] | null = null;
  let bestTotal = Number.POSITIVE_INFINITY;
  for (let r = 0; r < Math.max(1, restarts); r++) {
    if (r > 0 && Date.now() > deadline) break;
    if (r === 0 && initial) seedInitial();
    else seedGreedy(r === 0 ? 0 : 400);
    descend();
    const total = totalCost();
    if (total < bestTotal) {
      bestTotal = total;
      bestChoice = [...choice];
    }
    if (bestTotal === 0) break;
  }
  if (!bestChoice) return null;

  // Rebuild state on the winning choice so the reported metrics match it.
  for (const ns of meets.values()) ns.length = 0;
  for (let n = 0; n < N; n++) applyNight(n, bestChoice[n]);

  let multiplicityError = 0;
  for (const [k, ns] of meets) {
    const [a, b] = pairOf.get(k)!;
    const diff = ns.length - (targets[a]?.[b] ?? 0);
    multiplicityError += diff * diff;
  }
  // Net the per-night penalties out too, or `spacingCost` silently reports churn
  // as though it were bad spacing.
  let penaltyTotal = 0;
  for (let n = 0; n < N; n++) penaltyTotal += penalty[n][bestChoice[n]];
  return {
    pairsByNight: bestChoice.map((idx, n) => options[n][idx]),
    multiplicityError,
    spacingCost: bestTotal - MULT_W * multiplicityError - penaltyTotal,
  };
}
