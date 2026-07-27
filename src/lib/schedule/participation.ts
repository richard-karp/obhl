/**
 * Phase P — decide *which teams play which night* before deciding who they play.
 *
 * The participation matrix alone fixes two of the four ranked goals exactly:
 *
 *   - Weekday balance (#1): a team's games on a weekday = that weekday's nights
 *     minus its byes on that weekday, so an even split is purely a statement
 *     about byes.
 *   - Bye rules (#2): "no two byes in a week", "no bye on the same weekday in
 *     consecutive weeks" and "no byes in consecutive weeks at all" are all
 *     properties of this matrix too.
 *
 * Deciding it up front — exactly, with branch and bound — is what lets the
 * generator hit both at once. Searching over placed *games* instead (the older
 * approach) has to move four teams to change one team's weekday count, so the
 * two goals fight each other and neither reaches its optimum.
 *
 * Games per team are an input, so every solution keeps games-played equal, and
 * "no team plays twice a night" is structural: a team either plays a night or
 * byes it.
 */

/** One game night, as this solver sees it. */
export type ParticipationNight = {
  /** Calendar-week index (Mon-anchored), from `buildNightMeta`. */
  week: number;
  /** Index into the league's distinct weekdays, not a day-of-week number. */
  weekday: number;
  /** Games scheduled that night — fixes how many teams bye it. */
  games: number;
};

export type Participation = {
  /** `plays[team][nightIndex]` — the matrix everything downstream reads. */
  plays: boolean[][];
  /** Rule 1 breaches: team-weeks holding 2+ byes. */
  byeMultiWeek: number;
  /** Rule 3 breaches: consecutive-week pairs where a team byed in both. */
  byeConsecWeek: number;
  /** Rule 2 breaches: ...and byed the same weekday in both. */
  byeConsecWeekSameDay: number;
  /** Widest per-team weekday spread (0 = perfectly balanced). */
  weekdaySpread: number;
  /** True when the search ran to completion instead of being cut off, so the
   * metrics above are the best this calendar allows and re-running with a
   * bigger budget cannot help. */
  optimal: boolean;
};

/** Bye-rule cost of a solved matrix, on the same scale the search minimises. */
export function byeRuleCost(p: Omit<Participation, "plays" | "optimal">): number {
  return (
    MULTI_WEEK_W * p.byeMultiWeek +
    CONSEC_SAME_DAY_W * p.byeConsecWeekSameDay +
    CONSEC_WEEK_W * p.byeConsecWeek
  );
}

// Bye-rule costs, mirroring SPACING_W so the two searches rank byes the same way.
const MULTI_WEEK_W = 400;
const CONSEC_SAME_DAY_W = 300;
const CONSEC_WEEK_W = 150;

type WeekSlot = { night: number; weekday: number; quota: number };
type Week = { slots: WeekSlot[]; adjPrev: boolean };

/** Deterministic PRNG so a given input always yields the same schedule. */
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

/** Group nights into chronological weeks, tagging calendar adjacency (a holiday
 * gap breaks a run, so byes either side of it aren't "consecutive weeks"). */
function buildWeeks(nights: ParticipationNight[], teamCount: number): Week[] {
  const byWeek = new Map<number, WeekSlot[]>();
  nights.forEach((n, i) => {
    const slots = byWeek.get(n.week) ?? byWeek.set(n.week, []).get(n.week)!;
    slots.push({ night: i, weekday: n.weekday, quota: teamCount - 2 * n.games });
  });
  const ordered = [...byWeek.keys()].sort((a, b) => a - b);
  return ordered.map((w, i) => ({
    slots: byWeek.get(w)!,
    adjPrev: i > 0 && w - ordered[i - 1] === 1,
  }));
}

/**
 * `minAdj[i][prevAdj][b]` — fewest consecutive-week bye pairs achievable when a
 * team still has `b` bye-weeks to place among weeks `i..end`, where `prevAdj`
 * means the previous week was a bye week *and* is calendar-adjacent to week `i`.
 * Used as an admissible lower bound to prune the search.
 */
