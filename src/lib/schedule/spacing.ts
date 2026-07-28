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
  const anchor = first - (((firstWd + 6) % 7) * DAY); // back to Monday
  const week = nights.map((n) => Math.floor((toUTC(n.date) - anchor) / (7 * DAY)));
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

export function spacingReport(
  games: PlacedGame[],
  nights: Night[],
  teamIds: string[],
): SpacingReport {
  const meta = buildNightMeta(nights);
  const played = new Map<string, Set<number>>(teamIds.map((t) => [t, new Set()]));
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
    (matchupNights.get(k) ?? matchupNights.set(k, []).get(k)!).push(g.nightIndex);
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
  };

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
    // Slot consecutiveness across this team's games in chronological order.
    const mine = [...slotByNight.get(t)!.entries()].sort((x, y) => x[0] - y[0]);
    for (let i = 1; i < mine.length; i++) {
      if (mine[i][1] === mine[i - 1][1]) report.slotConsecutive++;
    }
  }

  for (const nis of matchupNights.values()) {
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

  return report;
}
