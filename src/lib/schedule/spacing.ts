import type { Night } from "./assignNights";

export type PlacedGame = {
  home: string;
  away: string;
  nightIndex: number;
  slotIndex: number;
};

export type SpacingReport = {
  byesMultiWeek: number;
  byesConsecWeek: number;
  byesConsecWeekSameDay: number;
  rematchSameWeek: number;
  rematchConsecWeek: number;
  rematchConsecWeekSameDay: number;
  rematchAdjNight: number;
  slotConsecutive: number;
  /** In nights, not weeks, so unlike the bye rules above it doesn't step over a holiday gap. */
  byesAdjNight: number;
  /** ⚠️ A score, not a count (47 nights, one pairing at 4/1 reads 3.7872): rank on it, show
   *  `pairingsOffWeekdaySplit`. Squared, because the search needs the gradient. */
  pairingWeekdayExcess: number;
  pairingsOffWeekdaySplit: number;
  slotWeekdaySpread: number;
  /** Third and later game of a run in one ice time, so a run of 4 counts 2. */
  slotStreak3: number;
  slotClusterWindows: number;
  slotClusterWorstTeam: number;
  /** Longest gap in days between a team's games. ⚠️ Informational: never rank on it, since a
   *  long layoff can be a calendar fact (a holiday). null when no team has two games. */
  longestLayoffDays: number | null;
};

const DAY = 86_400_000;
const toUTC = (d: string) => {
  const [y, m, dd] = d.slice(0, 10).split("-").map(Number);
  return Date.UTC(y, m - 1, dd);
};

// A clustered window: 5 consecutive games with one ice time 3+ times. Counted over a team's
// games, not nights, so a league with byes reads like one without.
const CLUSTER_WINDOW = 5;
const CLUSTER_MAX_SAME = 2;

export type NightMeta = {
  week: number[]; // calendar-week index (Mon-anchored) per night
  weekday: number[]; // 0=Sun..6=Sat per night
  weekNights: Map<number, number[]>; // week -> night indexes in it
  sortedWeeks: number[];
};

function weekAnchor(nights: Night[]): number {
  const first = toUTC(nights[0].date);
  const firstWd = new Date(first).getUTCDay();
  return first - ((firstWd + 6) % 7) * DAY; // back to Monday
}

/** Week index of any date on `buildNightMeta`'s numbering. ⚠️ Why constraints store a date,
 *  not a week number: a week number shifts when a skip date is added; this doesn't. */
export function weekIndexOf(date: string, nights: Night[]): number | null {
  if (nights.length === 0) return null;
  return Math.floor((toUTC(date) - weekAnchor(nights)) / (7 * DAY));
}

export function buildNightMeta(nights: Night[]): NightMeta {
  if (nights.length === 0) {
    return { week: [], weekday: [], weekNights: new Map(), sortedWeeks: [] };
  }
  const anchor = weekAnchor(nights);
  const week = nights.map((n) =>
    Math.floor((toUTC(n.date) - anchor) / (7 * DAY)),
  );
  const weekday = nights.map((n) => new Date(toUTC(n.date)).getUTCDay());
  const weekNights = new Map<number, number[]>();
  nights.forEach((_, ni) => {
    const w = week[ni];
    (weekNights.get(w) ?? weekNights.set(w, []).get(w)!).push(ni);
  });
  const sortedWeeks = [...weekNights.keys()].sort((a, b) => a - b);
  return { week, weekday, weekNights, sortedWeeks };
}

const matchupKey = (a: string, b: string) => [a, b].sort().join("|");

// ⚠️ Ranked byes > rematch > ice time, all dwarfed by `BALANCE_W`. Moves with `MULT_W` and
// `CHURN_W`; `weightCoupling.test.ts` pins the ratios. RUNBOOK.md, _Schedule generator_.
export const SPACING_W = {
  byeMultiWeek: 400,
  byeConsecWeekSameDay: 300,
  byeConsecWeek: 150,
  rematchSameWeek: 120,
  rematchAdjNight: 100,
  rematchConsecWeekSameDay: 70,
  rematchConsecWeek: 40,
  slotSpread: 20,
  slotConsecutive: 6,
};