function buildMinAdjTable(weeks: Week[], maxByes: number): number[][][] {
  const W = weeks.length;
  const INF = Number.MAX_SAFE_INTEGER / 4;
  const table: number[][][] = Array.from({ length: W + 1 }, () =>
    Array.from({ length: 2 }, () => new Array<number>(maxByes + 1).fill(INF)),
  );
  for (let p = 0; p < 2; p++) table[W][p][0] = 0;
  for (let i = W - 1; i >= 0; i--) {
    const nextAdj = i + 1 < W && weeks[i + 1].adjPrev ? 1 : 0;
    for (let p = 0; p < 2; p++) {
      table[i][p][0] = 0;
      for (let b = 1; b <= maxByes; b++) {
        const skip = table[i + 1][0][b];
        const take = p + table[i + 1][nextAdj][b - 1];
        table[i][p][b] = Math.min(skip, take);
      }
    }
  }
  return table;
}

/**
 * Split each team's byes across the weekdays before deciding which nights they
 * fall on: pick `b[team][weekday]` with the row sums each team owes and the
 * column sums the calendar hands out, as close to an even games-per-weekday
 * split as those two totals allow.
 *
 * This exists because a perfectly even split is often arithmetically impossible
 * — 45 nights over two weekdays can't give ten teams 18 games each way — and
 * then "within a slack band" is far too weak a target: it lets every team sit at
 * the edge of the band when most of them could have been exactly even. Solving
 * the split first turns weekday balance into a fixed per-team quota, which also
 * hands the night-level search a much tighter constraint to prune against.
 */
function chooseWeekdayByeTargets(
  nightsPerWd: number[],
  byeQuotaByWd: number[],
  totalByes: number[],
): number[][] | null {
  const T = totalByes.length;
  const D = nightsPerWd.length;
  // Capacity left on weekdays after d, used to force byes forward when the tail
  // can't absorb them.
  const tailRoom = new Array(D + 1).fill(0);
  for (let d = D - 1; d >= 0; d--) tailRoom[d] = tailRoom[d + 1] + nightsPerWd[d];

  const b: number[][] = Array.from({ length: T }, () => new Array(D).fill(0));
  const rem = [...totalByes];
  for (let d = 0; d < D; d++) {
    let quota = byeQuotaByWd[d];
    const lo = new Array(T).fill(0);
    const hi = new Array(T).fill(0);
    for (let t = 0; t < T; t++) {
      lo[t] = Math.max(0, rem[t] - tailRoom[d + 1]);
      hi[t] = Math.min(rem[t], nightsPerWd[d]);
      if (lo[t] > hi[t]) return null;
      b[t][d] = lo[t];
      quota -= lo[t];
    }
    if (quota < 0) return null;
    // Hand out what's left to whoever is furthest below an even share.
    while (quota > 0) {
      let pick = -1;
      let bestGames = -Infinity;
      for (let t = 0; t < T; t++) {
        if (b[t][d] >= hi[t]) continue;
        const games = nightsPerWd[d] - b[t][d];
        if (games > bestGames) {
          bestGames = games;
          pick = t;
        }
      }
      if (pick < 0) return null;
      b[pick][d]++;
      quota--;
    }
    for (let t = 0; t < T; t++) rem[t] -= b[t][d];
  }
  if (rem.some((r) => r !== 0)) return null;

  // Polish with 2×2 exchanges: they move byes between two teams and two
  // weekdays at once, so both the row and column totals survive untouched.
  const cost = (t: number) => {
    let mx = -Infinity;
    let mn = Infinity;
    let sq = 0;
    for (let d = 0; d < D; d++) {
      const g = nightsPerWd[d] - b[t][d];
      mx = Math.max(mx, g);
      mn = Math.min(mn, g);
      sq += g * g;
    }
    return (mx - mn) * 1000 + sq;
  };
  for (let pass = 0; pass < 200; pass++) {
    let improved = false;
    for (let t1 = 0; t1 < T && !improved; t1++) {
      for (let t2 = 0; t2 < T && !improved; t2++) {
        if (t1 === t2) continue;
        for (let d1 = 0; d1 < D && !improved; d1++) {
          for (let d2 = 0; d2 < D && !improved; d2++) {
            if (d1 === d2) continue;
            if (b[t1][d1] === 0 || b[t2][d2] === 0) continue;
            if (b[t1][d2] >= nightsPerWd[d2] || b[t2][d1] >= nightsPerWd[d1]) continue;
            const before = cost(t1) + cost(t2);
            b[t1][d1]--;
            b[t1][d2]++;
            b[t2][d2]--;
            b[t2][d1]++;
            if (cost(t1) + cost(t2) < before) improved = true;
            else {
              b[t1][d1]++;
              b[t1][d2]--;
              b[t2][d2]++;
              b[t2][d1]--;
            }
          }
        }
      }
    }
    if (!improved) break;
  }
  return b;
}

