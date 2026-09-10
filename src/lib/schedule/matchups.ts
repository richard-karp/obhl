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
 * Measured on the reference season *before* `compoundPass` existed: 1, 5 and 8
 * all reached the same schedule (`pairingWeekdayExcess` 8, all four rematch
 * metrics 0); at 10 the search bought a perfect weekday split for 2
 * `rematchConsecWeek` violations, which is the trade the league has already
 * rejected. That cliff is why the split is now won by a *move* the descent could
 * not represent rather than by weight — see `compoundPass`. 5 sits mid-band.
 * Anything above it needs the rematch metrics re-measured — and raising it past
 * `oneOff`'s `CHURN_W.SPACING` scale means re-checking mid-season repair churn
 * in the same change (`SCHEDULE_HANDOFF.md` §5).
 */
const WD_SPLIT_W = 5;
/**
 * The same goal in `seedGreedy`'s units, which are its own — `remaining * 1000`
 * and a recency term topping out at 600. Sized to outrank recency but never the
 * outstanding meeting count, so the seed still hands the descent a matchup
 * multiset it can balance.
 *
 * This is where most of the weekday split is won. The descent starts from this
 * seed, and a weekday-blind seed lands in a local optimum it can only leave by
 * paying in rematch spacing: seeding blind and leaving the descent to it costs
 * either 12 of 28 pairings off ideal or a broken rematch metric, depending on
 * how hard `WD_SPLIT_W` pushes. Seeding aware, it is 2 of 28 with rematch at 0,
 * and `compoundPass` clears the last two — which are structural, not a matter of
 * how hard anything here pushes.
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
 * Ceiling on the joint choices the compound pass will sift through for one pair
 * of nights: every matching of the first against only those of the second that
 * contain the meeting being moved. Six teams a night is 15 against 3, so 45;
 * ten is 945 against 105, and that one is meant to be declined — past this the
 * night pair is skipped, so a wide cadence cannot spend the whole wall-clock
 * budget here. The single-night descent still covers those nights.
 */
const MAX_JOINT_MATCHINGS = 5_000;
/**
 * How far apart two nights may sit and still count as *the same matching twice*.
 * Six is the span the measurement that motivated this pass used: on a six-team,
 * one-weeknight season Phase M's descent lands on a five-night 1-factorisation
 * cycle, so every night repeats the one five before it and a ±6 window sees all
 * of them. Widening it costs nothing here but starts calling honest variety a
 * repeat on a longer cadence.
 */
const PERIOD_SPAN = 6;
/**
 * How many nights `periodicPass` re-deals together. **Four is a floor, not a
 * tuning knob.** With every team playing every night the union of *two* nights'
 * matchings is a 6-cycle and the union of *three* is a prism, and each of those
 * admits exactly one decomposition into perfect matchings — so a two- or
 * three-night re-deal can only permute the matchings the nights already hold,
 * never invent one. Four nights union to K6 minus a matching, which has exactly
 * two decompositions: the incumbent and one sharing no factor with it. Four is
 * the smallest window that can produce a matching the season did not already
 * have, which is the whole point. Smaller moves are still reachable inside it —
 * a night may keep its current matching.
 */
const PERIOD_WINDOW = 4;
/**
 * Ceiling on the candidates one window's re-deal may examine, so a wide cadence
 * cannot spend the whole wall-clock budget here. Six teams a night has 15
 * matchings, and `PERIOD_WINDOW` is 4, so before the union multiset prunes
 * anything the window can reach 15 + 15² + 15³ + 15⁴ = 54,240 — ABOVE this cap.
 * Pruning is what keeps it under in practice: measured max 1,335 examined at six
 * teams a night. ⚠️ The first shape where the cap actually binds is EIGHT teams,
 * not ten — measured 48 truncations on an 8-team/40-night season. A truncated
 * window simply keeps its current deal, so the result is a missed improvement,
 * never an invalid schedule. The cap is on
 * candidates *examined* rather than on deals found, because on a wide night the
 * sub-multiset test is the work and nearly all of it fails.
 */