export function teamSpacingCost(
  slotByNight: Map<number, number>,
  numSlots: number,
  meta: NightMeta,
): number {
  let c = 0;
  const byeWeekdays = new Map<number, Set<number>>();
  const hasBye = new Set<number>();
  for (const w of meta.sortedWeeks) {
    const wn = meta.weekNights.get(w)!;
    const byed = wn.filter((ni) => !slotByNight.has(ni));
    if (byed.length >= 2) c += SPACING_W.byeMultiWeek;
    if (byed.length >= 1) {
      hasBye.add(w);
      byeWeekdays.set(w, new Set(byed.map((ni) => meta.weekday[ni])));
    }
  }
  for (let i = 1; i < meta.sortedWeeks.length; i++) {
    const a = meta.sortedWeeks[i - 1];
    const b = meta.sortedWeeks[i];
    if (b - a !== 1 || !hasBye.has(a) || !hasBye.has(b)) continue;
    c += SPACING_W.byeConsecWeek;
    const wa = byeWeekdays.get(a)!;
    const wb = byeWeekdays.get(b)!;
    if ([...wa].some((d) => wb.has(d))) c += SPACING_W.byeConsecWeekSameDay;
  }
  const counts = new Array(numSlots).fill(0);
  const mine = [...slotByNight.entries()].sort((x, y) => x[0] - y[0]);
  for (const [, s] of mine) counts[s]++;
  const spread = Math.max(...counts) - Math.min(...counts);
  c += Math.max(0, spread - 1) * SPACING_W.slotSpread;
  for (let i = 1; i < mine.length; i++) {
    if (mine[i][1] === mine[i - 1][1]) c += SPACING_W.slotConsecutive;
  }
  return c;
}

export function matchupSpacingCost(nights: number[], meta: NightMeta): number {
  const s = [...nights].sort((a, b) => a - b);
  let c = 0;
  for (let i = 1; i < s.length; i++) {
    if (s[i] - s[i - 1] === 1) c += SPACING_W.rematchAdjNight;
    const wa = meta.week[s[i - 1]];
    const wb = meta.week[s[i]];
    if (wa === wb) c += SPACING_W.rematchSameWeek;
    else if (wb - wa === 1) {
      c += SPACING_W.rematchConsecWeek;
      if (meta.weekday[s[i]] === meta.weekday[s[i - 1]]) {
        c += SPACING_W.rematchConsecWeekSameDay;
      }
    }
  }
  return c;
}

const spreadOf = (a: number[]) =>
  a.length ? Math.max(...a) - Math.min(...a) : 0;

/** Largest-remainder split of `total` by each weekday's share of nights; ties by weekday.
 *  ⚠️ Integers throughout, so no rounding error can move a floor across a boundary. */
export function proportionalSplit(
  total: number,
  nightsPerWd: number[],
): number[] {
  const N = nightsPerWd.reduce((s, n) => s + n, 0);
  if (N === 0) return nightsPerWd.map(() => 0);
  const num = nightsPerWd.map((n) => total * n);
  const out = num.map((x) => Math.floor(x / N));
  const short = total - out.reduce((s, x) => s + x, 0);
  const byRemainder = num
    .map((x, d) => d)
    .sort((a, b) => (num[b] % N) - (num[a] % N) || a - b);
  for (let i = 0; i < short; i++) out[byRemainder[i]]++;
  return out;
}

/** A matchup's squared distance from its flattest weekday split (0 at the flattest).
 *  ⚠️ Scaled by N² to stay an exact integer: callers sum, then divide once. */
