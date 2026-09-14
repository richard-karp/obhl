import type { Pairing } from "./roundRobin";
import { weekdayOf } from "@/lib/format";
import {
  buildNightMeta,
  teamSpacingCost,
  matchupSpacingCost,
  spacingReport,
  iceOutcome,
  compareIceOutcome,
  type NightMeta,
  type SpacingReport,
} from "./spacing";
import {
  byeRuleCost,
  solveParticipation,
  type Participation,
  type ParticipationNight,
} from "./participation";
import { assignMatchups, type MatchupResult } from "./matchups";
import { assignSlots } from "./slots";
import { improveNightOrder } from "./nightOrder";
import { mulberry32 } from "./rng";
import {
  evaluateConstraints,
  noConstraints,
  type ConstraintOutcome,
  type ResolvedConstraints,
} from "./constraints";

// ⚠️ Two planners and the phase order are deliberate; the better plan wins by `rankSchedule`.
// RUNBOOK.md, _Schedule generator_.

export type Night = { date: string; slots: string[] }; // slots are "HH:MM"

export type ScheduledGame = {
  home: string;
  away: string;
  round: number;
  scheduledAt: string; // naive "YYYY-MM-DDTHH:MM:00"
  nightIndex: number;
  slotIndex: number;
};

/** ⛔ The one way to form `scheduledAt`, the only placement field that persists: every
 *  move between (night, slot) goes through it. RUNBOOK.md, _Schedule generator_. */
const slotStamp = (nights: Night[], ni: number, s: number) =>
  `${nights[ni].date}T${nights[ni].slots[s]}:00`;

export type BalanceReport = {
  totalScheduled: number;
  unscheduled: number;
  gamesPerTeam: { team: string; count: number }[];
  slotShareByTeam: { team: string; counts: number[] }[];
  weekdays: string[];
  nightShareByTeam: { team: string; counts: number[] }[];
  pairingCounts: { matchup: string; count: number }[];
  minRematchGapNights: number | null;
  /** Raw, without forced-bye credits, on purpose. Present it through `presentSpacing`
   *  (`constraints.ts`), never by hand, so what a manager reads and a test asserts agree. */
  spacing: SpacingReport;
  constraints: ConstraintOutcome[];
};

export type AssignOptions = {
  /** Manager constraints, already resolved against these exact nights. */
  constraints?: ResolvedConstraints;
  /** ⚠️ Default 1, and it must stay 1, so a season regenerated without it comes back the same.
   *  It must reach Phase P's sweep, Phase S and night order: Phase M's seed alone moves nothing. */
  seed?: number;
  /** Seeds to draw from; omitted means decided by game count. ⚠️ Clamped: a caller can only
   *  reduce it (`generateSchedule`'s single-draw retry), never raise it. */
  variations?: number;
};

const matchupKey = (a: string, b: string) => [a, b].sort().join("|");

const WEEKDAY = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

// ⚠️ Must exceed the largest spacing swing one swap can produce (well under ~30k), so
// weekday balance is never traded for spacing. Raise it if the `SPACING_W` weights grow.
const BALANCE_W = 100_000;
// ⚠️ Missing, blank or unparseable falls back to the default: a typo in an environment
// variable must not quietly turn the search off.
function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw == null || raw === "") return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}
// ⛔ 1,000, not more: more restarts can return a worse schedule. `vitest.config.ts` must not
// set it (`assignNights.test.ts` asserts so). RUNBOOK.md, _Schedule generator_; _Standing gates_.
const SLOT_RESTARTS = envInt("OBHL_SLOT_RESTARTS", 1_000);
const SLOT_BUDGET_MS = envInt("OBHL_SLOT_BUDGET_MS", 5_000);

// ⚠️ No single weight wins everywhere. 160 must stay, so the result can't fall below the
// single-weight search; 140 repeats on purpose. RUNBOOK.md, _Schedule generator_.
const SLOT_CANDIDATES: { streak3W: number; seed: number }[] = [
  { streak3W: 160, seed: 1 },
  { streak3W: 140, seed: 1 },
  { streak3W: 140, seed: 2 },
  { streak3W: 140, seed: 3 },
  { streak3W: 200, seed: 1 },
];

// The builder's progress estimate: typical, not a bound.
const PHASE_PM_ALLOWANCE_MS = 1_500;
const NIGHT_ORDER_ALLOWANCE_MS = 1_500;
export const estimatedGenerateMs = () =>
  SLOT_CANDIDATES.length * SLOT_BUDGET_MS +
  PHASE_PM_ALLOWANCE_MS +
  NIGHT_ORDER_ALLOWANCE_MS;