export type SolveParticipationOptions = {
  teamCount: number;
  /** Chronological; index here is the night index everything downstream uses. */
  nights: ParticipationNight[];
  gamesPerTeam: number[];
  /** How many distinct weekdays the league plays. */
  weekdayCount: number;
  /** Allowed slack over the ideal weekday split, in games. 0 = perfectly even. */
  weekdaySlack?: number;
  /** Pin per-team weekday bye counts to the evenest split the totals allow,
   * instead of only keeping them inside the slack band. */
  exactWeekdayTargets?: boolean;
  nodeBudget?: number;
  /** Wall-clock cap. On expiry the best solution found so far is returned. */
  timeBudgetMs?: number;
  /** Give up this long after the last improvement. The bound can rarely prove
   * optimality on hard calendars, so without this the search would sit out its
   * whole budget long after it has stopped finding anything better. */
  stallMs?: number;
  seed?: number;
};

/**
 * Exact branch-and-bound for the participation matrix: hard weekday balance
 * (within `weekdaySlack` of the ideal split), minimum bye-rule cost. Returns the
 * best matrix found, or null if the weekday target is unreachable / the node
 * budget runs out before any complete solution.
 */
export function solveParticipation(
  opts: SolveParticipationOptions,
): Participation | null {
  const {
    teamCount: T,
    nights,
    gamesPerTeam,
    weekdayCount: D,
    weekdaySlack = 0,
    exactWeekdayTargets = true,
    nodeBudget = 20_000_000,
    timeBudgetMs = 4_000,
    stallMs = 2_000,
    seed = 1,
  } = opts;
  const N = nights.length;
  if (T < 2 || N === 0 || D === 0) return null;

  const weeks = buildWeeks(nights, T);
  const W = weeks.length;

  const nightsPerWd = new Array(D).fill(0);
  for (const n of nights) nightsPerWd[n.weekday]++;

  // Per-team bye budgets: total, and per weekday (the weekday window is just the
  // even-games window restated as byes).
  const totalByes = gamesPerTeam.map((g) => N - g);
  if (totalByes.some((b) => b < 0)) return null;
  const wdMin: number[][] = [];
  const wdMax: number[][] = [];
  for (let t = 0; t < T; t++) {
    const g = gamesPerTeam[t];
    const lo = Math.floor(g / D) - weekdaySlack;
    const hi = Math.ceil(g / D) + weekdaySlack;
    const mins: number[] = [];
    const maxes: number[] = [];
    for (let d = 0; d < D; d++) {
      mins.push(Math.max(0, nightsPerWd[d] - hi));
      maxes.push(Math.min(nightsPerWd[d], nightsPerWd[d] - lo));
    }
    if (mins.some((m, d) => m > maxes[d])) return null;
    const sumMin = mins.reduce((a, b) => a + b, 0);
    const sumMax = maxes.reduce((a, b) => a + b, 0);
    if (totalByes[t] < sumMin || totalByes[t] > sumMax) return null;
    wdMin.push(mins);
    wdMax.push(maxes);
  }

  // Column check, per weekday: the byes that weekday's nights hand out have to
  // land somewhere, and each team can only absorb between its min and max. A
  // calendar with an odd number of nights on one weekday routinely fails this,
  // and catching it here costs O(teams × weekdays) instead of a whole search
  // that can only end in "infeasible".
  const byeQuotaByWd = new Array(D).fill(0);
  for (const n of nights) byeQuotaByWd[n.weekday] += T - 2 * n.games;
  if (byeQuotaByWd.some((q) => q < 0)) return null;
  for (let d = 0; d < D; d++) {
    let lo = 0;
    let hi = 0;
    for (let t = 0; t < T; t++) {
      lo += wdMin[t][d];
      hi += wdMax[t][d];
    }
    if (byeQuotaByWd[d] < lo || byeQuotaByWd[d] > hi) return null;
  }

  // Pin each team to an exact per-weekday bye count when the ideal split is
  // reachable, so the search can't settle for a merely in-band one. Only the
  // band is used if that pinning turns out to be unsatisfiable (the caller
  // retries with more slack).
  if (exactWeekdayTargets) {
    const targets = chooseWeekdayByeTargets(nightsPerWd, byeQuotaByWd, totalByes);
    if (!targets) return null;
    for (let t = 0; t < T; t++) {
      for (let d = 0; d < D; d++) {
        if (targets[t][d] < wdMin[t][d] || targets[t][d] > wdMax[t][d]) return null;
        wdMin[t][d] = targets[t][d];
        wdMax[t][d] = targets[t][d];
      }
    }
  }

  const maxByes = Math.max(0, ...totalByes);
  const minAdj = buildMinAdjTable(weeks, maxByes);
  // Weeks from i..end that host at least one weekday-d bye slot — a team can
  // only take one bye per week, so this caps how much of a weekday it can owe.
  const weeksWithWd: number[][] = Array.from({ length: W + 1 }, () =>
    new Array(D).fill(0),
  );
  for (let i = W - 1; i >= 0; i--) {
    for (let d = 0; d < D; d++) {
      weeksWithWd[i][d] =
        weeksWithWd[i + 1][d] +
        (weeks[i].slots.some((s) => s.weekday === d && s.quota > 0) ? 1 : 0);
    }
  }

  const rnd = mulberry32(seed);
  const rem = [...totalByes];
  const asgWd: number[][] = Array.from({ length: T }, () => new Array(D).fill(0));
  const byeAt: boolean[][] = Array.from({ length: T }, () => new Array(N).fill(false));

  let best: boolean[][] | null = null;
  let bestCost = Number.POSITIVE_INFINITY;
  let nodes = 0;
  let done = false; // set when the bound is met or a budget runs out
  let cutOff = false; // ...specifically because a budget ran out
  const deadline = Date.now() + timeBudgetMs;
  let lastImproved = Date.now();

  /** Admissible lower bound on bye-rule cost still to be paid from week `i`. */
  const remainingLowerBound = (i: number, prevAdj: boolean[]): number => {
    let lb = 0;
    for (let t = 0; t < T; t++) {
      const b = rem[t];
      if (b === 0) continue;
      const weeksLeft = W - i;
      const forcedMulti = Math.max(0, b - weeksLeft);
      const placeable = Math.min(b, weeksLeft);
      lb +=
        forcedMulti * MULTI_WEEK_W +
        minAdj[i][prevAdj[t] ? 1 : 0][placeable] * CONSEC_WEEK_W;
    }
    return lb;
  };

  /** Can the remaining weeks still satisfy every team's weekday shortfall? */
  const weekdayReachable = (i: number): boolean => {
    for (let t = 0; t < T; t++) {
      let shortfall = 0;
      for (let d = 0; d < D; d++) {
        const need = wdMin[t][d] - asgWd[t][d];
        if (need <= 0) continue;
        if (need > weeksWithWd[i][d]) return false;
        shortfall += need;
      }
      if (shortfall > rem[t]) return false;
    }
    return true;
  };

  // Cost no solution can undercut. Reaching it means the incumbent is optimal,
  // which is what stops the search dead on calendars where every week is a bye
  // week (the bye-rule cost is then the same for every branch, so cost pruning
  // alone would grind through the whole tree).
  const globalLowerBound = remainingLowerBound(0, new Array(T).fill(false));

  const dfs = (i: number, cost: number, prevByeWd: (number[] | null)[]): void => {
    if (done) return;
    if (++nodes > nodeBudget) {
      done = true;
      cutOff = true;
      return;
    }
    if ((nodes & 0x3ff) === 0) {
      const now = Date.now();
      if (now > deadline || (best !== null && now - lastImproved > stallMs)) {
        done = true;
        cutOff = true;
        return;
      }
    }
    if (cost >= bestCost) return;
    if (i === W) {
      for (let t = 0; t < T; t++) {
        if (rem[t] !== 0) return;
        for (let d = 0; d < D; d++) {
          if (asgWd[t][d] < wdMin[t][d] || asgWd[t][d] > wdMax[t][d]) return;
        }
      }
      bestCost = cost;
      best = byeAt.map((row) => [...row]);
      lastImproved = Date.now();
      if (bestCost <= globalLowerBound) done = true;
      return;
    }
    const prevAdjFlags = prevByeWd.map((v) => v !== null && weeks[i].adjPrev);
    if (cost + remainingLowerBound(i, prevAdjFlags) >= bestCost) return;
    if (!weekdayReachable(i)) return;

    const week = weeks[i];
    const slots = week.slots.filter((s) => s.quota > 0);
    // Byes this week, per team: how many, and on which weekdays.
    const takenWd: (number[] | null)[] = new Array(T).fill(null);
    const countThisWeek = new Array<number>(T).fill(0);

    /** Cost of handing team `t` a bye on `weekday` of this week: a second bye
     * this week breaks rule 1; a bye next to last week's breaks rule 3, and
     * rule 2 too if it repeats the weekday. */
    const byeDelta = (t: number, weekday: number): number => {
      if (countThisWeek[t] > 0) return MULTI_WEEK_W;
      if (!week.adjPrev || prevByeWd[t] === null) return 0;
      return CONSEC_WEEK_W + (prevByeWd[t]!.includes(weekday) ? CONSEC_SAME_DAY_W : 0);
    };

    const fillSlot = (k: number, addedCost: number): void => {
      if (done || cost + addedCost >= bestCost) return;
      if (k === slots.length) {
        dfs(i + 1, cost + addedCost, takenWd.slice());
        return;
      }
      const { night, weekday, quota } = slots[k];
      const elig: number[] = [];
      for (let t = 0; t < T; t++) {
        if (rem[t] <= 0) continue;
        if (asgWd[t][weekday] + 1 > wdMax[t][weekday]) continue;
        elig.push(t);
      }
      if (elig.length < quota) return;
      // Cheapest-first, then most-constrained (teams owing the most byes), then
      // a small random tiebreak so different seeds explore different corners of
      // what is often a wide plateau. Diving down the cheap branch first gets a
      // tight incumbent early, which is what makes the cost pruning bite.
      const jitter = new Map(elig.map((t) => [t, rnd()]));
      const delta = new Map(elig.map((t) => [t, byeDelta(t, weekday)]));
      elig.sort(
        (a, b) =>
          delta.get(a)! - delta.get(b)! ||
          rem[b] - rem[a] ||
          jitter.get(a)! - jitter.get(b)!,
      );

      const chosen: number[] = [];
      const pick = (start: number, extra: number): void => {
        if (done || cost + addedCost + extra >= bestCost) return;
        if (chosen.length === quota) {
          fillSlot(k + 1, addedCost + extra);
          return;
        }
        for (let x = start; x < elig.length; x++) {
          if (elig.length - x < quota - chosen.length) break;
          const t = elig[x];
          chosen.push(t);
          countThisWeek[t]++;
          rem[t]--;
          asgWd[t][weekday]++;
          byeAt[t][night] = true;
          const prevTaken = takenWd[t];
          takenWd[t] = prevTaken ? [...prevTaken, weekday] : [weekday];

          pick(x + 1, extra + delta.get(t)!);

          takenWd[t] = prevTaken;
          byeAt[t][night] = false;
          asgWd[t][weekday]--;
          rem[t]++;
          countThisWeek[t]--;
          chosen.pop();
        }
      };
      pick(0, 0);
    };

    fillSlot(0, 0);
  };

  dfs(0, 0, new Array(T).fill(null));
  if (!best) return null;

  const solution = best as boolean[][];
  const plays = solution.map((row) => row.map((b) => !b));
  return { plays, optimal: !cutOff, ...describeParticipation(plays, nights) };
}