export function weekdayExcessScaled(
  counts: number[],
  nightsPerWd: number[],
): number {
  const N = nightsPerWd.reduce((s, n) => s + n, 0);
  if (N === 0) return 0;
  const total = counts.reduce((s, c) => s + c, 0);
  const ideal = proportionalSplit(total, nightsPerWd);
  let scaled = 0;
  for (let d = 0; d < nightsPerWd.length; d++) {
    const target = total * nightsPerWd[d]; // = N · realTarget[d]
    scaled += (counts[d] * N - target) ** 2 - (ideal[d] * N - target) ** 2;
  }
  return scaled;
}

/** `slot_bias`. ⚠️ Lives here because Phase S's descent and `iceOutcome` must price it
 *  identically; a term only the descent sees is ignored by the best-of-five choice. */
export type SlotBias = {
  team: number;
  nights: boolean[];
  prefer: "early" | "late";
};

/** ⚠️ Deliberately low: a share step is 60 and a run 140–200, so 4 only breaks ties between
 *  arrangements they don't care about. A preference; `slot_on` is the pin. */
export const SLOT_BIAS_W = 4;

/** +1 early, −1 late. ⚠️ Signed, not a distance (no slot count to drift between callers),
 *  and overlapping windows add: `iceOutcome` and `assignSlots` must both accumulate. */
export const biasSign = (prefer: SlotBias["prefer"]): number =>
  prefer === "early" ? 1 : -1;

/** ⚠️ Ranked lexicographically, never blended: a blended scalar buys a flatter weekday split
 *  by breaking the even season share, a trade the league has rejected twice. */
export type IceOutcome = {
  seasonSpread: number;
  weekdaySpread: number;
  streak3: number;
  consecutive: number;
  clusterWorst: number;
  clusterTotal: number;
  biasCost: number;
};

/** Lexicographic, lower wins. ⚠️ `streak3` stays above `weekdaySpread`: swapped, the 140
 *  candidate traded a three-game run for a flat split. RUNBOOK.md, _Schedule generator_. */
export function compareIceOutcome(a: IceOutcome, b: IceOutcome): number {
  return (
    a.seasonSpread - b.seasonSpread ||
    a.streak3 - b.streak3 ||
    a.weekdaySpread - b.weekdaySpread ||
    a.consecutive - b.consecutive ||
    // ⛔ Clustering is not ranked here, and it was tried: inert unconstrained, and it dropped
    // bias satisfaction 2/3 -> 1/3 on a constrained fixture. Re-measure before revisiting.
    // ⛔ `biasCost` must be here, last: RUNBOOK.md, _Schedule generator_.
    a.biasCost - b.biasCost
  );
}

/** ⛔ One definition, two readers: `spacingReport` and `iceOutcome` must agree, so both
 *  call here; a hand-copied twin is how that rots. */
function clusteredWindows(slots: number[], numSlots: number): number {
  let clustered = 0;
  for (let i = 0; i + CLUSTER_WINDOW <= slots.length; i++) {
    const counts = new Array(numSlots).fill(0);
    for (let j = i; j < i + CLUSTER_WINDOW; j++) counts[slots[j]]++;
    if (Math.max(...counts) > CLUSTER_MAX_SAME) clustered++;
  }
  return clustered;
}

/** Ice-time numbers straight from a slot assignment, so Phase S can rank candidates.
 *  ⚠️ Definitions match `spacingReport`'s and a test asserts it: change both or neither. */