/** ⚠️ Fixed and ordered, for repeatable output. The budget must let every seed run (~700 ms
 *  measured): a sweep cut short depends on the machine. Raise it, not the seed list. */
const PLATEAU_SEEDS = [1, 2, 3, 4, 5, 6, 7, 8];
const PLATEAU_SAMPLE_MS = 3_000;
// Restarts are the dominant runtime lever: keep them few, fewer as the game count grows.
const HILLCLIMB_PASSES = 30;
function ilsRestartsFor(gameCount: number): number {
  if (gameCount <= 80) return 40;
  if (gameCount <= 120) return 10;
  if (gameCount <= 200) return 4;
  return 2;
}

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
const spread = (a: number[]) =>
  a.length ? Math.max(...a) - Math.min(...a) : 0;

function swapLegal(
  g1: ScheduledGame,
  g2: ScheduledGame,
  nights: Night[],
  nightTeams: Set<string>[],
): boolean {
  const { nightIndex: n1, slotIndex: s1 } = g1;
  const { nightIndex: n2, slotIndex: s2 } = g2;
  if (n1 === n2) return s1 !== s2;
  if (s1 >= nights[n2].slots.length || s2 >= nights[n1].slots.length)
    return false;
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
  g1.scheduledAt = slotStamp(nights, n2, s2);
  g2.nightIndex = n1;
  g2.slotIndex = s1;
  g2.scheduledAt = slotStamp(nights, n1, s1);
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
      if (week && week[games[i].nightIndex] !== week[games[j].nightIndex])
        continue;
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
    games[i].scheduledAt = slotStamp(nights, snap[i].n, snap[i].s);
  }
}

function weekdayPenalty(v: number[]): number {
  return BALANCE_W * Math.max(0, spread(v) - 1) + sq(v);
}

/** `assign[j]` is game j's LOCAL night index within its week. */
type WeekColoring = { assign: number[]; contrib: Map<string, number[]> };

/** ⚠️ Recolours whole weeks, not pairwise swaps, which stall on exact-fit weeks; same-week
 *  only, so Phase W's bye and rematch structure holds. Mutates `games`. */
function balanceWeekdays(
  games: ScheduledGame[],
  nights: Night[],
  bmeta: Meta,
  smeta: NightMeta,
  teamIds: string[],
): void {
  if (games.length < 2 || bmeta.usedWeekdays.length < 2) return;
  const nw = bmeta.usedWeekdays.length;

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

  const enumerateColorings = (
    gis: number[],
    nightIdx: number[],
  ): WeekColoring[] => {
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
    const ceilT = new Map(
      tids.map((t) => [t, Math.ceil(totalGames.get(t)! / weekdays)]),
    );
    const floorT = new Map(
      tids.map((t) => [t, Math.floor(totalGames.get(t)! / weekdays)]),
    );
    const order = [...sts].sort((a, b) => a.options.length - b.options.length);
    const suffix: Map<string, number>[] = new Array(order.length + 1);
    suffix[order.length] = new Map(tids.map((t) => [t, 0]));
    for (let i = order.length - 1; i >= 0; i--) {
      const m = new Map(suffix[i + 1]);
      for (const gi of order[i].gis) {
        for (const t of [gs[gi].home, gs[gi].away])
          m.set(t, (m.get(t) ?? 0) + 1);
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
            if (r[d] + v[d] > cap) {
              ok = false;
              break;
            }
          }
          if (!ok) break;
        }
        if (!ok) continue;
        for (const [t, v] of c.contrib) {
          const r = run.get(t)!;
          for (let d = 0; d < weekdays; d++) r[d] += v[d];
        }
        let feasible = true;
        for (const t of tids) {
          const r = run.get(t)!;
          const f = floorT.get(t)!;
          let deficit = 0;
          for (let d = 0; d < weekdays; d++) if (r[d] < f) deficit += f - r[d];
          if (deficit > (rem.get(t) ?? 0)) {
            feasible = false;
            break;
          }
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
  // ⚠️ Gate on spread, not `totalPenalty`: the sum-of-squares keeps that above 0 even
  // when every team is already as even as possible.
  const hasImbalance = () => teamIds.some((t) => spread(totals.get(t)!) >= 2);

  // Descent, then annealing: reconciling two imbalances takes penalty-neutral steps
  // that a strict descent refuses.
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

  localSearchWeekdays();
  if (hasImbalance()) solveEvenAssignment(states, teamIds, nw, games);

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
        g.scheduledAt = slotStamp(nights, ni, s);
      });
    }
  }
}

