import type { Pairing } from "./roundRobin";

/**
 * Assigns pairings onto concrete game nights + ice-time slots, then polishes the
 * result toward an even split for every team across weekdays and ice times.
 *
 *   1. A greedy pass places all pairings: pick which pairings play each night
 *      (no team twice), favoring teams under-represented on that weekday, then
 *      round order; assign the night's games to slots optimally.
 *   2. Iterated local search: hill-climb by swapping two games' (night, slot)
 *      positions whenever it lowers total imbalance, and when stuck, apply random
 *      kicks and re-climb, keeping the best schedule found.
 *
 * Every team plays the same number of games (guaranteed by placing all pairings),
 * so byes come out even too; the search drives weekday and ice-time share to a
 * max-min spread of 1 wherever that is feasible, with any unavoidable imbalance
 * biased onto the later/worse ice times.
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
};

const matchupKey = (a: string, b: string) => [a, b].sort().join("|");

const WEEKDAY = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
/** UTC-stable day-of-week (0=Sun) from a "YYYY-MM-DD..." string. */
export const weekdayOf = (date: string): number => {
  const [y, m, d] = date.slice(0, 10).split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
};

// Greedy selection weights: weekday balance is first-class and dominates;
// rematch spread and round order only break ties.
const WEEKDAY_W = 1000;
const REMATCH_W = 300;
const ROUND_W = 0.001;
// Small earlier-slot bias — must be < 1 so integer slot-count balance wins.
const SLOT_BIAS = 0.1;
// Iterated-local-search budget. Small instances get full optimization; large
// ones (which can't reach a perfect ≤1 spread anyway) get fewer restarts so a
// full-season "By end date" generate stays fast. Each hill-climb pass is O(G²),
// so the restart count is the main runtime lever.
const HILLCLIMB_PASSES = 30;
function ilsRestartsFor(gameCount: number): number {
  if (gameCount <= 150) return 60;
  if (gameCount <= 350) return 16;
  return 6;
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

/**
 * Optimal games -> distinct-slot assignment for one night. Cost of putting a
 * game in slot s is the two teams' current use of that slot (so shares even out)
 * plus a tiny earlier-slot bias (so any imbalance and any empty slot fall on the
 * later/worse times). Small inputs (games <= slots), so brute force with pruning.
 */
function bestSlotAssignment(
  selected: Pairing[],
  slotCount: Map<string, number[]>,
  numSlots: number,
): number[] {
  const k = selected.length;
  let best: number[] = [];
  let bestCost = Infinity;
  const used = new Array(numSlots).fill(false);
  const cur: number[] = [];
  const rec = (i: number, cost: number) => {
    if (cost >= bestCost) return;
    if (i === k) {
      bestCost = cost;
      best = [...cur];
      return;
    }
    const g = selected[i];
    for (let s = 0; s < numSlots; s++) {
      if (used[s]) continue;
      const c = slotCount.get(g.home)![s] + slotCount.get(g.away)![s] + s * SLOT_BIAS;
      used[s] = true;
      cur.push(s);
      rec(i + 1, cost + c);
      cur.pop();
      used[s] = false;
    }
  };
  rec(0, 0);
  return best;
}

/** Greedy initial placement. Returns the placed games and any that didn't fit. */
function greedyAssign(
  pairings: Pairing[],
  nights: Night[],
  teamIds: string[],
  meta: Meta,
): { games: ScheduledGame[]; unscheduled: number } {
  const slotCount = new Map<string, number[]>(
    teamIds.map((t) => [t, new Array(meta.numSlots).fill(0)]),
  );
  const weekdayCount = new Map<string, number[]>(
    teamIds.map((t) => [t, meta.usedWeekdays.map(() => 0)]),
  );
  const games: ScheduledGame[] = [];
  const pending = [...pairings];
  const lastNightForMatchup = new Map<string, number>();

  for (let ni = 0; ni < nights.length && pending.length > 0; ni++) {
    const night = nights[ni];
    const wi = meta.nightW[ni];
    const teamsThisNight = new Set<string>();

    // Phase 1 — pick up to `slots` pairings for tonight.
    const selected: Pairing[] = [];
    while (selected.length < night.slots.length) {
      let bestK = -1;
      let bestCost = Infinity;
      for (let k = 0; k < pending.length; k++) {
        const p = pending[k];
        if (teamsThisNight.has(p.home) || teamsThisNight.has(p.away)) continue;
        const wd = weekdayCount.get(p.home)![wi] + weekdayCount.get(p.away)![wi];
        const last = lastNightForMatchup.get(matchupKey(p.home, p.away));
        const rematch = last == null ? 0 : REMATCH_W / (ni - last);
        const cost = wd * WEEKDAY_W + rematch + k * ROUND_W;
        if (cost < bestCost) {
          bestCost = cost;
          bestK = k;
        }
      }
      if (bestK === -1) break; // no compatible pairing left for this night
      const [p] = pending.splice(bestK, 1);
      selected.push(p);
      teamsThisNight.add(p.home);
      teamsThisNight.add(p.away);
      weekdayCount.get(p.home)![wi]++;
      weekdayCount.get(p.away)![wi]++;
    }

    // Phase 2 — place tonight's games into slots optimally.
    const assignment = bestSlotAssignment(selected, slotCount, night.slots.length);
    for (let s = 0; s < selected.length; s++) {
      const p = selected[s];
      const slotIdx = assignment[s];
      slotCount.get(p.home)![slotIdx]++;
      slotCount.get(p.away)![slotIdx]++;
      games.push({
        home: p.home,
        away: p.away,
        round: p.round,
        scheduledAt: `${night.date}T${night.slots[slotIdx]}:00`,
        nightIndex: ni,
        slotIndex: slotIdx,
      });
      lastNightForMatchup.set(matchupKey(p.home, p.away), ni);
    }
  }

  return { games, unscheduled: pending.length };
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
// Steep penalty per unit of spread beyond 1 — makes the hill-climb actively
// clear "one team a game over on a weekday/slot" cases that squared imbalance
// alone barely registers.
const SPREAD_PENALTY = 60;
const spreadCost = (a: number[]) => Math.max(0, spread(a) - 1) * SPREAD_PENALTY;

/** Smallest gap (in nights) between any pair's consecutive meetings. */
function minRematchGap(games: ScheduledGame[]): number | null {
  const meetings = new Map<string, number[]>();
  for (const g of games) {
    const mk = matchupKey(g.home, g.away);
    (meetings.get(mk) ?? meetings.set(mk, []).get(mk)!).push(g.nightIndex);
  }
  let min: number | null = null;
  for (const nis of meetings.values()) {
    if (nis.length < 2) continue;
    nis.sort((a, b) => a - b);
    for (let i = 1; i < nis.length; i++) {
      const gap = nis[i] - nis[i - 1];
      min = min == null ? gap : Math.min(min, gap);
    }
  }
  return min;
}

/**
 * Lexicographic quality of a placement (lower is better): worst weekday spread,
 * worst ice-time spread, total squared imbalance, then rematch tightness. The
 * first two are what the user cares about most, so they dominate.
 */
function scoreTuple(
  games: ScheduledGame[],
  teamIds: string[],
  meta: Meta,
): number[] {
  const { slot, wd } = vectorsOf(games, teamIds, meta);
  let maxWd = 0;
  let maxSlot = 0;
  let sumSq = 0;
  for (const t of teamIds) {
    maxWd = Math.max(maxWd, spread(wd.get(t)!));
    maxSlot = Math.max(maxSlot, spread(slot.get(t)!));
    sumSq += sq(wd.get(t)!) + sq(slot.get(t)!);
  }
  // Balance first (worst weekday spread, worst slot spread, total imbalance),
  // then prefer wider rematch spacing among equally balanced schedules.
  const gap = minRematchGap(games);
  return [maxWd, maxSlot, sumSq, -Math.min(gap ?? 99, 99)];
}

function lessThan(a: number[], b: number[]): boolean {
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return a[i] < b[i];
  }
  return false;
}

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

/**
 * Hill-climb to a local optimum: repeatedly apply the first position-swap that
 * lowers total squared imbalance (covers both weekday and ice-time balance).
 */
function hillclimb(games: ScheduledGame[], nights: Night[], teamIds: string[], meta: Meta): void {
  const { slot, wd } = vectorsOf(games, teamIds, meta);
  const nightTeams = nightTeamsOf(games, nights);
  const cost = (t: string) =>
    sq(slot.get(t)!) +
    sq(wd.get(t)!) +
    spreadCost(slot.get(t)!) +
    spreadCost(wd.get(t)!);
  const moveSlot = (t: string, from: number, to: number) => {
    slot.get(t)![from]--;
    slot.get(t)![to]++;
  };
  const moveWd = (t: string, from: number, to: number) => {
    wd.get(t)![from]--;
    wd.get(t)![to]++;
  };

  let improved = true;
  let guard = 0;
  while (improved && guard++ < HILLCLIMB_PASSES) {
    improved = false;
    for (let i = 0; i < games.length; i++) {
      for (let j = i + 1; j < games.length; j++) {
        const g1 = games[i];
        const g2 = games[j];
        if (!swapLegal(g1, g2, nights, nightTeams)) continue;
        const n1 = g1.nightIndex;
        const n2 = g2.nightIndex;
        const s1 = g1.slotIndex;
        const s2 = g2.slotIndex;
        const w1 = meta.nightW[n1];
        const w2 = meta.nightW[n2];
        const affected = [...new Set([g1.home, g1.away, g2.home, g2.away])];
        const before = affected.reduce((s, t) => s + cost(t), 0);

        moveSlot(g1.home, s1, s2);
        moveSlot(g1.away, s1, s2);
        moveSlot(g2.home, s2, s1);
        moveSlot(g2.away, s2, s1);
        if (w1 !== w2) {
          moveWd(g1.home, w1, w2);
          moveWd(g1.away, w1, w2);
          moveWd(g2.home, w2, w1);
          moveWd(g2.away, w2, w1);
        }
        const after = affected.reduce((s, t) => s + cost(t), 0);

        if (after < before - 1e-9) {
          doSwap(g1, g2, nights, nightTeams);
          improved = true;
        } else {
          moveSlot(g1.home, s2, s1);
          moveSlot(g1.away, s2, s1);
          moveSlot(g2.home, s1, s2);
          moveSlot(g2.away, s1, s2);
          if (w1 !== w2) {
            moveWd(g1.home, w2, w1);
            moveWd(g1.away, w2, w1);
            moveWd(g2.home, w1, w2);
            moveWd(g2.away, w1, w2);
          }
        }
      }
    }
  }
}

/** Random legal position-swaps to kick out of a local optimum. */
function perturb(
  games: ScheduledGame[],
  nights: Night[],
  rnd: () => number,
  kicks: number,
): void {
  if (games.length < 2) return;
  const nightTeams = nightTeamsOf(games, nights);
  for (let k = 0; k < kicks; k++) {
    for (let tries = 0; tries < 8; tries++) {
      const i = Math.floor(rnd() * games.length);
      const j = Math.floor(rnd() * games.length);
      if (i !== j && swapLegal(games[i], games[j], nights, nightTeams)) {
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

export function assignNights(
  pairings: Pairing[],
  nights: Night[],
  teamIds: string[],
): { games: ScheduledGame[]; report: BalanceReport } {
  const meta = buildMeta(nights);
  const { games, unscheduled } = greedyAssign(pairings, nights, teamIds, meta);

  // Iterated local search: climb, then kick-and-reclimb, keeping the best.
  hillclimb(games, nights, teamIds, meta);
  let best = snapshot(games);
  let bestScore = scoreTuple(games, teamIds, meta);
  const rnd = mulberry32(teamIds.length * 7919 + games.length * 104729 + 1);
  const imbalanced = () => {
    const { slot, wd } = vectorsOf(games, teamIds, meta);
    return teamIds.filter(
      (t) => spread(slot.get(t)!) > 1 || spread(wd.get(t)!) > 1,
    ).length;
  };
  const restarts = ilsRestartsFor(games.length);
  for (let iter = 0; iter < restarts; iter++) {
    if (bestScore[0] <= 1 && bestScore[1] <= 1) break; // already even everywhere
    perturb(games, nights, rnd, Math.max(2, imbalanced()));
    hillclimb(games, nights, teamIds, meta);
    const sc = scoreTuple(games, teamIds, meta);
    if (lessThan(sc, bestScore)) {
      best = snapshot(games);
      bestScore = sc;
    } else {
      restore(games, best, nights);
    }
  }
  restore(games, best, nights);

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
      unscheduled,
      gamesPerTeam: teamIds.map((t) => ({ team: t, count: finalGp.get(t)! })),
      slotShareByTeam: teamIds.map((t) => ({ team: t, counts: finalSlot.get(t)! })),
      weekdays: meta.usedWeekdays.map((d) => WEEKDAY[d]),
      nightShareByTeam: teamIds.map((t) => ({ team: t, counts: nightTally.get(t)! })),
      pairingCounts: [...pairingTally.entries()].map(([matchup, count]) => ({
        matchup,
        count,
      })),
      minRematchGapNights: minGap,
    },
  };
}