export function iceOutcome(opts: {
  teamCount: number;
  pairsByNight: [number, number][][];
  slotOf: number[][];
  weekdayOfNight?: number[];
  biases?: SlotBias[];
}): IceOutcome {
  const { teamCount, pairsByNight, slotOf, weekdayOfNight, biases } = opts;
  const numSlots = Math.max(1, ...slotOf.flat().map((s) => s + 1));
  const wds = weekdayOfNight ?? pairsByNight.map(() => 0);
  const usedW = [...new Set(wds)].sort((a, b) => a - b);
  const wIndex = new Map(usedW.map((d, i) => [d, i]));

  const seq: number[][] = Array.from({ length: teamCount }, () => []);
  const seqW: number[][] = Array.from({ length: teamCount }, () => []);
  const seqN: number[][] = Array.from({ length: teamCount }, () => []);
  pairsByNight.forEach((pairs, n) => {
    pairs.forEach(([a, b], gi) => {
      const s = slotOf[n][gi];
      for (const t of [a, b]) {
        seq[t].push(s);
        seqW[t].push(wIndex.get(wds[n])!);
        seqN[t].push(n);
      }
    });
  });

  let biasCost = 0;
  for (const bias of biases ?? []) {
    const sign = biasSign(bias.prefer);
    const mine = seq[bias.team];
    if (!mine) continue;
    for (let i = 0; i < mine.length; i++) {
      if (bias.nights[seqN[bias.team][i]])
        biasCost += SLOT_BIAS_W * sign * mine[i];
    }
  }

  let seasonSpread = 0;
  let weekdaySpread = 0;
  let streak3 = 0;
  let consecutive = 0;
  let clusterWorst = 0;
  let clusterTotal = 0;
  for (let t = 0; t < teamCount; t++) {
    const s = seq[t];
    if (s.length === 0) continue;
    const season = new Array(numSlots).fill(0);
    for (let i = 0; i < s.length; i++) {
      season[s[i]]++;
      if (i > 0 && s[i] === s[i - 1]) consecutive++;
      if (i > 1 && s[i] === s[i - 1] && s[i] === s[i - 2]) streak3++;
    }
    seasonSpread += Math.max(...season) - Math.min(...season);

    const clustered = clusteredWindows(s, numSlots);
    clusterTotal += clustered;
    if (clustered > clusterWorst) clusterWorst = clustered;

    for (let d = 0; d < usedW.length; d++) {
      const c = new Array(numSlots).fill(0);
      for (let i = 0; i < s.length; i++) if (seqW[t][i] === d) c[s[i]]++;
      weekdaySpread += Math.max(...c) - Math.min(...c);
    }
  }
  return {
    seasonSpread,
    weekdaySpread,
    streak3,
    consecutive,
    clusterWorst,
    clusterTotal,
    biasCost,
  };
}

