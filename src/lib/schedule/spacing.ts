import type { Night } from "./assignNights";

/** Just the placement facts spacing analysis needs (a subset of ScheduledGame). */
export type PlacedGame = {
  home: string;
  away: string;
  nightIndex: number;
  slotIndex: number;
};

export type SpacingReport = {
  /** Team-weeks where a team sat out 2+ of that week's game nights. */
  byesMultiWeek: number;
  /** Consecutive-week pairs where a team byed in both weeks. */
  byesConsecWeek: number;
  /** ...and byed on the same weekday in both weeks. */
  byesConsecWeekSameDay: number;
  /** The same two teams meeting twice within one week. */
  rematchSameWeek: number;
  /** The same two teams meeting in back-to-back weeks. */
  rematchConsecWeek: number;
  /** ...on the same weekday. */
  rematchConsecWeekSameDay: number;
  /** The same two teams meeting on adjacent game nights. */
  rematchAdjNight: number;
  /** A team's back-to-back games in the same ice-time slot. */
  slotConsecutive: number;
  /**
   * A team byeing two game nights in a row. Stated in nights, not weeks, so
   * unlike the three bye rules above it does not step over a holiday gap — the
   * pair straddling a two-week break is exactly the one that hurts most.
   */
  byesAdjNight: number;
  /**
   * Σ over matchups of the squared deviation of that matchup's per-weekday
   * meeting counts from its proportional target, offset so the flattest split
   * the calendar allows reads 0. A statement about the whole count vector, so
   * it generalises past two weekdays; identically 0 when there is only one.
   *
   * A **score, not a count**, and not necessarily a whole number — a 47-night
   * season with one pairing at 4/1 reads 3.7872. Squared because the search
   * needs the gradient: 4/1 is far worse than 3/2 where an even split is 2.5,
   * and a count cannot say so. Rank on this; show `pairingsOffWeekdaySplit`.
   */
  pairingWeekdayExcess: number;
  /**
   * How many matchups are off their ideal weekday split at all — the plain count
   * behind the score above, for the places a person reads rather than the search.
   * Zero exactly when `pairingWeekdayExcess` is.
   */
  pairingsOffWeekdaySplit: number;
  /**
   * Σ over (team, weekday) of the spread of that team's ice-time counts on that
   * weekday. The season-wide share can be perfect while every weekday is
   * lopsided, which is what this catches.
   */
  slotWeekdaySpread: number;
  /**
   * A team's third-and-later game in an unbroken run of one ice time, so a run
   * of 4 counts 2. Costed apart from `slotConsecutive` because three in a row
   * is worse than two unrelated repeats, not equal to them.
   */
  slotStreak3: number;
  /**
   * Longest gap in days between any team's consecutive games. **Informational
   * only** — it must never enter `rankSchedule`, because a long layoff can be a
   * calendar fact (a Christmas break) that no schedule can undo. It exists to
   * make `byesAdjNight` legible: the residual is the holiday, not a defect.
   * `null` when no team has two games to sit between.
   */
  longestLayoffDays: number | null;
};

const DAY = 86_400_000;
const toUTC = (d: string) => {
  const [y, m, dd] = d.slice(0, 10).split("-").map(Number);
  return Date.UTC(y, m - 1, dd);
};

export type NightMeta = {
  week: number[]; // calendar-week index (Mon-anchored) per night
  weekday: number[]; // 0=Sun..6=Sat per night
  weekNights: Map<number, number[]>; // week -> night indexes in it
  sortedWeeks: number[];
};

