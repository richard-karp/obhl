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
  const candKeys: number[][][] = options.map((ms) =>
    ms.map((m) => m.map(([a, b]) => pairKey(a, b)).sort((x, y) => x - y)),
  );
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
  // Merge buffers for that multiset comparison; a night holds at most T/2 games.
  const wantBuf = new Array<number>(T);
  const gotBuf = new Array<number>(T);
  const mergeKeys = (out: number[], x: number[], y: number[]): number => {
    let i = 0;
    let j = 0;
    let o = 0;
    while (i < x.length && j < y.length) out[o++] = x[i] <= y[j] ? x[i++] : y[j++];
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
            if (options[n1].length * with2.length > MAX_JOINT_MATCHINGS) continue;
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
      // Single-night moves first: they are far cheaper to evaluate, and the
      // compound pass costs nothing once no pairing is off its split.
      if (!improved) improved = compoundPass();
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
