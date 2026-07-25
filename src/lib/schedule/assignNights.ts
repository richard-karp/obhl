import type { Pairing } from "./roundRobin";
import {
  buildNightMeta,
  teamSpacingCost,
  matchupSpacingCost,
  spacingReport,
  type NightMeta,
  type SpacingReport,
} from "./spacing";

/**
 * Assigns pairings onto concrete game nights + ice-time slots. Two phases keep
 * the week-level fairness (byes, rematch spacing) decoupled from the within-week
 * fairness (weekday split, ice-time share) — optimizing one in a single flat
 * search wrecks the other, so they are handled at their natural granularities:
 *
 *   Phase W (assignToWeeks): assign each game to a calendar week so every team
 *     plays every week (no full-week byes), no matchup repeats within a week, and
 *     a pair's meetings stay far apart. A week-level swap repair drives those to
 *     their best. This fixes priorities #2 (byes) and #3 (rematch spacing).
 *
 *   Phase N (placeWeek + balanceWeekdays + refineSpacing): drop each week's games
 *     onto that week's nights and ice slots. balanceWeekdays drives every team's
 *     weekday split to as even as the week assignment allows — an exact
 *     branch-and-bound for the ideal split, falling back to local search when the
 *     calendar makes it infeasible (priority #1). refineSpacing then polishes
 *     ice-time share and consecutiveness with weekday-preserving swaps (#4).
 *
 * Every team plays the same number of games (all pairings are placed), so byes
 * come out even too. Any unavoidable weekday imbalance is a structural property
 * of an asymmetric calendar (e.g. a season that opens on a lone weeknight), not a
 * search failure; ice-time imbalance is biased onto the later/worse slots.
 */

export type Night = { date: string; slots: string[] }; // slots are "HH:MM"

export type ScheduledGame = {
  home: string;
  away: string;
  round: number;
  scheduledAt: string; // naive "YYYY-MM-DDTHH:MM:00"
  nightIndex: number;
  slotIndex: number;
};

export type BalanceReport = {
  totalScheduled: number;
  unscheduled: number;
  gamesPerTeam: { team: string; count: number }[];
  slotShareByTeam: { team: string; counts: number[] }[];
  // Each team's games per distinct night-of-week (aligned to `weekdays`), so a
  // team isn't loaded onto, e.g., only Tuesdays when players are night-specific.
  weekdays: string[];
  nightShareByTeam: { team: string; counts: number[] }[];
  pairingCounts: { matchup: string; count: number }[];
  minRematchGapNights: number | null;
  spacing: SpacingReport;
};

const matchupKey = (a: string, b: string) => [a, b].sort().join("|");

const WEEKDAY = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
/** UTC-stable day-of-week (0=Sun) from a "YYYY-MM-DD..." string. */
export const weekdayOf = (date: string): number => {
  const [y, m, d] = date.slice(0, 10).split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
};

// Weekday-balance weight in the unified optimizer — priority #1 is never traded
// for spacing. Invariant: it must exceed the largest spacing-penalty swing a
// single swap can produce (≤4 affected teams × their SPACING_W terms, realistically
// well under ~30k), so any swap that worsens a team's weekday spread by 1 (costing
// BALANCE_W) can never be justified by spacing gains. Keep this comfortably above
// the sum of SPACING_W weights if those grow.
const BALANCE_W = 100_000;
// Iterated-local-search budget for the spacing pass. Each candidate swap now
// re-evaluates O(weeks)-cost spacing terms, and every hill-climb pass is O(G²),
// so the restart count is the dominant runtime lever — keep it small and scale
// it down hard as the game count grows so a large-league generate stays fast.
// The search starts from an already-balanced greedy, so few restarts suffice.
const HILLCLIMB_PASSES = 30;
function ilsRestartsFor(gameCount: number): number {
  // Small leagues are cheap per restart, so keep enough to reliably converge
  // weekday balance (#1); large leagues cost O(G²·weeks) per restart, so cut
  // hard to stay well under a second.
  if (gameCount <= 80) return 40;
  if (gameCount <= 120) return 10;
  if (gameCount <= 200) return 4;
  return 2;
}

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

/** Precomputed, per-night metadata shared by placement and scoring. */
type Meta = {
  usedWeekdays: number[];
  wIndex: Map<number, number>;
  nightW: number[]; // weekday index for each night
  numSlots: number;
};

function buildMeta(nights: Night[]): Meta {
  const usedWeekdays = [...new Set(nights.map((n) => weekdayOf(n.date)))].sort(
    (a, b) => a - b,
  );
  const wIndex = new Map(usedWeekdays.map((d, i) => [d, i]));
  return {
    usedWeekdays,
    wIndex,
    nightW: nights.map((n) => wIndex.get(weekdayOf(n.date))!),
    numSlots: nights.reduce((m, n) => Math.max(m, n.slots.length), 0),
  };
}

/** Per-team slot- and weekday-count vectors for the current placement. */
function vectorsOf(games: ScheduledGame[], teamIds: string[], meta: Meta) {
  const slot = new Map<string, number[]>(
    teamIds.map((t) => [t, new Array(meta.numSlots).fill(0)]),
  );
  const wd = new Map<string, number[]>(
    teamIds.map((t) => [t, meta.usedWeekdays.map(() => 0)]),
  );
  for (const g of games) {
    slot.get(g.home)![g.slotIndex]++;
    slot.get(g.away)![g.slotIndex]++;
    wd.get(g.home)![meta.nightW[g.nightIndex]]++;
    wd.get(g.away)![meta.nightW[g.nightIndex]]++;
  }
  return { slot, wd };
}

const sq = (a: number[]) => a.reduce((s, x) => s + x * x, 0);
const spread = (a: number[]) => (a.length ? Math.max(...a) - Math.min(...a) : 0);