export function spacingReport(
  games: PlacedGame[],
  nights: Night[],
  teamIds: string[],
): SpacingReport {
  const meta = buildNightMeta(nights);
  const played = new Map<string, Set<number>>(
    teamIds.map((t) => [t, new Set()]),
  );
  const slotByNight = new Map<string, Map<number, number>>(
    teamIds.map((t) => [t, new Map()]),
  );
  const matchupNights = new Map<string, number[]>();
  for (const g of games) {
    for (const t of [g.home, g.away]) {
      played.get(t)!.add(g.nightIndex);
      slotByNight.get(t)!.set(g.nightIndex, g.slotIndex);
    }
    const k = matchupKey(g.home, g.away);
    (matchupNights.get(k) ?? matchupNights.set(k, []).get(k)!).push(
      g.nightIndex,
    );
  }

  const report: SpacingReport = {
    byesMultiWeek: 0,
    byesConsecWeek: 0,
    byesConsecWeekSameDay: 0,
    rematchSameWeek: 0,
    rematchConsecWeek: 0,
    rematchConsecWeekSameDay: 0,
    rematchAdjNight: 0,
    slotConsecutive: 0,
    byesAdjNight: 0,
    pairingWeekdayExcess: 0,
    pairingsOffWeekdaySplit: 0,
    slotWeekdaySpread: 0,
    slotStreak3: 0,
    slotClusterWindows: 0,
    slotClusterWorstTeam: 0,
    longestLayoffDays: null,
  };

  // ⚠️ The slot count comes off the games: the builder panel passes nights with empty `slots`.
  const usedWeekdays = [...new Set(meta.weekday)].sort((a, b) => a - b);
  const wIndex = new Map(usedWeekdays.map((d, i) => [d, i]));
  const D = usedWeekdays.length;
  const numSlots = games.reduce((m, g) => Math.max(m, g.slotIndex + 1), 0);
  const nightsPerWd = new Array(D).fill(0);
  for (const d of meta.weekday) nightsPerWd[wIndex.get(d)!]++;

  const sortedWeeks = [...meta.weekNights.keys()].sort((a, b) => a - b);
  for (const t of teamIds) {
    const has = played.get(t)!;
    const byeWeekdays = new Map<number, Set<number>>(); // week -> weekdays byed
    const hasBye = new Set<number>();
    for (const w of sortedWeeks) {
      const wn = meta.weekNights.get(w)!;
      const byed = wn.filter((ni) => !has.has(ni));
      if (byed.length >= 2) report.byesMultiWeek++;
      if (byed.length >= 1) {
        hasBye.add(w);
        byeWeekdays.set(w, new Set(byed.map((ni) => meta.weekday[ni])));
      }
    }
    for (let i = 1; i < sortedWeeks.length; i++) {
      const a = sortedWeeks[i - 1];
      const b = sortedWeeks[i];
      if (b - a !== 1) continue;
      if (hasBye.has(a) && hasBye.has(b)) {
        report.byesConsecWeek++;
        const wa = byeWeekdays.get(a)!;
        const wb = byeWeekdays.get(b)!;
        if ([...wa].some((d) => wb.has(d))) report.byesConsecWeekSameDay++;
      }
    }
    for (let ni = 1; ni < nights.length; ni++) {
      if (!has.has(ni) && !has.has(ni - 1)) report.byesAdjNight++;
    }

    const mine = [...slotByNight.get(t)!.entries()].sort((x, y) => x[0] - y[0]);
    for (let i = 1; i < mine.length; i++) {
      if (mine[i][1] === mine[i - 1][1]) report.slotConsecutive++;
      if (
        i >= 2 &&
        mine[i][1] === mine[i - 2][1] &&
        mine[i][1] === mine[i - 1][1]
      ) {
        report.slotStreak3++;
      }
    }

    const clustered = clusteredWindows(
      mine.map((m) => m[1]),
      numSlots,
    );
    report.slotClusterWindows += clustered;
    if (clustered > report.slotClusterWorstTeam)
      report.slotClusterWorstTeam = clustered;

    for (let d = 0; d < D; d++) {
      const counts = new Array(numSlots).fill(0);
      for (const [ni, s] of mine) {
        if (wIndex.get(meta.weekday[ni]) === d) counts[s]++;
      }
      report.slotWeekdaySpread += spreadOf(counts);
    }

    for (let i = 1; i < mine.length; i++) {
      const gap =
        (toUTC(nights[mine[i][0]].date) - toUTC(nights[mine[i - 1][0]].date)) /
        DAY;
      if (report.longestLayoffDays === null || gap > report.longestLayoffDays) {
        report.longestLayoffDays = gap;
      }
    }
  }

  let excessScaled = 0;
  const N = nights.length;

  for (const nis of matchupNights.values()) {
    const counts = new Array(D).fill(0);
    for (const ni of nis) counts[wIndex.get(meta.weekday[ni])!]++;
    const excess = weekdayExcessScaled(counts, nightsPerWd);
    excessScaled += excess;
    if (excess > 0) report.pairingsOffWeekdaySplit++;
    const s = [...nis].sort((a, b) => a - b);
    for (let i = 1; i < s.length; i++) {
      if (s[i] - s[i - 1] === 1) report.rematchAdjNight++;
      const wa = meta.week[s[i - 1]];
      const wb = meta.week[s[i]];
      if (wa === wb) report.rematchSameWeek++;
      else if (wb - wa === 1) {
        report.rematchConsecWeek++;
        if (meta.weekday[s[i]] === meta.weekday[s[i - 1]]) {
          report.rematchConsecWeekSameDay++;
        }
      }
    }
  }
  // 4dp: in a lexicographic rank, a 1e-16 residue reads as one plan beating another.
  if (N > 0) {
    report.pairingWeekdayExcess =
      Math.round((excessScaled / (N * N)) * 1e4) / 1e4;
  }

  return report;
}