/** Priorities 2–4 by swaps that never worsen a team's weekday spread. */
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
    (matchupNights.get(k) ?? matchupNights.set(k, []).get(k)!).push(
      g.nightIndex,
    );
  }

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
          if (smeta.week[n1] !== smeta.week[n2]) continue;
          const s1 = g1.slotIndex;
          const s2 = g2.slotIndex;
          const w1 = bmeta.nightW[n1];
          const w2 = bmeta.nightW[n2];
          const k1 = matchupKey(g1.home, g1.away);
          const k2 = matchupKey(g2.home, g2.away);
          const teams = [...new Set([g1.home, g1.away, g2.home, g2.away])];
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
      (matchupNights.get(k) ?? matchupNights.set(k, []).get(k)!).push(
        g.nightIndex,
      );
      nightTeams[g.nightIndex].add(g.home);
      nightTeams[g.nightIndex].add(g.away);
    }
  }
}

type WeekCap = {
  week: number;
  nightIdx: number[];
  cap: number;
  maxPer: number;
};

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

// ⚠️ `NEED_W` must dominate `SPREAD_W`: need decides which teams play (light and full
// weeks alternate); rematch spacing only picks which matchup.
const NEED_W = 10_000;
const SPREAD_W = 600;

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

const MISS_W = 100_000;
const CONSEC_W = 1_000;
const REMATCH_WK_W = 100;

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
    const ws = [...mWeeks.get(k)!].sort(
      (a, b) => order.get(a)! - order.get(b)!,
    );
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
        const teams = [...new Set([a.p.home, a.p.away, b.p.home, b.p.away])];
        const before =
          teams.reduce((s, t) => s + teamCost(t), 0) +
          (ka === kb ? matchupCost(ka) : matchupCost(ka) + matchupCost(kb));

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
            return (
              (m.get(a.w) ?? 0) <= maxPer.get(a.w)! &&
              (m.get(b.w) ?? 0) <= maxPer.get(b.w)!
            );
          }) && !hasDupMatchup(items, i, j, a.w, b.w);
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
          seasonWd.get(p.home)![wi] +
          seasonWd.get(p.away)![wi] +
          perCount[a] * 0.01;
        if (c < bestC) {
          bestC = c;
          bestA = a;
        }
      }
      // No legal night: strand it rather than break no-team-twice-a-night.
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
    for (let s = 0; s < ps.length; s++) {
      const p = ps[s];
      seasonWd.get(p.home)![meta.nightW[ni]]++;
      seasonWd.get(p.away)![meta.nightW[ni]]++;
      out.push({
        home: p.home,
        away: p.away,
        round: p.round,
        scheduledAt: slotStamp(nights, ni, s),
        nightIndex: ni,
        slotIndex: s,
      });
    }
  }
  return stranded;
}

type Plan = { games: ScheduledGame[]; unscheduled: number };

/** ⚠️ The fallback (Phase W, then N) for shapes `planByParticipation` declines: keep it.
 *  It cannot honour constraints. RUNBOOK.md, _Schedule generator_. */
function planByWeeks(
  pairings: Pairing[],
  nights: Night[],
  teamIds: string[],
  meta: Meta,
  smeta: NightMeta,
): Plan {
  const weekCaps = weekCapacities(nights, smeta);

  const { byWeek, unscheduled } = assignToWeeks(pairings, teamIds, weekCaps);

  const games: ScheduledGame[] = [];
  const seasonWd = new Map<string, number[]>(
    teamIds.map((t) => [t, meta.usedWeekdays.map(() => 0)]),
  );
  let stranded = 0;
  for (const { nightIdx, week } of weekCaps) {
    stranded += placeWeek(
      byWeek.get(week)!,
      nightIdx,
      nights,
      meta,
      seasonWd,
      games,
    );
  }

  balanceWeekdays(games, nights, meta, smeta, teamIds);
  refineSpacing(games, nights, teamIds, meta, smeta);
  return { games, unscheduled: unscheduled + stranded };
}