/** Would swapping the two games' (night, slot) positions be legal? */
function swapLegal(
  g1: ScheduledGame,
  g2: ScheduledGame,
  nights: Night[],
  nightTeams: Set<string>[],
): boolean {
  const { nightIndex: n1, slotIndex: s1 } = g1;
  const { nightIndex: n2, slotIndex: s2 } = g2;
  if (n1 === n2) return s1 !== s2;
  if (s1 >= nights[n2].slots.length || s2 >= nights[n1].slots.length) return false;
  if (nightTeams[n2].has(g1.home) || nightTeams[n2].has(g1.away)) return false;
  if (nightTeams[n1].has(g2.home) || nightTeams[n1].has(g2.away)) return false;
  return true;
}

function doSwap(
  g1: ScheduledGame,
  g2: ScheduledGame,
  nights: Night[],
  nightTeams: Set<string>[],
): void {
  const { nightIndex: n1, slotIndex: s1 } = g1;
  const { nightIndex: n2, slotIndex: s2 } = g2;
  nightTeams[n1].delete(g1.home);
  nightTeams[n1].delete(g1.away);
  nightTeams[n2].delete(g2.home);
  nightTeams[n2].delete(g2.away);
  g1.nightIndex = n2;
  g1.slotIndex = s2;
  g1.scheduledAt = `${nights[n2].date}T${nights[n2].slots[s2]}:00`;
  g2.nightIndex = n1;
  g2.slotIndex = s1;
  g2.scheduledAt = `${nights[n1].date}T${nights[n1].slots[s1]}:00`;
  nightTeams[n2].add(g1.home);
  nightTeams[n2].add(g1.away);
  nightTeams[n1].add(g2.home);
  nightTeams[n1].add(g2.away);
}

function nightTeamsOf(games: ScheduledGame[], nights: Night[]): Set<string>[] {
  const nt = nights.map(() => new Set<string>());
  for (const g of games) {
    nt[g.nightIndex].add(g.home);
    nt[g.nightIndex].add(g.away);
  }
  return nt;
}

/** Random legal position-swaps to kick out of a local optimum. */
function perturb(
  games: ScheduledGame[],
  nights: Night[],
  rnd: () => number,
  kicks: number,
  week?: number[],
): void {
  if (games.length < 2) return;
  const nightTeams = nightTeamsOf(games, nights);
  for (let k = 0; k < kicks; k++) {
    for (let tries = 0; tries < 8; tries++) {
      const i = Math.floor(rnd() * games.length);
      const j = Math.floor(rnd() * games.length);
      if (i === j) continue;
      // When `week` is given, only swap games in the same week — that keeps the
      // week-level structure (byes, rematch spacing) fixed while polishing.
      if (week && week[games[i].nightIndex] !== week[games[j].nightIndex]) continue;
      if (swapLegal(games[i], games[j], nights, nightTeams)) {
        doSwap(games[i], games[j], nights, nightTeams);
        break;
      }
    }
  }
}

const snapshot = (games: ScheduledGame[]) =>
  games.map((g) => ({ n: g.nightIndex, s: g.slotIndex }));

function restore(
  games: ScheduledGame[],
  snap: { n: number; s: number }[],
  nights: Night[],
): void {
  for (let i = 0; i < games.length; i++) {
    games[i].nightIndex = snap[i].n;
    games[i].slotIndex = snap[i].s;
    games[i].scheduledAt = `${nights[snap[i].n].date}T${nights[snap[i].n].slots[snap[i].s]}:00`;
  }
}

/** Weekday-balance penalty for one team's per-weekday count vector. The huge
 * spread term makes any spread ≥ 2 dominate; the sum-of-squares is a smooth
 * gradient toward flatness underneath it. */
function weekdayPenalty(v: number[]): number {
  return BALANCE_W * Math.max(0, spread(v) - 1) + sq(v);
}

/** One valid way to assign a week's games to its nights: `assign[j]` is the
 * local night index for game j, and `contrib` is the per-team weekday-count
 * vector that choice adds to the season totals. */
type WeekColoring = { assign: number[]; contrib: Map<string, number[]> };

/**
 * Dedicated weekday-balancing pass (priority #1). Reassigns each week's games
 * across that week's nights to drive every team's weekday split to as even as
 * possible — same-week only, so the week-level bye/rematch structure from Phase W
 * is untouched.
 *
 * Why whole-week recoloring rather than pairwise swaps: with exact-fit weeks
 * (every ice slot used) the only pairwise move is a 4-team night swap, which
 * shifts imbalance onto three collateral teams at once. Reconciling two
 * complementary imbalances (a team with a spare Monday vs. one with a spare
 * Thursday that never share a light week) then needs a chain of such swaps whose
 * intermediate steps all worsen the penalty, so local search stalls. Instead we
 * treat each week's night-assignment as a free choice (same-week swaps make the
 * colorings independent) and optimize the choices jointly by coordinate descent
 * plus 2-week joint moves — which provably reaches the even split whenever ice
 * capacity per weekday allows it. Mutates `games` (night + slot) in place.
 */