/** Recount the bye metrics from a finished matrix (also used to score fallbacks). */
export function describeParticipation(
  plays: boolean[][],
  nights: ParticipationNight[],
): Omit<Participation, "plays" | "optimal"> {
  const T = plays.length;
  const weekList = [...new Set(nights.map((n) => n.week))].sort((a, b) => a - b);
  const wdCount = Math.max(0, ...nights.map((n) => n.weekday)) + 1;
  let byeMultiWeek = 0;
  let byeConsecWeek = 0;
  let byeConsecWeekSameDay = 0;
  let weekdaySpread = 0;

  for (let t = 0; t < T; t++) {
    const perWeek = new Map<number, number[]>(); // week -> weekdays byed
    const games = new Array(wdCount).fill(0);
    nights.forEach((n, i) => {
      if (plays[t][i]) {
        games[n.weekday]++;
        return;
      }
      const list = perWeek.get(n.week) ?? perWeek.set(n.week, []).get(n.week)!;
      list.push(n.weekday);
    });
    for (const list of perWeek.values()) if (list.length >= 2) byeMultiWeek++;
    for (let i = 1; i < weekList.length; i++) {
      const a = weekList[i - 1];
      const b = weekList[i];
      if (b - a !== 1) continue;
      const wa = perWeek.get(a);
      const wb = perWeek.get(b);
      if (!wa || !wb) continue;
      byeConsecWeek++;
      if (wa.some((d) => wb.includes(d))) byeConsecWeekSameDay++;
    }
    weekdaySpread = Math.max(
      weekdaySpread,
      Math.max(...games) - Math.min(...games),
    );
  }
  return { byeMultiWeek, byeConsecWeek, byeConsecWeekSameDay, weekdaySpread };
}