export function distributeGames(
  caps: number[],
  total: number,
): number[] | null {
  const n = caps.length;
  if (n === 0) return total === 0 ? [] : null;
  const out = caps.map(
    (_, i) => Math.floor(((i + 1) * total) / n) - Math.floor((i * total) / n),
  );
  let overflow = 0;
  for (let i = 0; i < n; i++) {
    if (out[i] > caps[i]) {
      overflow += out[i] - caps[i];
      out[i] = caps[i];
    }
  }
  for (let i = 0; i < n && overflow > 0; i++) {
    const room = Math.min(caps[i] - out[i], overflow);
    out[i] += room;
    overflow -= room;
  }
  return overflow > 0 ? null : out;
}

function planByParticipation(
  pairings: Pairing[],
  nights: Night[],
  teamIds: string[],
  meta: Meta,
  smeta: NightMeta,
  resolved: ResolvedConstraints,
  seedOffset: number,
): Plan | null {
  const T = teamIds.length;
  const N = nights.length;
  if (T < 2 || N === 0 || pairings.length === 0) return null;

  const index = new Map(teamIds.map((t, i) => [t, i]));
  const gamesPerTeam = new Array(T).fill(0);
  const targets = Array.from({ length: T }, () => new Array<number>(T).fill(0));
  // Round order, so the caller's home/away alternation survives placement.
  const queues = new Map<string, Pairing[]>();
  for (const p of pairings) {
    const a = index.get(p.home);
    const b = index.get(p.away);
    if (a === undefined || b === undefined) return null; // unknown team: bail
    gamesPerTeam[a]++;
    gamesPerTeam[b]++;
    targets[a][b]++;
    targets[b][a]++;
    const k = matchupKey(p.home, p.away);
    (queues.get(k) ?? queues.set(k, []).get(k)!).push(p);
  }
  for (const q of queues.values()) q.sort((x, y) => x.round - y.round);

  const caps = nights.map((n) => Math.min(n.slots.length, Math.floor(T / 2)));
  const perNight = distributeGames(caps, pairings.length);
  if (!perNight) return null;

  const pnights: ParticipationNight[] = nights.map((n, i) => ({
    week: smeta.week[i],
    weekday: meta.nightW[i],
    games: perNight[i],
  }));

  // Loosen the weekday split one rung at a time. ⚠️ Keep the unpinned rungs: pinned quotas
  // ignore slack, so a calendar that can't pack them fails all three pinned rungs alike.
  const rungs = [
    { slack: 0, exact: true },
    { slack: 1, exact: true },
    { slack: 2, exact: true },
    { slack: 0, exact: false },
    { slack: 1, exact: false },
    { slack: 2, exact: false },
  ];
  // ⚠️ One deadline for the whole ladder, not one per rung, or a slow rung costs six times.
  const solve = (budgetMs: number, seed: number): Participation | null => {
    const until = Date.now() + budgetMs;
    for (const { slack, exact } of rungs) {
      const remaining = until - Date.now();
      if (remaining <= 0) break;
      const p = solveParticipation({
        teamCount: T,
        nights: pnights,
        gamesPerTeam,
        weekdayCount: meta.usedWeekdays.length,
        weekdaySlack: slack,
        exactWeekdayTargets: exact,
        timeBudgetMs: remaining,
        seed,
        // Undefined when unconstrained, so the solver runs exactly as without constraints.
        forced: resolved.empty ? undefined : resolved.forced,
        byeInWeek: resolved.empty ? undefined : resolved.byeInWeek,
      });
      if (p) return p;
    }
    return null;
  };
  const match = (p: Participation) => {
    const m = assignMatchups({
      teamCount: T,
      plays: p.plays,
      nightWeek: smeta.week,
      nightWeekday: smeta.weekday,
      targets,
      restarts: pairings.length <= 200 ? 12 : 4,
      seed: 1 + seedOffset,
    });
    // ⚠️ Any multiplicity error changes how often a pair meets: never accept one.
    return m && m.multiplicityError === 0 ? m : null;
  };

  /** The rank prefix Phases P and M decide. ⚠️ The pairing weekday split is not a tiebreak
   *  here on purpose: it belongs in `pairCost`, where the search can pursue it. */
  const plateauScore = (p: Participation, m: MatchupResult): number[] => [
    p.byeAdjNight,
    p.weekdaySpread,
    p.byeMultiWeek,
    p.byeConsecWeekSameDay,
    p.byeConsecWeek,
    m.spacingCost,
  ];

  let part = solve(300, PLATEAU_SEEDS[0] + seedOffset);
  if (!part) return null;
  let matched = match(part);
  if (!matched) return null;
  if (!part.optimal) {
    const better = solve(4_000, PLATEAU_SEEDS[0] + seedOffset);
    if (better && byeRuleCost(better) < byeRuleCost(part)) {
      const m = match(better);
      if (m) {
        part = better;
        matched = m;
      }
    }
  }

  // Phase P's optimum is a plateau whose rematch spacing varies by seed at equal bye cost,
  // so sample it and keep the best rather than leave it to one seed.
  const sampleUntil = Date.now() + PLATEAU_SAMPLE_MS;
  let bestScore = plateauScore(part, matched);
  for (const seed of PLATEAU_SEEDS.slice(1).map((x) => x + seedOffset)) {
    if (Date.now() > sampleUntil) break;
    const p = solve(300, seed);
    if (!p) continue;
    const m = match(p);
    if (!m) continue;
    const score = plateauScore(p, m);
    if (rankLess(score, bestScore)) {
      part = p;
      matched = m;
      bestScore = score;
    }
  }

  // `slot_on` pins reuse `assignSlots`' `initial`/`pinned`. ⚠️ A pin naming no real game is
  // dropped, not forced: forcing it corrupts the night's permutation, and it reports unmet.
  const pinsByNight = new Map<number, { gi: number; slot: number }[]>();
  if (!resolved.empty) {
    for (const pin of resolved.slotPins) {
      const pairs = matched.pairsByNight[pin.night];
      if (!pairs || pin.slot >= pairs.length) continue;
      const gi = pairs.findIndex(([a, b]) => a === pin.team || b === pin.team);
      if (gi < 0) continue;
      const list = pinsByNight.get(pin.night) ?? [];
      if (list.some((x) => x.gi === gi || x.slot === pin.slot)) continue;
      list.push({ gi, slot: pin.slot });
      pinsByNight.set(pin.night, list);
    }
  }
  const initial: (number[] | undefined)[] = matched.pairsByNight.map(
    (pairs, n) => {
      const list = pinsByNight.get(n);
      if (!list) return undefined;
      const perm = new Array<number>(pairs.length).fill(-1);
      const taken = new Array<boolean>(pairs.length).fill(false);
      for (const { gi, slot } of list) {
        perm[gi] = slot;
        taken[slot] = true;
      }
      let next = 0;
      for (let gi = 0; gi < pairs.length; gi++) {
        if (perm[gi] >= 0) continue;
        while (taken[next]) next++;
        perm[gi] = next;
        taken[next] = true;
      }
      return perm;
    },
  );

  const slotArgs = {
    teamCount: T,
    pairsByNight: matched.pairsByNight,
    slotsPerNight: nights.map((n) => n.slots.length),
    weekdayOfNight: meta.nightW,
    restarts: SLOT_RESTARTS,
    timeBudgetMs: SLOT_BUDGET_MS,
    // ⚠️ Every candidate shares these, so all five carry the same pins and bias.
    ...(pinsByNight.size > 0
      ? {
          initial,
          pinned: matched.pairsByNight.map((_, n) =>
            pinsByNight.get(n)?.map((x) => x.gi),
          ),
        }
      : {}),
    ...(resolved.biases.length > 0 ? { biases: resolved.biases } : {}),
  };

  const outcomeFor = (s: number[][]) =>
    iceOutcome({
      teamCount: T,
      pairsByNight: matched.pairsByNight,
      slotOf: s,
      weekdayOfNight: meta.nightW,
      // ⛔ The bias must reach `compareIceOutcome`, not only `assignSlots`, or best-of-five
      // ignores it. RUNBOOK.md, _Schedule generator_.
      biases: resolved.biases.length > 0 ? resolved.biases : undefined,
    });

  let slotOf = assignSlots({
    ...slotArgs,
    ...SLOT_CANDIDATES[0],
    seed: SLOT_CANDIDATES[0].seed + seedOffset,
  });
  let bestOutcome = outcomeFor(slotOf);
  for (const cand of SLOT_CANDIDATES.slice(1)) {
    const trial = assignSlots({
      ...slotArgs,
      ...cand,
      seed: cand.seed + seedOffset,
    });
    const out = outcomeFor(trial);
    if (compareIceOutcome(out, bestOutcome) < 0) {
      slotOf = trial;
      bestOutcome = out;
    }
  }

  const games: ScheduledGame[] = [];
  matched.pairsByNight.forEach((pairs, ni) => {
    pairs.forEach(([a, b], gi) => {
      const p = queues.get(matchupKey(teamIds[a], teamIds[b]))!.shift();
      if (!p) return;
      const s = slotOf[ni][gi];
      games.push({
        home: p.home,
        away: p.away,
        round: p.round,
        scheduledAt: slotStamp(nights, ni, s),
        nightIndex: ni,
        slotIndex: s,
      });
    });
  });
  if (games.length !== pairings.length) return null;
  return { games, unscheduled: 0 };
}