function balanceWeekdays(
  games: ScheduledGame[],
  nights: Night[],
  bmeta: Meta,
  smeta: NightMeta,
  teamIds: string[],
): void {
  if (games.length < 2 || bmeta.usedWeekdays.length < 2) return;
  const nw = bmeta.usedWeekdays.length;

  // Games grouped by calendar week (indices into `games`).
  const weekGames = new Map<number, number[]>();
  games.forEach((g, i) => {
    const w = smeta.week[g.nightIndex];
    (weekGames.get(w) ?? weekGames.set(w, []).get(w)!).push(i);
  });

  const makeColoring = (
    assign: number[],
    gis: number[],
    nightIdx: number[],
  ): WeekColoring => {
    const contrib = new Map<string, number[]>();
    for (let j = 0; j < gis.length; j++) {
      const wi = bmeta.nightW[nightIdx[assign[j]]];
      for (const t of [games[gis[j]].home, games[gis[j]].away]) {
        const v = contrib.get(t) ?? new Array(nw).fill(0);
        v[wi]++;
        contrib.set(t, v);
      }
    }
    return { assign, contrib };
  };

  // Enumerate every valid night-assignment for a week (≤ slots/night, no team
  // twice a night). Weeks too dense to enumerate keep their current assignment.
  const enumerateColorings = (gis: number[], nightIdx: number[]): WeekColoring[] => {
    const k = gis.length;
    const m = nightIdx.length;
    const currentAssign = () =>
      gis.map((gi) => nightIdx.indexOf(games[gi].nightIndex));
    if (m < 2 || Math.pow(m, k) > 20_000) {
      return [makeColoring(currentAssign(), gis, nightIdx)];
    }
    const out: WeekColoring[] = [];
    const assign = new Array<number>(k);
    const rec = (i: number) => {
      if (i === k) {
        const perCount = new Array(m).fill(0);
        const onNight = nightIdx.map(() => new Set<string>());
        for (let j = 0; j < k; j++) {
          const a = assign[j];
          if (++perCount[a] > nights[nightIdx[a]].slots.length) return;
          const g = games[gis[j]];
          if (onNight[a].has(g.home) || onNight[a].has(g.away)) return;
          onNight[a].add(g.home);
          onNight[a].add(g.away);
        }
        out.push(makeColoring([...assign], gis, nightIdx));
        return;
      }
      for (let a = 0; a < m; a++) {
        assign[i] = a;
        rec(i + 1);
      }
    };
    rec(0);
    return out;
  };

  // Per-week: its nights, all candidate colorings, and the current pick.
  type WeekState = {
    week: number;
    gis: number[];
    nightIdx: number[];
    options: WeekColoring[];
    chosen: WeekColoring;
  };
  const states: WeekState[] = [];
  const totals = new Map<string, number[]>(
    teamIds.map((t) => [t, new Array(nw).fill(0)]),
  );
  for (const week of smeta.sortedWeeks) {
    const gis = weekGames.get(week);
    if (!gis || gis.length === 0) continue;
    const nightIdx = smeta.weekNights.get(week)!;
    const options = enumerateColorings(gis, nightIdx);
    const chosen = makeColoring(
      gis.map((gi) => nightIdx.indexOf(games[gi].nightIndex)),
      gis,
      nightIdx,
    );
    for (const [t, v] of chosen.contrib) {
      const tv = totals.get(t)!;
      for (let d = 0; d < nw; d++) tv[d] += v[d];
    }
    states.push({ week, gis, nightIdx, options, chosen });
  }

  // Exact branch-and-bound for the ideal split: every team's games spread across
  // the weekdays with each weekday within [floor, ceil] of g/weekdays (penalty 0).
  // Run only when local search leaves a spread-2 team, because local search can
  // stall in a deep minimum even when the ideal is reachable (e.g. exact-fit
  // weeks) — the B&B finds it directly there. When the ideal is infeasible (the
  // calendar forces some team off by a game), it exhausts the budget and returns
  // false, leaving the local-search result in place.
  function solveEvenAssignment(
    sts: WeekState[],
    tids: string[],
    weekdays: number,
    gs: ScheduledGame[],
  ): boolean {
    const totalGames = new Map<string, number>(tids.map((t) => [t, 0]));
    for (const g of gs) {
      totalGames.set(g.home, totalGames.get(g.home)! + 1);
      totalGames.set(g.away, totalGames.get(g.away)! + 1);
    }
    const ceilT = new Map(tids.map((t) => [t, Math.ceil(totalGames.get(t)! / weekdays)]));
    const floorT = new Map(tids.map((t) => [t, Math.floor(totalGames.get(t)! / weekdays)]));
    // Most-constrained weeks first for stronger pruning.
    const order = [...sts].sort((a, b) => a.options.length - b.options.length);
    // Suffix sum of each team's games in order[i..] for a floor look-ahead prune.
    const suffix: Map<string, number>[] = new Array(order.length + 1);
    suffix[order.length] = new Map(tids.map((t) => [t, 0]));
    for (let i = order.length - 1; i >= 0; i--) {
      const m = new Map(suffix[i + 1]);
      for (const gi of order[i].gis) {
        for (const t of [gs[gi].home, gs[gi].away]) m.set(t, (m.get(t) ?? 0) + 1);
      }
      suffix[i] = m;
    }
    const run = new Map<string, number[]>(
      tids.map((t) => [t, new Array(weekdays).fill(0)]),
    );
    const pick: WeekColoring[] = new Array(order.length);
    const BUDGET = 300_000;
    let nodes = 0;
    const dfs = (i: number): boolean => {
      if (++nodes > BUDGET) return false;
      if (i === order.length) {
        for (const t of tids) {
          const v = run.get(t)!;
          const f = floorT.get(t)!;
          for (let d = 0; d < weekdays; d++) if (v[d] < f) return false;
        }
        return true;
      }
      const rem = suffix[i + 1];
      for (const c of order[i].options) {
        let ok = true;
        for (const [t, v] of c.contrib) {
          const r = run.get(t)!;
          const cap = ceilT.get(t)!;
          for (let d = 0; d < weekdays; d++) {
            if (r[d] + v[d] > cap) { ok = false; break; }
          }
          if (!ok) break;
        }
        if (!ok) continue;
        for (const [t, v] of c.contrib) {
          const r = run.get(t)!;
          for (let d = 0; d < weekdays; d++) r[d] += v[d];
        }
        // Floor look-ahead: each team's remaining games must cover its shortfall
        // to floor across weekdays (necessary condition; leaf check is exact).
        let feasible = true;
        for (const t of tids) {
          const r = run.get(t)!;
          const f = floorT.get(t)!;
          let deficit = 0;
          for (let d = 0; d < weekdays; d++) if (r[d] < f) deficit += f - r[d];
          if (deficit > (rem.get(t) ?? 0)) { feasible = false; break; }
        }
        if (feasible) {
          pick[i] = c;
          if (dfs(i + 1)) return true;
        }
        for (const [t, v] of c.contrib) {
          const r = run.get(t)!;
          for (let d = 0; d < weekdays; d++) r[d] -= v[d];
        }
      }
      return false;
    };
    if (!dfs(0)) return false;
    order.forEach((st, i) => (st.chosen = pick[i]));
    return true;
  }

  const add = (c: WeekColoring, sign: number) => {
    for (const [t, v] of c.contrib) {
      const tv = totals.get(t)!;
      for (let d = 0; d < nw; d++) tv[d] += sign * v[d];
    }
  };
  // Penalty added by a coloring on top of the current (week-excluded) totals.
  const deltaPenalty = (c: WeekColoring): number => {
    let d = 0;
    for (const [t, v] of c.contrib) {
      const tv = totals.get(t)!;
      const base = weekdayPenalty(tv);
      for (let x = 0; x < nw; x++) tv[x] += v[x];
      d += weekdayPenalty(tv) - base;
      for (let x = 0; x < nw; x++) tv[x] -= v[x];
    }
    return d;
  };
  const totalPenalty = () =>
    teamIds.reduce((s, t) => s + weekdayPenalty(totals.get(t)!), 0);
  // A spread-2 team is the only imbalance the exact solver can still remove; the
  // sum-of-squares term keeps totalPenalty > 0 even when every team is already as
  // even as possible, so gate the B&B on spread directly, not on totalPenalty.
  const hasImbalance = () => teamIds.some((t) => spread(totals.get(t)!) >= 2);

  // Local search: coordinate descent to a local minimum, then simulated
  // annealing to escape it. Reconciling two complementary imbalances needs a
  // chain of recolorings that hand the imbalance from team to team; each
  // intermediate step is penalty-neutral (one team fixed, one broken → ~0),
  // which a strict descent won't take but low-temperature SA traverses freely,
  // while still rejecting genuinely worse states (an extra spread-2 team costs
  // BALANCE_W).
  const localSearchWeekdays = () => {
    let guard = 0;
    let improved = true;
    while (improved && guard++ < 200 && totalPenalty() > 0) {
      improved = false;
      for (const st of states) {
        if (st.options.length < 2) continue;
        add(st.chosen, -1);
        let best = st.chosen;
        let bestD = deltaPenalty(st.chosen);
        for (const c of st.options) {
          const d = deltaPenalty(c);
          if (d < bestD - 1e-9) {
            bestD = d;
            best = c;
          }
        }
        add(best, +1);
        if (best !== st.chosen) {
          st.chosen = best;
          improved = true;
        }
      }
    }

    const flexible = states.filter((s) => s.options.length > 1);
    if (flexible.length === 0 || totalPenalty() === 0) return;
    const rnd = mulberry32(teamIds.length * 9173 + games.length * 41 + 17);
    let curPen = totalPenalty();
    let bestPen = curPen;
    let bestChosen = states.map((s) => s.chosen);
    const ITERS = 60_000;
    for (let it = 0; it < ITERS && bestPen > 0; it++) {
      const T = 3 * (1 - it / ITERS) + 0.05; // linear cool-down
      const st = flexible[Math.floor(rnd() * flexible.length)];
      const cand = st.options[Math.floor(rnd() * st.options.length)];
      if (cand === st.chosen) continue;
      add(st.chosen, -1);
      const delta = deltaPenalty(cand) - deltaPenalty(st.chosen);
      if (delta <= 0 || rnd() < Math.exp(-delta / T)) {
        add(cand, +1);
        st.chosen = cand;
        curPen += delta;
        if (curPen < bestPen - 1e-9) {
          bestPen = curPen;
          bestChosen = states.map((s) => s.chosen);
        }
      } else {
        add(st.chosen, +1);
      }
    }
    states.forEach((s, i) => (s.chosen = bestChosen[i]));
  };

  // Cheap local search first; only fall to the exact branch-and-bound if it
  // leaves a spread-2 team (the B&B overwrites `chosen` on success, keeps the
  // local-search result on failure). This skips the B&B entirely whenever the
  // even split is already reached, and caps its cost when it isn't.
  localSearchWeekdays();
  if (hasImbalance()) solveEvenAssignment(states, teamIds, nw, games);

  // Apply the chosen night-assignments back to `games`, packing each night's
  // games into slots 0..n-1 (ice-time share is polished later by refineSpacing).
  for (const st of states) {
    const perNight = st.nightIdx.map(() => [] as number[]);
    for (let j = 0; j < st.gis.length; j++) {
      perNight[st.chosen.assign[j]].push(st.gis[j]);
    }
    for (let a = 0; a < st.nightIdx.length; a++) {
      const ni = st.nightIdx[a];
      perNight[a].forEach((gi, s) => {
        const g = games[gi];
        g.nightIndex = ni;
        g.slotIndex = s;
        g.scheduledAt = `${nights[ni].date}T${nights[ni].slots[s]}:00`;
      });
    }
  }
}