/** Precompute per-night week/weekday, weeks anchored to the first night's Monday. */
export function buildNightMeta(nights: Night[]): NightMeta {
  if (nights.length === 0) {
    return { week: [], weekday: [], weekNights: new Map(), sortedWeeks: [] };
  }
  const first = toUTC(nights[0].date);
  const firstWd = new Date(first).getUTCDay();
  const anchor = first - ((firstWd + 6) % 7) * DAY; // back to Monday
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

// Spacing penalty weights, ranked: byes (#2) > rematch spacing (#3) > ice-time
// spread/consecutiveness (#4). All are dwarfed by the balance weight in the
// search so that even weekday distribution (#1) is never traded away.
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

/** Weighted bye + ice-time-spread + slot-consecutive penalty for one team. */
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
  // Ice-time: even share + spread out (no back-to-back same slot).
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

/** Weighted rematch-clustering penalty for one matchup's meeting nights. */
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

/**
 * Split `total` items across weekdays in proportion to each weekday's share of
 * the nights — the flattest split those totals allow, which is an even split
 * exactly when the night counts are equal.
 *
 * Largest-remainder rounding, which is provably the integer vector minimising
 * the squared deviation from the real-valued proportional target: moving a unit
 * from weekday `a` to `b` changes the cost by `(1 - 2·frac(a)) - (1 - 2·frac(b))`,
 * so the units belong on the largest remainders. Ties break on weekday order to
 * keep the result deterministic.
 *
 * Kept in integers throughout — `total·nights[d]` and a `% N` rather than a
 * division — so no rounding error can move a floor across an integer boundary.
 */
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

/**
 * How far one matchup's per-weekday meeting counts sit from its proportional
 * target, as a squared deviation offset so the flattest split the calendar
 * allows reads exactly 0 — including when that flattest split is uneven, and
 * when two different splits are equally flat.
 *
 * Returned scaled by N² (N = total nights) to stay an exact integer: the caller
 * sums many of these and divides once, so no float noise reaches a comparison.
 * Zero whenever there is only one weekday, so single-weekday cadences are free.
 */
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

/**
 * An ice-time result, in the four numbers `spacingReport` publishes. Selection
 * ranks these lexicographically rather than blending them, because a blended
 * scalar can and does prefer a candidate that breaks the even season share to
 * buy a flatter weekday split — the trade the league has rejected twice.
 */
export type IceOutcome = {
  /** Σ over teams of (max − min) of that team's season slot counts. */
  seasonSpread: number;
  /** `slotWeekdaySpread` — the same, within each weekday. */
  weekdaySpread: number;
  /** `slotStreak3`. */
  streak3: number;
  /** `slotConsecutive`. */
  consecutive: number;
};

/**
 * Lexicographic, lower is better. Negative when `a` beats `b`.
 *
 * Order: season share ▸ three-game runs ▸ per-weekday share ▸ ordinary repeats.
 *
 * `streak3` sits above `weekdaySpread` because the league states goal 4 as an
 * absolute — a team never runs three games deep in one ice time — while the
 * weekday split is a fairness target with no such line. Measured 2026-08-12 on
 * the reference season: the 140 candidate flattens the weekday split to 0 but
 * leaves a three-game run in two runs out of three, and with the two terms the
 * other way round this comparator took that trade every time. Ranking runs
 * first means the flat split is taken when it is free and declined when its
 * price is a run.
 */
export function compareIceOutcome(a: IceOutcome, b: IceOutcome): number {
  return (
    a.seasonSpread - b.seasonSpread ||
    a.streak3 - b.streak3 ||
    a.weekdaySpread - b.weekdaySpread ||
    a.consecutive - b.consecutive
  );
}

/**
 * The four ice-time numbers, computed straight from a slot assignment rather
 * than from placed games — so Phase S can rank candidates without building a
 * season for each one. Definitions are kept identical to `spacingReport`'s and
 * a test asserts they agree; change both together or neither.
 */
export function iceOutcome(opts: {
  teamCount: number;
  pairsByNight: [number, number][][];
  slotOf: number[][];
  weekdayOfNight?: number[];
}): IceOutcome {
  const { teamCount, pairsByNight, slotOf, weekdayOfNight } = opts;
  const numSlots = Math.max(1, ...slotOf.flat().map((s) => s + 1));
  const wds = weekdayOfNight ?? pairsByNight.map(() => 0);
  const usedW = [...new Set(wds)].sort((a, b) => a - b);
  const wIndex = new Map(usedW.map((d, i) => [d, i]));

  // Each team's slots in chronological night order — night indexes are already
  // chronological, which is the same assumption `spacingReport` makes.
  const seq: number[][] = Array.from({ length: teamCount }, () => []);
  const seqW: number[][] = Array.from({ length: teamCount }, () => []);
  pairsByNight.forEach((pairs, n) => {
    pairs.forEach(([a, b], gi) => {
      const s = slotOf[n][gi];
      for (const t of [a, b]) {
        seq[t].push(s);
        seqW[t].push(wIndex.get(wds[n])!);
      }
    });
  });

  let seasonSpread = 0;
  let weekdaySpread = 0;
  let streak3 = 0;
  let consecutive = 0;
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
    for (let d = 0; d < usedW.length; d++) {
      const c = new Array(numSlots).fill(0);
      for (let i = 0; i < s.length; i++) if (seqW[t][i] === d) c[s[i]]++;
      weekdaySpread += Math.max(...c) - Math.min(...c);
    }
  }
  return { seasonSpread, weekdaySpread, streak3, consecutive };
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
    longestLayoffDays: null,
  };

  // Weekday and ice-time frames for the per-weekday metrics. Both are derived
  // from the data rather than taken as parameters: the builder panel passes
  // nights whose `slots` are empty, so the slot count has to come off the games.
  const usedWeekdays = [...new Set(meta.weekday)].sort((a, b) => a - b);
  const wIndex = new Map(usedWeekdays.map((d, i) => [d, i]));
  const D = usedWeekdays.length;
  const numSlots = games.reduce((m, g) => Math.max(m, g.slotIndex + 1), 0);
  const nightsPerWd = new Array(D).fill(0);
  for (const d of meta.weekday) nightsPerWd[wIndex.get(d)!]++;

  const sortedWeeks = [...meta.weekNights.keys()].sort((a, b) => a - b);
  for (const t of teamIds) {
    const has = played.get(t)!;
    // Per-week bye picture for this team.
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
    // Byes on back-to-back nights. Night indexes are chronological, the same
    // assumption the rematch-adjacency check below already makes.
    for (let ni = 1; ni < nights.length; ni++) {
      if (!has.has(ni) && !has.has(ni - 1)) report.byesAdjNight++;
    }

    // Slot consecutiveness across this team's games in chronological order.
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

    // Ice-time share within each weekday, not just across the season.
    for (let d = 0; d < D; d++) {
      const counts = new Array(numSlots).fill(0);
      for (const [ni, s] of mine) {
        if (wIndex.get(meta.weekday[ni]) === d) counts[s]++;
      }
      report.slotWeekdaySpread += spreadOf(counts);
    }

    // Longest layoff, in days rather than nights — the point of it is that the
    // calendar gap between two adjacent night indexes can be three weeks.
    for (let i = 1; i < mine.length; i++) {
      const gap =
        (toUTC(nights[mine[i][0]].date) - toUTC(nights[mine[i - 1][0]].date)) /
        DAY;
      if (report.longestLayoffDays === null || gap > report.longestLayoffDays) {
        report.longestLayoffDays = gap;
      }
    }
  }

  // Squared deviation of each matchup's weekday split from its proportional
  // target, accumulated in units of N² so the whole sum stays an exact integer
  // and one division at the end is the only floating-point step.
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
  // Round to 4dp: the value feeds a lexicographic rank tuple, where a 1e-16
  // residue would read as one plan genuinely beating another.
  if (N > 0) {
    report.pairingWeekdayExcess =
      Math.round((excessScaled / (N * N)) * 1e4) / 1e4;
  }

  return report;
}