/** ⚠️ Every metric the search targets must appear, or `planByWeeks` wins on an unranked one;
 *  `longestLayoffDays` is left out on purpose. Order: RUNBOOK.md, _Schedule generator_. */
function rankSchedule(
  plan: Plan,
  nights: Night[],
  teamIds: string[],
  meta: Meta,
): number[] {
  return rankFromReport(
    plan,
    spacingReport(plan.games, nights, teamIds),
    teamIds,
    meta,
  );
}

/** `rankSchedule` off a report already computed: the night-order pass can't pay for two. */
function rankFromReport(
  plan: Plan,
  r: SpacingReport,
  teamIds: string[],
  meta: Meta,
): number[] {
  const { slot, wd } = vectorsOf(plan.games, teamIds, meta);
  const sum = (f: (t: string) => number) =>
    teamIds.reduce((s, t) => s + f(t), 0);
  return [
    plan.unscheduled,
    r.byesAdjNight,
    sum((t) => spread(wd.get(t)!)),
    r.byesMultiWeek,
    r.byesConsecWeekSameDay,
    r.byesConsecWeek,
    r.rematchSameWeek,
    r.rematchAdjNight,
    r.rematchConsecWeekSameDay,
    r.rematchConsecWeek,
    r.pairingWeekdayExcess,
    r.slotWeekdaySpread,
    sum((t) => spread(slot.get(t)!)),
    r.slotStreak3,
    r.slotConsecutive,
    r.slotClusterWorstTeam,
    r.slotClusterWindows,
  ];
}