/**
 * Second-stage refinement (priority #2–#4): improve bye distribution, rematch
 * spacing, and ice-time spread via position swaps — but only swaps that do NOT
 * worsen any team's weekday spread, so the #1 even-schedule balance is preserved.
 */
function refineSpacing(
  games: ScheduledGame[],
  nights: Night[],
  teamIds: string[],
  bmeta: Meta,
  smeta: NightMeta,
): void {
  if (games.length < 2 || smeta.sortedWeeks.length === 0) return;
  const numSlots = bmeta.numSlots;
  const wd = new Map<string, number[]>(
    teamIds.map((t) => [t, bmeta.usedWeekdays.map(() => 0)]),
  );
  const slotByNight = new Map<string, Map<number, number>>(
    teamIds.map((t) => [t, new Map()]),
  );
  const matchupNights = new Map<string, number[]>();
  const nightTeams = nightTeamsOf(games, nights);
  for (const g of games) {
    wd.get(g.home)![bmeta.nightW[g.nightIndex]]++;
    wd.get(g.away)![bmeta.nightW[g.nightIndex]]++;
    slotByNight.get(g.home)!.set(g.nightIndex, g.slotIndex);
    slotByNight.get(g.away)!.set(g.nightIndex, g.slotIndex);
    const k = matchupKey(g.home, g.away);
    (matchupNights.get(k) ?? matchupNights.set(k, []).get(k)!).push(g.nightIndex);
  }

  // Unified per-team cost: weekday balance (#1) dominates via a huge weight, so
  // the search never trades an even schedule for spacing; ice-time/bye spacing
  // (#2–#4) ride underneath in teamSpacingCost.
  const tCost = (t: string) => {
    const v = wd.get(t)!;
    return (
      BALANCE_W * Math.max(0, spread(v) - 1) +
      sq(v) +
      teamSpacingCost(slotByNight.get(t)!, numSlots, smeta)
    );
  };
  const mCost = (k: string) => matchupSpacingCost(matchupNights.get(k)!, smeta);
  const totalCost = () =>
    teamIds.reduce((s, t) => s + tCost(t), 0) +
    [...matchupNights.keys()].reduce((s, k) => s + mCost(k), 0);
  const replace = (arr: number[], from: number, to: number) => {
    const i = arr.indexOf(from);
    if (i >= 0) arr[i] = to;
  };

  // One hill-climb to a local optimum: apply balance-preserving swaps that lower
  // the spacing penalty.
  const climb = () => {
    let improved = true;
    let pass = 0;
    while (improved && pass++ < HILLCLIMB_PASSES) {
      improved = false;
      for (let i = 0; i < games.length; i++) {
        for (let j = i + 1; j < games.length; j++) {
          const g1 = games[i];
          const g2 = games[j];
          if (!swapLegal(g1, g2, nights, nightTeams)) continue;
          const n1 = g1.nightIndex;
          const n2 = g2.nightIndex;
          // Same-week only: keeps the week assignment (byes / rematch spacing)
          // fixed and just polishes weekday and ice-time balance.
          if (smeta.week[n1] !== smeta.week[n2]) continue;
          const s1 = g1.slotIndex;
          const s2 = g2.slotIndex;
          const w1 = bmeta.nightW[n1];
          const w2 = bmeta.nightW[n2];
          const k1 = matchupKey(g1.home, g1.away);
          const k2 = matchupKey(g2.home, g2.away);
          const teams = [...new Set([g1.home, g1.away, g2.home, g2.away])];
          // k1 === k2 would mean swapping two meetings of the same pair; that's
          // always rejected by swapLegal (a team can't move to a night it already
          // plays), so the branch below is defensive. It also guarantees a
          // matchup's night list never holds a duplicate of the night being
          // moved in, so replace()'s indexOf targets the right entry.
          const mkeys = k1 === k2 ? [k1] : [k1, k2];
          const before =
            teams.reduce((s, t) => s + tCost(t), 0) +
            mkeys.reduce((s, k) => s + mCost(k), 0);

          const applyTracking = () => {
            for (const t of [g1.home, g1.away]) {
              wd.get(t)![w1]--;
              wd.get(t)![w2]++;
              slotByNight.get(t)!.delete(n1);
              slotByNight.get(t)!.set(n2, s2);
            }
            for (const t of [g2.home, g2.away]) {
              wd.get(t)![w2]--;
              wd.get(t)![w1]++;
              slotByNight.get(t)!.delete(n2);
              slotByNight.get(t)!.set(n1, s1);
            }
            if (k1 !== k2) {
              replace(matchupNights.get(k1)!, n1, n2);
              replace(matchupNights.get(k2)!, n2, n1);
            }
          };
          const revertTracking = () => {
            for (const t of [g1.home, g1.away]) {
              wd.get(t)![w2]--;
              wd.get(t)![w1]++;
              slotByNight.get(t)!.delete(n2);
              slotByNight.get(t)!.set(n1, s1);
            }
            for (const t of [g2.home, g2.away]) {
              wd.get(t)![w1]--;
              wd.get(t)![w2]++;
              slotByNight.get(t)!.delete(n1);
              slotByNight.get(t)!.set(n2, s2);
            }
            if (k1 !== k2) {
              replace(matchupNights.get(k1)!, n2, n1);
              replace(matchupNights.get(k2)!, n1, n2);
            }
          };

          applyTracking();
          const after =
            teams.reduce((s, t) => s + tCost(t), 0) +
            mkeys.reduce((s, k) => s + mCost(k), 0);
          if (after < before - 1e-9) {
            doSwap(g1, g2, nights, nightTeams);
            improved = true;
          } else {
            revertTracking();
          }
        }
      }
    }
  };

  const rnd = mulberry32(teamIds.length * 6151 + games.length * 233 + 7);
  const restarts = ilsRestartsFor(games.length);
  climb();
  let bestSnap = snapshot(games);
  let bestTotal = totalCost();
  for (let iter = 0; iter < restarts; iter++) {
    restore(games, bestSnap, nights);
    rebuild();
    perturb(games, nights, rnd, 3, smeta.week);
    rebuild();
    climb();
    const total = totalCost();
    if (total < bestTotal) {
      bestTotal = total;
      bestSnap = snapshot(games);
    }
  }
  restore(games, bestSnap, nights);

  function rebuild() {
    for (const t of teamIds) {
      wd.get(t)!.fill(0);
      slotByNight.get(t)!.clear();
    }
    matchupNights.clear();
    for (const s of nightTeams) s.clear();
    for (const g of games) {
      wd.get(g.home)![bmeta.nightW[g.nightIndex]]++;
      wd.get(g.away)![bmeta.nightW[g.nightIndex]]++;
      slotByNight.get(g.home)!.set(g.nightIndex, g.slotIndex);
      slotByNight.get(g.away)!.set(g.nightIndex, g.slotIndex);
      const k = matchupKey(g.home, g.away);
      (matchupNights.get(k) ?? matchupNights.set(k, []).get(k)!).push(g.nightIndex);
      nightTeams[g.nightIndex].add(g.home);
      nightTeams[g.nightIndex].add(g.away);
    }
  }
}

