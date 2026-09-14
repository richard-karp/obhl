// ⚠️ Phase P settles who plays which night exactly, before any pairing exists.
// RUNBOOK.md, _Schedule generator_.

import { mulberry32 } from "./rng";

export type ParticipationNight = {
  /** Calendar-week index (Mon-anchored), from `buildNightMeta`. */
  week: number;
  /** Index into the league's distinct weekdays, not a day-of-week number. */
  weekday: number;
  games: number;
};

export type Participation = {
  /** `plays[team][nightIndex]` — the matrix everything downstream reads. */
  plays: boolean[][];
  byeMultiWeek: number;
  byeConsecWeek: number;
  byeConsecWeekSameDay: number;
  /** In nights, not weeks, so unlike the three rules above it sees through a holiday gap. */
  byeAdjNight: number;
  weekdaySpread: number;
  /** The search completed: a bigger budget cannot improve these metrics. */
  optimal: boolean;
};

/** ⛔ Phase P's objective and the basis of its admissible bound: leave it untouched.
 *  RUNBOOK.md, _Schedule generator_. */
export function byeRuleCost(
  p: Omit<Participation, "plays" | "optimal">,
): number {
  return (
    ADJ_NIGHT_W * p.byeAdjNight +
    MULTI_WEEK_W * p.byeMultiWeek +
    CONSEC_SAME_DAY_W * p.byeConsecWeekSameDay +
    CONSEC_WEEK_W * p.byeConsecWeek
  );
}

// ⚠️ Mirrors `SPACING_W` so both searches rank byes alike. Adjacent nights outrank the week
// rules: a week rule can't see two nights off that straddle a break.
const ADJ_NIGHT_W = 800;
const MULTI_WEEK_W = 400;
const CONSEC_SAME_DAY_W = 300;
const CONSEC_WEEK_W = 150;

type WeekSlot = { night: number; weekday: number; quota: number };
type Week = { slots: WeekSlot[]; adjPrev: boolean };

function buildWeeks(nights: ParticipationNight[], teamCount: number): Week[] {
  const byWeek = new Map<number, WeekSlot[]>();
  nights.forEach((n, i) => {
    const slots = byWeek.get(n.week) ?? byWeek.set(n.week, []).get(n.week)!;
    slots.push({
      night: i,
      weekday: n.weekday,
      quota: teamCount - 2 * n.games,
    });
  });
  const ordered = [...byWeek.keys()].sort((a, b) => a - b);
  return ordered.map((w, i) => ({
    slots: byWeek.get(w)!,
    adjPrev: i > 0 && w - ordered[i - 1] === 1,
  }));
}

/** ⛔ An admissible lower bound (`minAdj[i][prevAdj][b]`): one that overestimates prunes
 *  optimal solutions. RUNBOOK.md, _Schedule generator_. */
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

/** Fixes each team's byes per weekday before nights, as even as the totals allow. ⚠️ A slack
 *  band alone lets every team sit at its edge when most could be exactly even. */