function rankLess(a: number[], b: number[]): boolean {
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return a[i] < b[i];
  }
  return false;
}

/** ⛔ Keyed on game count, never the clock: a clock-sized count makes the schedule depend
 *  on the hardware. RUNBOOK.md, _Schedule generator_. */
function variationsFor(gameCount: number): number {
  if (gameCount <= 80) return 4;
  if (gameCount <= 120) return 2;
  return 1;
}

/** Repeats for a given input while the search finishes inside its time budget. ⛔ Best of
 *  a seed block, never a blind reroll: a reroll can return a worse schedule. */
export function assignNights(
  pairings: Pairing[],
  nights: Night[],
  teamIds: string[],
  options?: AssignOptions,
): ReturnType<typeof assignNightsOnce> {
  const resolved = options?.constraints ?? noConstraints();
  // ⚠️ Not gated on `resolved.empty`: with night order on every season, one pinned season's
  // worst team goes 15 -> 5 with the block and 15 -> 14 without.
  const auto = variationsFor(pairings.length);
  const n = Math.max(1, Math.min(options?.variations ?? auto, auto));
  const base = options?.seed ?? 1;
  if (n === 1) return assignNightsOnce(pairings, nights, teamIds, options);

  const meta = buildMeta(nights);
  // ⛔ Don't "simplify" to plain `rankFromReport`: clustering must outrank `slotConsecutive`
  // here, or best-of-4 can pick worse clustering than the single default draw.
  const rankOf = (r: ReturnType<typeof assignNightsOnce>) => {
    const v = rankFromReport(
      { games: r.games, unscheduled: r.report.unscheduled },
      r.report.spacing,
      teamIds,
      meta,
    );
    const [consec, worst, windows] = v.slice(v.length - 3);
    return [
      // ⛔ Unmet requests first: no other term sees them, so a block could drop a met one.
      // A constant 0 on an unconstrained season (`constraints: []`), so safe to put first.
      r.report.constraints.filter((x) => !x.satisfied).length,
      ...v.slice(0, v.length - 3),
      worst,
      windows,
      consec,
    ];
  };
  let best = assignNightsOnce(pairings, nights, teamIds, {
    ...options,
    seed: (base - 1) * n + 1,
  });
  let bestRank = rankOf(best);
  for (let i = 1; i < n; i++) {
    const trial = assignNightsOnce(pairings, nights, teamIds, {
      ...options,
      seed: (base - 1) * n + 1 + i,
    });
    const rank = rankOf(trial);
    if (rankLess(rank, bestRank)) {
      best = trial;
      bestRank = rank;
    }
  }
  return best;
}