type WeekCap = { week: number; nightIdx: number[]; cap: number; maxPer: number };

/** Per-week capacity: total ice slots that week and the max games a team can
 * play (= number of game nights that week, since no team plays twice a night). */
function weekCapacities(nights: Night[], smeta: NightMeta): WeekCap[] {
  return smeta.sortedWeeks.map((week) => {
    const nightIdx = smeta.weekNights.get(week)!;
    return {
      week,
      nightIdx,
      cap: nightIdx.reduce((s, ni) => s + nights[ni].slots.length, 0),
      maxPer: nightIdx.length,
    };
  });
}

// Phase-W selection weights. Each team gets a target games-this-week (full if it
// was light/byed last week, light if it was full → alternation, and everyone ≥1
// → coverage). "Need" = target minus games so far, and it dominates so it decides
// WHICH teams play; rematch spacing only breaks ties, choosing WHICH matchup.
const NEED_W = 10_000;
const SPREAD_W = 600;

/**
 * Phase W — assign the game list to weeks so every team plays 1–2 games a week
 * (no full-week byes), no matchup repeats within a week (no same-week rematch),
 * light/full weeks alternate, and a pair's meetings are pushed apart. Returns the
 * games per week plus any that couldn't be placed.
 */
function assignToWeeks(
  pairings: Pairing[],
  teamIds: string[],
  weekCaps: WeekCap[],
): { byWeek: Map<number, Pairing[]>; unscheduled: number } {
  const pool = [...pairings];
  const byWeek = new Map<number, Pairing[]>();
  const lastMeetingWeek = new Map<string, number>();
  let prevWeekLoad = new Map<string, number>(teamIds.map((t) => [t, 0]));

  for (const { week, cap, maxPer } of weekCaps) {
    const chosen: Pairing[] = [];
    const weekCount = new Map<string, number>(teamIds.map((t) => [t, 0]));
    const usedMatchups = new Set<string>();
    // Alternate: a team that was light/byed last week aims to play full this
    // week; a team that was full aims to play light. Everyone's target is ≥1.
    const target = new Map<string, number>(
      teamIds.map((t) => [
        t,
        prevWeekLoad.get(t)! < maxPer ? maxPer : Math.max(1, maxPer - 1),
      ]),
    );
    const need = (t: string) => Math.max(0, target.get(t)! - weekCount.get(t)!);

    while (chosen.length < cap) {
      let bestI = -1;
      let bestScore = Infinity;
      for (let i = 0; i < pool.length; i++) {
        const p = pool[i];
        const mk = matchupKey(p.home, p.away);
        if (
          weekCount.get(p.home)! >= maxPer ||
          weekCount.get(p.away)! >= maxPer ||
          usedMatchups.has(mk)
        ) {
          continue;
        }
        const lastW = lastMeetingWeek.get(mk);
        const gap = lastW == null ? 1000 : week - lastW;
        const score = -NEED_W * (need(p.home) + need(p.away)) + SPREAD_W / gap;
        if (score < bestScore) {
          bestScore = score;
          bestI = i;
        }
      }
      if (bestI < 0) break; // nothing else fits this week
      const [p] = pool.splice(bestI, 1);
      chosen.push(p);
      weekCount.set(p.home, weekCount.get(p.home)! + 1);
      weekCount.set(p.away, weekCount.get(p.away)! + 1);
      usedMatchups.add(matchupKey(p.home, p.away));
      lastMeetingWeek.set(matchupKey(p.home, p.away), week);
    }

    byWeek.set(week, chosen);
    prevWeekLoad = weekCount;
  }

  // Repair: place any leftover pairing into a week that came up short (keeps GP
  // equal). Relaxes only the soft spacing preferences, not the hard constraints.
  for (let i = pool.length - 1; i >= 0; i--) {
    const p = pool[i];
    for (const { week, cap, maxPer } of weekCaps) {
      const games = byWeek.get(week)!;
      if (games.length >= cap) continue;
      let home = 0;
      let away = 0;
      let dup = false;
      const mk = matchupKey(p.home, p.away);
      for (const g of games) {
        if (g.home === p.home || g.away === p.home) home++;
        if (g.home === p.away || g.away === p.away) away++;
        if (matchupKey(g.home, g.away) === mk) dup = true;
      }
      if (dup || home >= maxPer || away >= maxPer) continue;
      games.push(p);
      pool.splice(i, 1);
      break;
    }
  }

  repairWeeks(byWeek, teamIds, weekCaps);
  return { byWeek, unscheduled: pool.length };
}