const MAX_PERIOD_NODES = 20_000;

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
  /**
   * Run the anti-periodicity compound pass (`periodicPass`). Off by default:
   * generation turns it on only for the seasons that cannot get their clustering
   * broken by reordering nights afterwards, and the mid-season repair never
   * wants it — it re-chooses four nights at a time, which is churn.
   */
  breakPeriodicity?: boolean;
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
    breakPeriodicity = false,
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
  // The same nights, grouped — the compound pass below picks the night that
  // *receives* a meeting by weekday, so it needs the members, not just the count.
  const nightsOfWd: number[][] = weekdays.map(() => []);
  for (let n = 0; n < N; n++) {
    const d = wIndex.get(nightWeekday[n])!;
    nightsPerWd[d]++;
    nightsOfWd[d].push(n);
  }
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
  /** The floor to that ceiling: the fewest any flattest split may put on `d`. */
  const weekdayFloor = (total: number, d: number): number =>
    Math.floor((total * nightsPerWd[d]) / N);

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

  // Pairs any of a night's candidate matchings could touch: re-choosing that
  // night moves cost only among these. Fixed once `options` is, so it is built
  // here rather than per pass, and both descents below share the one copy.
  const keysOfNight: number[][] = options.map((ms) => {
    const set = new Set<number>();
    for (const m of ms) for (const [a, b] of m) set.add(pairKey(a, b));
    return [...set];
  });
  // The same candidates indexed two more ways, both for the compound pass:
  // each candidate's pairs as sorted keys, so two nights' games can be compared
  // as multisets, and per pair the candidates that contain it, so the receiving
  // night is enumerated over the few matchings that can take the meeting rather
  // than over all of them.
  //
  // Skipped entirely on a one-weekday cadence, where `compoundPass` returns at
  // its first line: at the enumeration ceiling this is a thousand candidates a
  // night indexed twice over, and every mid-season repair pays for it four times.
  //
  // `periodicPass` reads the same index, so a one-weekday season builds it too
  // once that pass is on — which is the shape it exists for.
  const wantsPeriodic = breakPeriodicity && N >= PERIOD_WINDOW;
  // One source for "does anything need the per-candidate key lists", so the two
  // consumers cannot drift into a shape where `candKeys` is built and
  // `withPair` is not — `tryJoint` would then hit `withPair[n2].get(k)!` on
  // undefined. Unreachable today only because `compoundPass` returns at D < 2.
  const wantsJoint = D > 1;
  const candKeys: number[][][] =
    wantsJoint || wantsPeriodic
      ? options.map((ms) =>
          ms.map((m) => m.map(([a, b]) => pairKey(a, b)).sort((x, y) => x - y)),
        )
      : [];
  const withPair: Map<number, number[]>[] = (wantsJoint ? candKeys : []).map(
    (ks) => {
      const byKey = new Map<number, number[]>();
      ks.forEach((keys, idx) => {
        for (const k of keys) {
          const list = byKey.get(k);
          if (list) list.push(idx);
          else byKey.set(k, [idx]);
        }
      });
      return byKey;
    },
  );
  /**
   * Every candidate matching's identity as a small integer, shared across
   * nights: two nights hold *the same matching* exactly when these agree.
   * `periodicPass` asks that question tens of thousands of times, and the string
   * key `matchingKey` builds is far too expensive to ask it with.
   */
  const matchId: number[][] = [];
  if (wantsPeriodic) {
    const idOfKeys = new Map<string, number>();
    for (const ks of candKeys) {
      matchId.push(
        ks.map((k) => {
          const s = k.join(",");
          let id = idOfKeys.get(s);
          if (id === undefined) {
            id = idOfKeys.size;
            idOfKeys.set(s, id);
          }
          return id;
        }),
      );
    }
  }
  // Merge buffers for that multiset comparison; a night holds at most T/2 games.
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

  /**
   * How tightly a pairing's meeting nights cluster — the rematch-spacing part of
   * `pairCost`, and the only part of it the compound pass is allowed to hold
   * fixed. Split out so there is still one definition: spacing is ranked apart
   * from the rest of the cost there, and a second copy of these four rules is
   * exactly the drift the weights' notes warn about.
   */
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
    // How far this pairing's meetings sit from an even spread over the weekdays,
    // against the flattest split the calendar's night counts allow. Identically
    // zero on a one-weekday cadence, so skip the work there.
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

  /** Cost over just the pairs any of a night's candidate matchings could touch. */
  const localCost = (keys: number[]): number => {
    let c = 0;
    for (const k of keys) c += pairCost(k);
    return c;
  };

  /** The rematch-spacing part of `localCost`, over the same pairs. */
  const localRematch = (keys: number[]): number => {
    let c = 0;
    for (const k of keys) c += rematchCost(meets.get(k)!);
    return c;
  };

  /** The weekday-split part of the whole schedule's cost, alone. */
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

  /**
   * Move pairing `k`'s meeting off `n1` and onto `n2`, re-choosing both nights
   * together and keeping the best joint choice that is a strict gain. Returns
   * whether it took one; on a miss both nights are left exactly as they were.
   */
  const tryJoint = (k: number, n1: number, n2: number): boolean => {
    const cur1 = choice[n1];
    const cur2 = choice[n2];
    const with2 = withPair[n2].get(k)!;
    const keys = [...new Set([...keysOfNight[n1], ...keysOfNight[n2]])];
    const curVal = localCost(keys) + penalty[n1][cur1] + penalty[n2][cur2];
    const curRematch = localRematch(keys);
    // What the two nights hold between them now. Every joint choice below has
    // to match it as a multiset: the same games, dealt across the two nights
    // differently. Anything else moves a meeting count off target, which
    // `MULT_W` prices out of reach — so it is filtered rather than scored.
    const wantLen = mergeKeys(wantBuf, candKeys[n1][cur1], candKeys[n2][cur2]);
    clearNight(n1);
    clearNight(n2);
    let best1 = -1;
    let best2 = -1;
    // Seeded with the incumbent's cost: only a strict gain is taken, or restarts
    // would flip between equal choices for ever.
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
        // Spacing is a filter here, not a term to be outbid. At the reference
        // season's scale one `rematchConsecWeek` and the whole residual weekday
        // excess are both worth 40, so a joint choice that trades one for the
        // other is a *tie* on `localCost` — a rounding accident away from being
        // taken, and it is the trade the league has already rejected. Ranking
        // spacing rather than filtering on it would only invert the problem.
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
    // The incumbent is not among the candidates — it is the one choice with the
    // pair still on `n1` — so nothing found means putting it back.
    applyNight(n1, best1 < 0 ? cur1 : best1);
    applyNight(n2, best2 < 0 ? cur2 : best2);
    return best1 >= 0;
  };

  /**
   * Re-choose two nights *together*, which is the move that clears the last of
   * the weekday split. Same shape as `assignSlots`'s compound pass, for the same
   * reason: the fix is a paired one and neither half is a gain alone.
   *
   * A pairing off its weekday split can only be straightened by moving one of
   * its meetings to another weekday. But `MULT_W` freezes how many times it
   * meets, so the meeting has to be *moved*, not dropped — and Phase P has
   * already frozen which nights each team plays, so the receiving night must
   * re-pair whoever those two teams were playing there. Both halves are
   * meeting-count violations on their own, priced at `MULT_W` against a weekday
   * term of `WD_SPLIT_W`, so `descend` — which re-chooses one night with every
   * other held fixed — refuses each half however the weights are set. That is
   * why raising `WD_SPLIT_W` only ever bought the split by breaking something
   * else. Together the counts come out whole and the split improves.
   *
   * Started only from a pairing already off its split, moving only off a weekday
   * it is over on and onto one it is short on, so the neighbourhood is
   * proportional to the damage rather than to the season: no residual, no work.
   * On the reference season that is ~100 night pairs at 45 joint choices each,
   * against the 576 × 225 an unrestricted version would sift.
   */
  const compoundPass = (): boolean => {
    if (D < 2) return false;
    for (const [k, ns] of meets) {
      if (ns.length === 0) continue;
      wdCounts.fill(0);
      for (const n of ns) wdCounts[wIndex.get(nightWeekday[n])!]++;
      if (cachedExcess(wdCounts) <= 0) continue;
      const [a, b] = pairOf.get(k)!;
      const total = ns.length;
      // Nights to move a meeting off, and weekdays with room to receive one.
      // Read off `wdCounts` before anything below disturbs it — the scratch
      // buffer is shared with `pairCost`, and `ns` is the live meeting list.
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
            // The receiving night must be one where both teams already play and
            // are not already paired — a pair meets at most once a night.
            if (n2 === n1 || !plays[a][n2] || !plays[b][n2]) continue;
            const with2 = withPair[n2].get(k);
            if (!with2 || options[n2].length < 2) continue;
            if (hasPair(options[n2][choice[n2]], [a, b])) continue;
            if (options[n1].length * with2.length > MAX_JOINT_MATCHINGS)
              continue;
            if (Date.now() > deadline) return false;
            // Accepting invalidates every list read above, so hand back to the
            // single-night descent and rescan from the new state next time.
            if (tryJoint(k, n1, n2)) return true;
          }
        }
      }
    }
    return false;
  };

  // ── Anti-periodicity ──────────────────────────────────────────────────────
  // Left-hand scratch for `periodicPass`: which window position a night holds
  // while a re-deal is being tried (−1 outside it), and the candidate index the
  // re-deal is currently trying at each of those positions.
  const winAt = new Int32Array(N).fill(-1);
  const pick: number[] = [];

  /** A night's matching id under the re-deal in progress, or its current one. */
  const idAt = (n: number): number =>
    winAt[n] >= 0 ? matchId[n][pick[winAt[n]]] : matchId[n][choice[n]];

  /**
   * Repeats within ±`PERIOD_SPAN` that have at least one end inside the window,
   * each counted once. Every other repeat in the season is identical for every
   * re-deal of this window, so leaving them out of both sides of the comparison
   * compares like with like at a fraction of the cost.
   */
  const localPeriodic = (win: number[]): number => {
    let c = 0;
    for (const n of win) {
      const id = idAt(n);
      const lo = Math.max(0, n - PERIOD_SPAN);
      const hi = Math.min(N - 1, n + PERIOD_SPAN);
      for (let m = lo; m <= hi; m++) {
        // A repeat with both ends inside the window is counted at the earlier
        // of them only, or a window's own repeats would be priced double.
        if (m === n || (winAt[m] >= 0 && m < n)) continue;
        if (idAt(m) === id) c++;
      }
    }
    return c;
  };

  /** The same count over the whole season — the restart tie-break's key. */
  const periodicTotal = (): number => {
    if (!wantsPeriodic) return 0;
    let c = 0;
    for (let n = 0; n < N; n++) {
      const id = matchId[n][choice[n]];
      const hi = Math.min(N - 1, n + PERIOD_SPAN);
      for (let m = n + 1; m <= hi; m++) if (matchId[m][choice[m]] === id) c++;
    }
    return c;
  };

  const mergeSorted = (x: number[], y: number[]): number[] => {
    const out: number[] = [];
    let i = 0;
    let j = 0;
    while (i < x.length && j < y.length)
      out.push(x[i] <= y[j] ? x[i++] : y[j++]);
    while (i < x.length) out.push(x[i++]);
    while (j < y.length) out.push(y[j++]);
    return out;
  };

  /** `rem` minus `keys` as multisets, or null when `keys` is not inside it. */
  const without = (rem: number[], keys: number[]): number[] | null => {
    const out: number[] = [];
    let i = 0;
    let j = 0;
    while (i < rem.length && j < keys.length) {
      if (rem[i] === keys[j]) {
        i++;
        j++;
      } else if (rem[i] < keys[j]) out.push(rem[i++]);
      else return null;
    }
    if (j < keys.length) return null;
    while (i < rem.length) out.push(rem[i++]);
    return out;
  };

  /**
   * Re-deal one window of nights: every way of dealing the games those nights
   * hold *between them* back out, one perfect matching per night. Takes the deal
   * that breaks the most repeats, and only ever a strict gain.
   *
   * The union multiset is the invariant that makes this safe. Each night's
   * candidates already cover exactly the teams Phase P has playing that night,
   * so any deal keeps games-per-team and the no-team-twice-a-night rule; holding
   * the union fixed keeps **every pair's meeting count exactly where it was**.
   * That is what a weight cannot do — switching one night alone moves two
   * meeting counts off target at `MULT_W` apiece, which is why the anti-
   * periodicity term measured in `SCHEDULE_HANDOFF.md` §5 does nothing at all
   * until it is large enough to buy a transiently-invalid schedule outright.
   * Held whole, periodicity costs nothing and never has to outbid balance.
   */
  const tryWindow = (win: number[]): boolean => {
    const k = win.length;
    const cur = win.map((n) => choice[n]);
    // A window of pinned nights has exactly one deal — its own.
    if (win.every((n) => options[n].length < 2)) return false;
    const keys = [...new Set(win.flatMap((n) => keysOfNight[n]))];
    let curVal = localCost(keys);
    for (let i = 0; i < k; i++) curVal += penalty[win[i]][cur[i]];
    const curRematch = localRematch(keys);
    for (let i = 0; i < k; i++) {
      winAt[win[i]] = i;
      pick[i] = cur[i];
    }
    const curPer = localPeriodic(win);
    let union: number[] = [];
    for (let i = 0; i < k; i++)
      union = mergeSorted(union, candKeys[win[i]][cur[i]]);

    for (const n of win) clearNight(n);
    const bestPick: number[] = [...cur];
    let found = false;
    let bestPer = curPer;
    let bestVal = Number.POSITIVE_INFINITY;
    let nodes = 0;
    const rec = (d: number, rem: number[]): void => {
      if (d === k) {
        if (rem.length > 0) return;
        const per = localPeriodic(win);
        if (per >= curPer) return;
        // ⛔ Spacing and cost are FILTERS here, not terms to be outbid — the same
        // rule `tryJoint` follows, for the same reason. Rematch spacing outranks
        // ice time outright, and a deal that trades one for the other is a trade
        // the league has already rejected; blending them would make it reachable
        // on a rounding accident.
        if (localRematch(keys) > curRematch + 1e-9) return;
        let val = localCost(keys);
        for (let i = 0; i < k; i++) val += penalty[win[i]][pick[i]];
        if (val > curVal + 1e-9) return;
        if (per < bestPer || (per === bestPer && val < bestVal - 1e-9)) {
          found = true;
          bestPer = per;
          bestVal = val;
          for (let i = 0; i < k; i++) bestPick[i] = pick[i];
        }
        return;
      }
      const n = win[d];
      for (let idx = 0; idx < options[n].length; idx++) {
        // Counted per candidate *examined*, not per candidate kept: on a wide
        // night the `without` test is the work, and almost all of it fails.
        if (nodes++ > MAX_PERIOD_NODES) return;
        const next = without(rem, candKeys[n][idx]);
        if (!next) continue;
        pick[d] = idx;
        for (const [a, b] of options[n][idx]) addMeeting(a, b, n);
        rec(d + 1, next);
        for (const [a, b] of options[n][idx]) removeMeeting(a, b, n);
      }
    };
    try {
      rec(0, union);
      for (let i = 0; i < k; i++) applyNight(win[i], bestPick[i]);
    } finally {
      // ⛔ `winAt` is scratch shared with every later window. A throw inside the
      // recursion would leave it >= 0 and poison every subsequent
      // `localPeriodic` for the rest of the run — silently, as a wrong number
      // rather than an error. Nothing throws today; this keeps that true.
      for (const n of win) winAt[n] = -1;
    }
    return found;
  };

  /**
   * Break up the periodic cycle Phase M's descent falls into, which is what
   * leaves a team on the same sheet of ice week after week. Same shape as
   * `compoundPass` above, and a strictly larger move: single-night descent
   * cannot reach this at any weight, because every step towards it is a
   * meeting-count violation on its own.
   *
   * Started only from a window that actually holds a repeat, so a season with no
   * periodicity in it pays one scan of the repeat map and stops.
   */
  const periodicPass = (): boolean => {
    if (!wantsPeriodic) return false;
    const repeats = new Uint8Array(N);
    for (let n = 0; n < N; n++) {
      const id = matchId[n][choice[n]];
      const hi = Math.min(N - 1, n + PERIOD_SPAN);
      for (let m = n + 1; m <= hi; m++) {
        if (matchId[m][choice[m]] !== id) continue;
        repeats[n] = 1;
        repeats[m] = 1;
      }
    }
    for (let start = 0; start + PERIOD_WINDOW <= N; start++) {
      let any = false;
      for (let i = 0; i < PERIOD_WINDOW && !any; i++)
        any = repeats[start + i] === 1;
      if (!any) continue;
      if (Date.now() > deadline) return false;
      const win: number[] = [];
      for (let i = 0; i < PERIOD_WINDOW; i++) win.push(start + i);
      // Accepting invalidates the repeat map above, so hand back to the
      // single-night descent and rescan from the new state next time.
      if (tryWindow(win)) return true;
    }
    return false;
  };

  const descend = () => {
    let improved = true;
    let pass = 0;
    // ⛔ SCALES WITH SEASON LENGTH. `periodicPass` spends one descend pass per
    // accepted re-deal, so passes grow at roughly 0.66·N — measured 12 at 23
    // nights, 25 at 40, 53 at 80. A flat 60 therefore starts binding around
    // N ≈ 90 and `descend` would return with periodicity only partly broken,
    // silently. The wall-clock `deadline` check below is the real bound; this
    // only stops a pathological non-convergence.
    const maxPasses = Math.max(60, 2 * N);
    while (improved && pass++ < maxPasses) {
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
      // Single-night moves first: they are far cheaper to evaluate, and the
      // compound pass costs nothing once no pairing is off its split.
      if (!improved) improved = compoundPass();
      // Cheapest-first again: the re-deal is the widest move here, and it costs
      // nothing once the season holds no repeat inside `PERIOD_SPAN`.
      if (!improved) improved = periodicPass();
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
  // Everything *except* the weekday split: meeting counts, rematch spacing and
  // the caller's churn penalty, at exactly the prices `pairCost` gives them.
  let bestPrimary = Number.POSITIVE_INFINITY;
  // Last key of all, and only ever a tie-break: the season's repeat count. Two
  // restarts that agree on balance, spacing, churn AND weekday split are
  // genuinely equal on everything this phase is ranked by, and taking the less
  // periodic of them is free. Ranking it any higher would be the weight this
  // pass exists to avoid.
  let bestPeriodic = Number.POSITIVE_INFINITY;
  for (let r = 0; r < Math.max(1, restarts); r++) {
    if (r > 0 && Date.now() > deadline) break;
    if (r === 0 && initial) seedInitial();
    else seedGreedy(r === 0 ? 0 : 400);
    descend();
    const total = totalCost();
    // Rank on the two keys rather than the blended sum. Both are in the same
    // units, so a wide enough weekday excess *can* outbid a rematch breach on
    // the sum — 20 units of excess and one `rematchConsecWeek` are both 40 —
    // and one restart landing on either side of that is enough to sell spacing
    // for split, which is the trade the league has rejected. Same reasoning as
    // `compareIce`: the split is the lowest-priority goal here, so it may break
    // a tie and nothing more.
    const primary = total - splitCost();
    const periodic = periodicTotal();
    const better =
      primary < bestPrimary - 1e-9 ||
      (primary < bestPrimary + 1e-9 &&
        (total < bestTotal - 1e-9 ||
          (total < bestTotal + 1e-9 && periodic < bestPeriodic)));
    if (better) {
      bestPrimary = primary;
      bestTotal = total;
      bestPeriodic = periodic;
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