function assignNightsOnce(
  pairings: Pairing[],
  nights: Night[],
  teamIds: string[],
  options?: AssignOptions,
): {
  games: ScheduledGame[];
  report: BalanceReport;
  /** Team-index pairs per night, in the order this night's games were placed. */
  pairsByNight: [number, number][][];
  /** The ice-time slot of each of those pairs, same indexing. */
  slotOf: number[][];
  /** Weekday index (into `report.weekdays`) of each night. */
  weekdayOfNight: number[];
} {
  const meta = buildMeta(nights);
  const smeta = buildNightMeta(nights);
  const resolved = options?.constraints ?? noConstraints();
  const seedOffset = ((options?.seed ?? 1) - 1) * 1000;

  let plan = planByWeeks(pairings, nights, teamIds, meta, smeta);
  const exact = planByParticipation(
    pairings,
    nights,
    teamIds,
    meta,
    smeta,
    resolved,
    seedOffset,
  );

  // ⛔ `planByWeeks` cannot honour constraints, so when a request moves the participation
  // matrix, Phase P ships whenever it found a plan; otherwise the rank-off decides.
  // ⛔ Not gated on `!empty`: forcing Phase P for a bias-only set cost a bye breach and
  // bought no satisfaction (8/12 either way), so a bias stays in the rank-off.
  const needsPhaseP =
    resolved.forced.length > 0 ||
    resolved.byeInWeek.length > 0 ||
    resolved.slotPins.length > 0;
  if (needsPhaseP) {
    if (exact) plan = exact;
  } else if (
    exact &&
    rankLess(
      rankSchedule(exact, nights, teamIds, meta),
      rankSchedule(plan, nights, teamIds, meta),
    )
  ) {
    plan = exact;
  }
  // ⚠️ Which plan shipped, not which was preferred: with Phase P null the fallback ships.
  const plannerHonours = plan === exact;

  // ⛔ Class-gated, not constraint-gated or off: a free permutation can move a met pin (no
  // rank term sees it), and switching the pass off took one pinned season's worst team 5 -> 15.
  // ⛔ Rewrite `scheduledAt` with `nightIndex`, always, through `slotStamp`: only
  // `scheduledAt` persists. RUNBOOK.md, _Schedule generator_.
  /** ⛔ Only nights with the same label swap, and the label must cover every position-sensitive
   *  field: `forced`/`slotPins` (night), `byeInWeek` (week), each bias's window bit. */
  const nightClass = (() => {
    const fixed = new Set<number>();
    for (const f of resolved.forced) fixed.add(f.night);
    for (const sp of resolved.slotPins) fixed.add(sp.night);
    const namedWeeks = new Set(resolved.byeInWeek.map((b) => b.week));
    return nights.map((_, n) => {
      if (fixed.has(n)) return `FIX${n}`;
      const wk = namedWeeks.has(smeta.week[n]) ? `W${smeta.week[n]}` : "-";
      const bias = resolved.biases
        .map((b) => (b.nights[n] ? "1" : "0"))
        .join("");
      return `${wk}|${bias}`;
    });
  })();
  {
    const baseReport = spacingReport(plan.games, nights, teamIds);
    const baseRank = rankFromReport(plan, baseReport, teamIds, meta);
    // The last two rank entries are clustering; everything above them must not get worse.
    const CLUSTER_TAIL = 2;
    const worstOf = (v: number[]) => v[v.length - 2];
    const totalOf = (v: number[]) => v[v.length - 1];

    // ⚠️ A permutation carries slot indexes, so a 3-game night moved onto a 2-sheet night
    // ships `Tundefined:00`. Refuse it, and penalise it on the rank-regression scale.
    const slotsPerNight = nights.map((n) => n.slots.length);
    const slotsNeeded = new Array<number>(nights.length).fill(0);
    for (const g of plan.games) {
      slotsNeeded[g.nightIndex] = Math.max(
        slotsNeeded[g.nightIndex],
        g.slotIndex + 1,
      );
    }

    // ⚠️ Layoff is checked here but kept out of `rankSchedule`: a permutation, unlike a
    // rank-off, really moves games across a gap. null means no constraint.
    const baseLayoff = baseReport.longestLayoffDays;

    const reordered = improveNightOrder(nights.length, (order) => {
      // Position lookup, not `order.indexOf`: this runs once per annealing step.
      const pos = new Array<number>(nights.length);
      order.forEach((n, i) => (pos[n] = i));
      let overflow = 0;
      for (let n = 0; n < nights.length; n++) {
        const short = slotsNeeded[n] - slotsPerNight[pos[n]];
        if (short > 0) overflow += short;
        // Same penalty as capacity, so the annealer can cross an inadmissible region.
        if (nightClass[n] !== nightClass[pos[n]]) overflow += 10;
      }
      const moved = plan.games.map((g) => ({
        ...g,
        nightIndex: pos[g.nightIndex],
      }));
      const report = spacingReport(moved, nights, teamIds);
      const rank = rankFromReport(
        { ...plan, games: moved },
        report,
        teamIds,
        meta,
      );
      let penalty = overflow * 1_000_000;
      let noWorse = overflow === 0;
      for (let i = 0; i < rank.length - CLUSTER_TAIL; i++) {
        const over = rank[i] - baseRank[i];
        if (over > 0) {
          noWorse = false;
          penalty += over * 1_000_000;
        }
      }
      const layoff = report.longestLayoffDays;
      if (baseLayoff !== null && layoff !== null && layoff > baseLayoff) {
        noWorse = false;
      }
      const better =
        worstOf(rank) < worstOf(baseRank) ||
        (worstOf(rank) === worstOf(baseRank) &&
          totalOf(rank) < totalOf(baseRank));
      return {
        cost: penalty + worstOf(rank) * 1_000 + totalOf(rank),
        admissible: noWorse && better,
      };
      // ⚠️ `restarts`/`steps` stay at `nightOrder.ts`'s defaults, on a measured cliff
      // (1500 steps reach worst team 4, 1000 reach 8). Only the seed varies here.
    }, { seed: 1 + seedOffset });
    if (reordered.some((n, i) => n !== i)) {
      const pos = new Array<number>(nights.length);
      reordered.forEach((n, i) => (pos[n] = i));
      plan = {
        ...plan,
        games: plan.games.map((g) => {
          const ni = pos[g.nightIndex];
          // Both, together, through the one constructor. See the ⛔ above.
          return {
            ...g,
            nightIndex: ni,
            scheduledAt: slotStamp(nights, ni, g.slotIndex),
          };
        }),
      };
    }
  }

  const { games, unscheduled } = plan;

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

  // ⚠️ Rebuilt from the games, never plumbed out of Phase S: `planByWeeks` builds none,
  // and later passes move games.
  const teamIndex = new Map(teamIds.map((t, i) => [t, i]));
  const pairsByNight: [number, number][][] = nights.map(() => []);
  const slotOf: number[][] = nights.map(() => []);
  for (const g of games) {
    pairsByNight[g.nightIndex].push([
      teamIndex.get(g.home)!,
      teamIndex.get(g.away)!,
    ]);
    slotOf[g.nightIndex].push(g.slotIndex);
  }

  // Read off the placed games, never off what a phase was asked to do.
  const playsMatrix = teamIds.map(() =>
    new Array<boolean>(nights.length).fill(false),
  );
  const slotAt = new Map<string, number>();
  for (const g of games) {
    for (const t of [g.home, g.away]) {
      const ti = teamIndex.get(t);
      if (ti === undefined) continue;
      playsMatrix[ti][g.nightIndex] = true;
      slotAt.set(`${ti}:${g.nightIndex}`, g.slotIndex);
    }
  }
  // ⛔ `items.length`, not `empty`: a set whose every constraint failed to resolve is
  // `empty`, and gating on that reports nothing while the request looks honoured.
  const constraints =
    resolved.items.length === 0
      ? []
      : evaluateConstraints(resolved, {
          plays: playsMatrix,
          slotOf: (t, n) => slotAt.get(`${t}:${n}`) ?? null,
          plannerHonours,
          plannerRan: exact !== null,
        });
  return {
    games,
    pairsByNight,
    slotOf,
    weekdayOfNight: meta.nightW,
    report: {
      totalScheduled: games.length,
      unscheduled,
      gamesPerTeam: teamIds.map((t) => ({ team: t, count: finalGp.get(t)! })),
      slotShareByTeam: teamIds.map((t) => ({
        team: t,
        counts: finalSlot.get(t)!,
      })),
      weekdays: meta.usedWeekdays.map((d) => WEEKDAY[d]),
      nightShareByTeam: teamIds.map((t) => ({
        team: t,
        counts: nightTally.get(t)!,
      })),
      pairingCounts: [...pairingTally.entries()].map(([matchup, count]) => ({
        matchup,
        count,
      })),
      minRematchGapNights: minGap,
      spacing: spacingReport(games, nights, teamIds),
      constraints,
    },
  };
}