// Week-level repair weights: eliminate full-week byes first, then runs of bye
// weeks, then keep rematches spread across the season.
const MISS_W = 100_000;
const CONSEC_W = 1_000;
const REMATCH_WK_W = 100;

/**
 * Improve the week assignment by swapping games between weeks: drives full-week
 * byes and back-to-back bye weeks toward zero while keeping matchups spread out.
 * Never changes which games exist (GP stays equal) or lets a matchup repeat in a
 * week / a team exceed a week's game nights.
 */
function repairWeeks(
  byWeek: Map<number, Pairing[]>,
  teamIds: string[],
  weekCaps: WeekCap[],
): void {
  const items: { p: Pairing; w: number }[] = [];
  for (const { week } of weekCaps) {
    for (const p of byWeek.get(week)!) items.push({ p, w: week });
  }
  if (items.length < 2) return;
  const maxPer = new Map(weekCaps.map((wc) => [wc.week, wc.maxPer]));
  const order = new Map(weekCaps.map((wc, i) => [wc.week, i]));
  const weeks = weekCaps.map((wc) => wc.week);

  // Per-team games-per-week and per-matchup weeks, maintained across swaps.
  const cnt = new Map<string, Map<number, number>>(
    teamIds.map((t) => [t, new Map()]),
  );
  const mWeeks = new Map<string, number[]>();
  for (const { p, w } of items) {
    for (const t of [p.home, p.away]) {
      cnt.get(t)!.set(w, (cnt.get(t)!.get(w) ?? 0) + 1);
    }
    const k = matchupKey(p.home, p.away);
    (mWeeks.get(k) ?? mWeeks.set(k, []).get(k)!).push(w);
  }

  const teamCost = (t: string): number => {
    const m = cnt.get(t)!;
    let c = 0;
    for (const { week, maxPer: mp } of weekCaps) {
      if (mp >= 2 && (m.get(week) ?? 0) === 0) c += MISS_W;
    }
    for (let i = 1; i < weeks.length; i++) {
      const a = weeks[i - 1];
      const b = weeks[i];
      if (b - a !== 1) continue; // holiday gap breaks the run
      const lightA = (m.get(a) ?? 0) < maxPer.get(a)!;
      const lightB = (m.get(b) ?? 0) < maxPer.get(b)!;
      if (lightA && lightB) c += CONSEC_W;
    }
    return c;
  };
  const matchupCost = (k: string): number => {
    const ws = [...mWeeks.get(k)!].sort((a, b) => order.get(a)! - order.get(b)!);
    let c = 0;
    for (let i = 1; i < ws.length; i++) {
      const gap = order.get(ws[i])! - order.get(ws[i - 1])!;
      if (gap <= 1) c += REMATCH_WK_W / Math.max(1, gap);
    }
    return c;
  };
  const bump = (t: string, w: number, d: number) =>
    cnt.get(t)!.set(w, (cnt.get(t)!.get(w) ?? 0) + d);
  const swapMatchupWeek = (k: string, from: number, to: number) => {
    const arr = mWeeks.get(k)!;
    arr[arr.indexOf(from)] = to;
  };

  let improved = true;
  let guard = 0;
  while (improved && guard++ < 60) {
    improved = false;
    for (let i = 0; i < items.length; i++) {
      for (let j = i + 1; j < items.length; j++) {
        const a = items[i];
        const b = items[j];
        if (a.w === b.w) continue;
        const ka = matchupKey(a.p.home, a.p.away);
        const kb = matchupKey(b.p.home, b.p.away);
        // a moves to b.w, b moves to a.w — reject if it would exceed a week's
        // game nights or duplicate a matchup in a week.
        const teams = [...new Set([a.p.home, a.p.away, b.p.home, b.p.away])];
        const before =
          teams.reduce((s, t) => s + teamCost(t), 0) +
          (ka === kb ? matchupCost(ka) : matchupCost(ka) + matchupCost(kb));

        // apply
        for (const t of [a.p.home, a.p.away]) {
          bump(t, a.w, -1);
          bump(t, b.w, +1);
        }
        for (const t of [b.p.home, b.p.away]) {
          bump(t, b.w, -1);
          bump(t, a.w, +1);
        }
        if (ka !== kb) {
          swapMatchupWeek(ka, a.w, b.w);
          swapMatchupWeek(kb, b.w, a.w);
        }
        const valid =
          teamIds.every((t) => {
            const m = cnt.get(t)!;
            return (m.get(a.w) ?? 0) <= maxPer.get(a.w)! &&
              (m.get(b.w) ?? 0) <= maxPer.get(b.w)!;
          }) &&
          !hasDupMatchup(items, i, j, a.w, b.w);
        const after =
          teams.reduce((s, t) => s + teamCost(t), 0) +
          (ka === kb ? matchupCost(ka) : matchupCost(ka) + matchupCost(kb));

        if (valid && after < before - 1e-9) {
          const tw = a.w;
          a.w = b.w;
          b.w = tw;
          improved = true;
        } else {
          for (const t of [a.p.home, a.p.away]) {
            bump(t, b.w, -1);
            bump(t, a.w, +1);
          }
          for (const t of [b.p.home, b.p.away]) {
            bump(t, a.w, -1);
            bump(t, b.w, +1);
          }
          if (ka !== kb) {
            swapMatchupWeek(ka, b.w, a.w);
            swapMatchupWeek(kb, a.w, b.w);
          }
        }
      }
    }
  }

  for (const { week } of weekCaps) byWeek.set(week, []);
  for (const { p, w } of items) byWeek.get(w)!.push(p);
}