function chooseWeekdayByeTargets(
  nightsPerWd: number[],
  byeQuotaByWd: number[],
  totalByes: number[],
  /** ⛔ Undefined without constraints; then this must run the original expressions
   *  exactly: it runs on every generation, and unconstrained metrics may not move. */
  limits?: {
    /** Teams named by at least one constraint, which absorb the slack. */
    constrained: boolean[];
    /** `min[t][d]` — byes team `t` is already forced into on weekday `d`. */
    min: number[][];
    /** `max[t][d]` — byes left on weekday `d` after that team's forced plays. */
    max: number[][];
  },
): number[][] | null {
  const T = totalByes.length;
  const D = nightsPerWd.length;
  const tailRoom = new Array(D + 1).fill(0);
  for (let d = D - 1; d >= 0; d--)
    tailRoom[d] = tailRoom[d + 1] + nightsPerWd[d];

  const b: number[][] = Array.from({ length: T }, () => new Array(D).fill(0));
  const rem = [...totalByes];
  for (let d = 0; d < D; d++) {
    let quota = byeQuotaByWd[d];
    const lo = new Array(T).fill(0);
    const hi = new Array(T).fill(0);
    for (let t = 0; t < T; t++) {
      lo[t] = Math.max(0, rem[t] - tailRoom[d + 1]);
      hi[t] = Math.min(rem[t], nightsPerWd[d]);
      if (limits) {
        // ⚠️ Without these bounds a forced bye pins an unsatisfiable target, every exact rung
        // fails, and the whole league drops to the unpinned rungs for one request.
        lo[t] = Math.max(lo[t], limits.min[t][d]);
        hi[t] = Math.min(hi[t], limits.max[t][d]);
      }
      if (lo[t] > hi[t]) return null;
      b[t][d] = lo[t];
      quota -= lo[t];
    }
    if (quota < 0) return null;
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

  // 2×2 exchanges keep row and column totals. ⚠️ `spreadWeight` exceeds Σ nightsPerWd², the
  // tiebreak's ceiling, so spread outranks it at any league size: don't make it a constant.
  const spreadWeight = 1 + nightsPerWd.reduce((s, n) => s + n * n, 0);
  /** An unconstrained team's evenness outweighs a constrained team's 1000:1, so the team
   *  that asked absorbs the cost. Every weight is 1 without constraints. */
  const UNCONSTRAINED_W = 1000;
  const weightOf = limits
    ? (t: number) => (limits.constrained[t] ? 1 : UNCONSTRAINED_W)
    : () => 1;
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
    return ((mx - mn) * spreadWeight + sq) * weightOf(t);
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
            if (b[t1][d2] >= nightsPerWd[d2] || b[t2][d1] >= nightsPerWd[d1])
              continue;
            if (
              limits &&
              (b[t1][d1] <= limits.min[t1][d1] ||
                b[t2][d2] <= limits.min[t2][d2] ||
                b[t1][d2] >= limits.max[t1][d2] ||
                b[t2][d1] >= limits.max[t2][d1])
            ) {
              continue;
            }
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
  weekdayCount: number;
  /** Allowed slack over the ideal weekday split, in games. 0 = perfectly even. */
  weekdaySlack?: number;
  /** Pin weekday bye counts to the evenest split, not merely inside the slack band. */
  exactWeekdayTargets?: boolean;
  nodeBudget?: number;
  /** Wall-clock cap. On expiry the best solution found so far is returned. */
  timeBudgetMs?: number;
  /** Give up this long after the last improvement: the bound rarely proves optimality. */
  stallMs?: number;
  seed?: number;
  /** Manager pre-assignments (`plays` false = must bye), eliminated before the search, never
   *  penalised. A forced bye moves a bye, so games and meeting counts can't change. */
  forced?: { team: number; night: number; plays: boolean }[];
  /** "Byes at least one night of this week": a disjunction, so a feasibility test at node
   *  expansion, not a pre-assignment. `week` uses `ParticipationNight.week`'s numbering. */
  byeInWeek?: { team: number; week: number }[];
};

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
    forced,
    byeInWeek,
  } = opts;
  const N = nights.length;
  if (T < 2 || N === 0 || D === 0) return null;
  // ⚠️ Checked per night: the weekday column check below would let a quiet night on the same
  // weekday mask an over-full one.
  if (nights.some((n) => T - 2 * n.games < 0)) return null;

  // Built only when forced cells exist, so an unconstrained search runs unchanged.
  const hasForced = !!forced?.length;
  const mustBye = hasForced
    ? Array.from({ length: T }, () => new Array<boolean>(N).fill(false))
    : undefined;
  const mustPlay = hasForced
    ? Array.from({ length: T }, () => new Array<boolean>(N).fill(false))
    : undefined;
  // ⚠️ Gated on `hasForced`, not on `forced` being present: a bias-only or `bye_in_week`-only
  // season arrives with `forced: []`, and the loop would read matrices never built.
  if (hasForced) {
    for (const f of forced!) {
      if (f.team < 0 || f.team >= T || f.night < 0 || f.night >= N) return null;
      (f.plays ? mustPlay! : mustBye!)[f.team][f.night] = true;
    }
    for (let t = 0; t < T; t++) {
      for (let n = 0; n < N; n++) {
        // Refused, not resolved: the caller reports contradictions first, and guessing a
        // winner would silently answer what the manager has to settle.
        if (mustBye![t][n] && mustPlay![t][n]) return null;
        // ⚠️ Refuted here or not at all: the week recursion skips zero-quota slots, so it
        // never sees a forced bye on a no-bye night or a forced play on a no-game night.
        if (mustBye![t][n] && T - 2 * nights[n].games <= 0) return null;
        if (mustPlay![t][n] && nights[n].games === 0) return null;
      }
    }
  }

  const weeks = buildWeeks(nights, T);
  const W = weeks.length;

  const weekPosOf = new Map<number, number>();
  weeks.forEach((_, i) =>
    weekPosOf.set(nights[weeks[i].slots[0].night].week, i),
  );
  let needByeInWeek: number[][] | undefined;
  if (byeInWeek?.length) {
    needByeInWeek = Array.from({ length: W }, () => [] as number[]);
    for (const b of byeInWeek) {
      const pos = weekPosOf.get(b.week);
      if (pos === undefined || b.team < 0 || b.team >= T) return null;
      if (!needByeInWeek[pos].includes(b.team)) needByeInWeek[pos].push(b.team);
    }
  }

  const nightsPerWd = new Array(D).fill(0);
  for (const n of nights) nightsPerWd[n.weekday]++;

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

  if (exactWeekdayTargets) {
    let limits: Parameters<typeof chooseWeekdayByeTargets>[3];
    if (hasForced || needByeInWeek) {
      const constrained = new Array<boolean>(T).fill(false);
      const minWd = Array.from({ length: T }, () =>
        new Array<number>(D).fill(0),
      );
      const maxWd = Array.from({ length: T }, () => [...nightsPerWd]);
      // ⛔ Count off the deduped `mustBye`/`mustPlay`, never `forced`: two requests can name
      // one cell (a double-click), and counting it twice pins an unmeetable weekday target.
      if (hasForced) {
        for (let t = 0; t < T; t++) {
          for (let n = 0; n < N; n++) {
            const d = nights[n].weekday;
            if (mustPlay![t][n]) {
              constrained[t] = true;
              maxWd[t][d]--;
            }
            if (mustBye![t][n]) {
              constrained[t] = true;
              minWd[t][d]++;
            }
          }
        }
      }
      for (const b of byeInWeek ?? []) constrained[b.team] = true;
      limits = { constrained, min: minWd, max: maxWd };
    }
    const targets = chooseWeekdayByeTargets(
      nightsPerWd,
      byeQuotaByWd,
      totalByes,
      limits,
    );
    if (!targets) return null;
    for (let t = 0; t < T; t++) {
      for (let d = 0; d < D; d++) {
        if (targets[t][d] < wdMin[t][d] || targets[t][d] > wdMax[t][d])
          return null;
        wdMin[t][d] = targets[t][d];
        wdMax[t][d] = targets[t][d];
      }
    }
  }

  const maxByes = Math.max(0, ...totalByes);
  const minAdj = buildMinAdjTable(weeks, maxByes);
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
  const asgWd: number[][] = Array.from({ length: T }, () =>
    new Array(D).fill(0),
  );
  const byeAt: boolean[][] = Array.from({ length: T }, () =>
    new Array(N).fill(false),
  );

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

  // No solution can undercut this, so reaching it stops the search: where every week is a
  // bye week, cost pruning alone would grind through the whole tree.
  const globalLowerBound = remainingLowerBound(0, new Array(T).fill(false));

  /** Charges one step against the budgets; true once the search must stop. ⚠️ Also called
   *  from the combination enumeration, or a wide week overshoots the deadline. */
  const tick = (): boolean => {
    if (done) return true;
    if (++nodes > nodeBudget) {
      done = true;
      cutOff = true;
      return true;
    }
    if ((nodes & 0x3ff) === 0) {
      const now = Date.now();
      if (now > deadline || (best !== null && now - lastImproved > stallMs)) {
        done = true;
        cutOff = true;
        return true;
      }
    }
    return false;
  };

  const dfs = (
    i: number,
    cost: number,
    prevByeWd: (number[] | null)[],
  ): void => {
    if (tick()) return;
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
    const takenWd: (number[] | null)[] = new Array(T).fill(null);
    const countThisWeek = new Array<number>(T).fill(0);

    /** A second bye this week costs rule 1; one after last week's, rule 3 (and rule 2 on the
     *  same weekday). Rule 4, the night before also a bye, is charged on top of any of them. */
    const byeDelta = (t: number, weekday: number, night: number): number => {
      const adj = night > 0 && byeAt[t][night - 1] ? ADJ_NIGHT_W : 0;
      if (countThisWeek[t] > 0) return adj + MULTI_WEEK_W;
      if (!week.adjPrev || prevByeWd[t] === null) return adj;
      return (
        adj +
        CONSEC_WEEK_W +
        (prevByeWd[t]!.includes(weekday) ? CONSEC_SAME_DAY_W : 0)
      );
    };

    const fillSlot = (k: number, addedCost: number): void => {
      if (done || cost + addedCost >= bestCost) return;
      if (k === slots.length) {
        if (needByeInWeek) {
          for (const t of needByeInWeek[i]) if (countThisWeek[t] === 0) return;
        }
        dfs(i + 1, cost + addedCost, takenWd.slice());
        return;
      }
      const { night, weekday, quota } = slots[k];
      const elig: number[] = [];
      const must: number[] = [];
      for (let t = 0; t < T; t++) {
        if (mustPlay?.[t][night]) continue;
        if (mustBye?.[t][night]) {
          must.push(t);
          continue;
        }
        if (rem[t] <= 0) continue;
        if (asgWd[t][weekday] + 1 > wdMax[t][weekday]) continue;
        elig.push(t);
      }
      const need = quota - must.length;
      if (need < 0) return;
      for (const t of must) {
        if (rem[t] <= 0) return;
        if (asgWd[t][weekday] + 1 > wdMax[t][weekday]) return;
      }
      if (elig.length < need) return;
      // Cheapest first (an early tight incumbent makes pruning bite), then most owed, then a
      // seeded jitter, so different seeds explore the plateau `PLATEAU_SEEDS` samples.
      const jitter = new Map(elig.map((t) => [t, rnd()]));
      // Built once per slot: the night before belongs to an already-committed slot, so
      // `byeDelta` can't change under the enumeration.
      const delta = new Map(elig.map((t) => [t, byeDelta(t, weekday, night)]));
      elig.sort(
        (a, b) =>
          delta.get(a)! - delta.get(b)! ||
          rem[b] - rem[a] ||
          jitter.get(a)! - jitter.get(b)!,
      );

      const chosen: number[] = [];
      const pick = (start: number, extra: number): void => {
        if (tick() || cost + addedCost + extra >= bestCost) return;
        if (chosen.length === need) {
          fillSlot(k + 1, addedCost + extra);
          return;
        }
        for (let x = start; x < elig.length; x++) {
          if (elig.length - x < need - chosen.length) break;
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
      if (must.length === 0) {
        pick(0, 0);
        return;
      }
      // Deltas are read before any forced bye is applied, which is safe only because
      // `byeDelta` reads just its own team's state.
      let mustCost = 0;
      for (const t of must) mustCost += byeDelta(t, weekday, night);
      const prevTaken = must.map((t) => takenWd[t]);
      for (const t of must) {
        countThisWeek[t]++;
        rem[t]--;
        asgWd[t][weekday]++;
        byeAt[t][night] = true;
        takenWd[t] = takenWd[t] ? [...takenWd[t]!, weekday] : [weekday];
      }
      pick(0, mustCost);
      must.forEach((t, x) => {
        takenWd[t] = prevTaken[x];
        byeAt[t][night] = false;
        asgWd[t][weekday]--;
        rem[t]++;
        countThisWeek[t]--;
      });
    };

    fillSlot(0, 0);
  };

  dfs(0, 0, new Array(T).fill(null));
  if (!best) return null;

  const solution = best as boolean[][];
  const plays = solution.map((row) => row.map((b) => !b));
  return { plays, optimal: !cutOff, ...describeParticipation(plays, nights) };
}

export function describeParticipation(
  plays: boolean[][],
  nights: ParticipationNight[],
): Omit<Participation, "plays" | "optimal"> {
  const T = plays.length;
  const weekList = [...new Set(nights.map((n) => n.week))].sort(
    (a, b) => a - b,
  );
  const wdCount = Math.max(0, ...nights.map((n) => n.weekday)) + 1;
  let byeMultiWeek = 0;
  let byeConsecWeek = 0;
  let byeConsecWeekSameDay = 0;
  let byeAdjNight = 0;
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
      if (i > 0 && !plays[t][i - 1]) byeAdjNight++;
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
  return {
    byeMultiWeek,
    byeConsecWeek,
    byeConsecWeekSameDay,
    byeAdjNight,
    weekdaySpread,
  };
}