/** After tentatively swapping items i and j, does any team play the same
 * matchup twice in week wa or wb? */
function hasDupMatchup(
  items: { p: Pairing; w: number }[],
  i: number,
  j: number,
  wa: number,
  wb: number,
): boolean {
  for (const w of [wa, wb]) {
    const seen = new Set<string>();
    for (let x = 0; x < items.length; x++) {
      const wx = x === i ? wb : x === j ? wa : items[x].w;
      if (wx !== w) continue;
      const k = matchupKey(items[x].p.home, items[x].p.away);
      if (seen.has(k)) return true;
      seen.add(k);
    }
  }
  return false;
}

/**
 * Phase N — drop one week's games onto that week's nights. A team plays at most
 * once per night, so its (≤ maxPer) games land on different nights, which keeps
 * each team's weekday split even. Ice slots are packed in order here and owned by
 * the later balance/refine passes, so this only tracks the season weekday counter
 * (which seeds those passes) and appends to `out`.
 */
function placeWeek(
  weekPairings: Pairing[],
  nightIdx: number[],
  nights: Night[],
  meta: Meta,
  seasonWd: Map<string, number[]>,
  out: ScheduledGame[],
): number {
  const k = weekPairings.length;
  const m = nightIdx.length;

  let best: number[] | null = null;

  // Choose which night each game plays on, minimizing weekday imbalance. For a
  // normal week (a few nights, a handful of games) brute-force every assignment
  // (m^k) for the optimum; for pathologically dense weeks fall back to greedy.
  if (Math.pow(m, k) <= 20_000) {
    const assign = new Array<number>(k);
    let bestCost = Infinity;
    const rec = (i: number) => {
      if (i === k) {
        const perCount = new Array(m).fill(0);
        const onNight = nightIdx.map(() => new Set<string>());
        for (let j = 0; j < k; j++) {
          const ai = assign[j];
          if (++perCount[ai] > nights[nightIdx[ai]].slots.length) return;
          const p = weekPairings[j];
          if (onNight[ai].has(p.home) || onNight[ai].has(p.away)) return;
          onNight[ai].add(p.home);
          onNight[ai].add(p.away);
        }
        const added = new Map<string, number[]>();
        for (let j = 0; j < k; j++) {
          const wi = meta.nightW[nightIdx[assign[j]]];
          for (const t of [weekPairings[j].home, weekPairings[j].away]) {
            const v = added.get(t) ?? meta.usedWeekdays.map(() => 0);
            v[wi]++;
            added.set(t, v);
          }
        }
        let cost = 0;
        for (const [t, v] of added) {
          const merged = seasonWd.get(t)!.map((x, idx) => x + v[idx]);
          cost += sq(merged) + BALANCE_W * Math.max(0, spread(merged) - 1);
        }
        if (cost < bestCost) {
          bestCost = cost;
          best = [...assign];
        }
        return;
      }
      for (let ai = 0; ai < m; ai++) {
        assign[i] = ai;
        rec(i + 1);
      }
    };
    rec(0);
  }

  // Greedy fallback: first-fit each game onto the least-loaded weekday night that
  // has room and neither team already playing.
  if (!best) {
    best = new Array(k).fill(0);
    const perCount = new Array(m).fill(0);
    const onNight = nightIdx.map(() => new Set<string>());
    for (let j = 0; j < k; j++) {
      const p = weekPairings[j];
      let bestA = -1;
      let bestC = Infinity;
      for (let a = 0; a < m; a++) {
        const ni = nightIdx[a];
        if (onNight[a].has(p.home) || onNight[a].has(p.away)) continue;
        if (perCount[a] >= nights[ni].slots.length) continue;
        const wi = meta.nightW[ni];
        const c =
          seasonWd.get(p.home)![wi] + seasonWd.get(p.away)![wi] + perCount[a] * 0.01;
        if (c < bestC) {
          bestC = c;
          bestA = a;
        }
      }
      // No legal night (a team would play twice, or all rooms full): strand it
      // rather than break the no-team-twice-a-night invariant.
      best[j] = bestA;
      if (bestA < 0) continue;
      perCount[bestA]++;
      onNight[bestA].add(p.home);
      onNight[bestA].add(p.away);
    }
  }

  const perNight = nightIdx.map(() => [] as Pairing[]);
  let stranded = 0;
  for (let j = 0; j < k; j++) {
    if (best[j] < 0) stranded++;
    else perNight[best[j]].push(weekPairings[j]);
  }
  for (let x = 0; x < m; x++) {
    const ni = nightIdx[x];
    const ps = perNight[x];
    // Pack into slots in order; ice-time balance is owned by the later passes.
    for (let s = 0; s < ps.length; s++) {
      const p = ps[s];
      seasonWd.get(p.home)![meta.nightW[ni]]++;
      seasonWd.get(p.away)![meta.nightW[ni]]++;
      out.push({
        home: p.home,
        away: p.away,
        round: p.round,
        scheduledAt: `${nights[ni].date}T${nights[ni].slots[s]}:00`,
        nightIndex: ni,
        slotIndex: s,
      });
    }
  }
  return stranded;
}

export function assignNights(
  pairings: Pairing[],
  nights: Night[],
  teamIds: string[],
): { games: ScheduledGame[]; report: BalanceReport } {
  const meta = buildMeta(nights);
  const smeta = buildNightMeta(nights);
  const weekCaps = weekCapacities(nights, smeta);

  // Phase W: assign games to weeks (byes/same-week/rematch spacing structural).
  const { byWeek, unscheduled } = assignToWeeks(pairings, teamIds, weekCaps);

  // Phase N: assign each week's games to its nights (initial weekday split),
  // tracking a season-long weekday counter so it evens out across the schedule.
  const games: ScheduledGame[] = [];
  const seasonWd = new Map<string, number[]>(
    teamIds.map((t) => [t, meta.usedWeekdays.map(() => 0)]),
  );
  let stranded = 0;
  for (const { nightIdx, week } of weekCaps) {
    stranded += placeWeek(byWeek.get(week)!, nightIdx, nights, meta, seasonWd, games);
  }

  // Drive weekday balance (#1) to optimal by re-picking each week's night
  // assignment, then polish ice-time + spacing (#2–#4) with weekday-preserving
  // swaps. Both are same-week only, so Phase W's bye/rematch structure is fixed.
  balanceWeekdays(games, nights, meta, smeta, teamIds);
  refineSpacing(games, nights, teamIds, meta, smeta);

  // Derive the report from the final placement.
  const { slot: finalSlot, wd: nightTally } = vectorsOf(games, teamIds, meta);
  const finalGp = new Map<string, number>(teamIds.map((t) => [t, 0]));
  const pairingTally = new Map<string, number>();
  const meetings = new Map<string, number[]>();
  for (const g of games) {
    finalGp.set(g.home, finalGp.get(g.home)! + 1);
    finalGp.set(g.away, finalGp.get(g.away)! + 1);
    const mk = matchupKey(g.home, g.away);
    pairingTally.set(mk, (pairingTally.get(mk) ?? 0) + 1);
    (meetings.get(mk) ?? meetings.set(mk, []).get(mk)!).push(g.nightIndex);
  }

  let minGap: number | null = null;
  for (const nis of meetings.values()) {
    if (nis.length < 2) continue;
    nis.sort((a, b) => a - b);
    for (let i = 1; i < nis.length; i++) {
      const gap = nis[i] - nis[i - 1];
      minGap = minGap == null ? gap : Math.min(minGap, gap);
    }
  }

  return {
    games,
    report: {
      totalScheduled: games.length,
      unscheduled: unscheduled + stranded,
      gamesPerTeam: teamIds.map((t) => ({ team: t, count: finalGp.get(t)! })),
      slotShareByTeam: teamIds.map((t) => ({ team: t, counts: finalSlot.get(t)! })),
      weekdays: meta.usedWeekdays.map((d) => WEEKDAY[d]),
      nightShareByTeam: teamIds.map((t) => ({ team: t, counts: nightTally.get(t)! })),
      pairingCounts: [...pairingTally.entries()].map(([matchup, count]) => ({
        matchup,
        count,
      })),
      minRematchGapNights: minGap,
      spacing: spacingReport(games, nights, teamIds),
    },
  };
}
