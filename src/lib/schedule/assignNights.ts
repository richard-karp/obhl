import type { Pairing } from "./roundRobin";

/**
 * Greedily assigns round-robin pairings onto concrete game nights + ice-time
 * slots, optimizing for: no team twice the same night, even share of each slot
 * time per team, and temporal spread (rounds are placed in order, so rematches
 * land far apart). Returns the scheduled games and a balance report.
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

export function assignNights(
  pairings: Pairing[],
  nights: Night[],
  teamIds: string[],
): { games: ScheduledGame[]; report: BalanceReport } {
  const maxSlots = nights.reduce((m, n) => Math.max(m, n.slots.length), 0);
  const slotCount = new Map<string, number[]>(
    teamIds.map((t) => [t, new Array(maxSlots).fill(0)]),
  );
  const gamesPerTeam = new Map<string, number>(teamIds.map((t) => [t, 0]));

  const games: ScheduledGame[] = [];
  const pending = [...pairings];
  const lastNightForMatchup = new Map<string, number>();
  const gaps: number[] = [];

  for (let ni = 0; ni < nights.length && pending.length > 0; ni++) {
    const night = nights[ni];
    const teamsThisNight = new Set<string>();
    const freeSlots = night.slots.map((_, idx) => idx);

    // Select compatible pairings (no team twice this night), in round order.
    const selected: Pairing[] = [];
    let k = 0;
    while (k < pending.length && selected.length < night.slots.length) {
      const p = pending[k];
      if (!teamsThisNight.has(p.home) && !teamsThisNight.has(p.away)) {
        selected.push(p);
        teamsThisNight.add(p.home);
        teamsThisNight.add(p.away);
        pending.splice(k, 1);
      } else {
        k++;
      }
    }

    // Assign each selected pairing to the slot that best balances slot share.
    for (const p of selected) {
      let bestSlot = freeSlots[0];
      let bestCost = Infinity;
      for (const s of freeSlots) {
        const cost = slotCount.get(p.home)![s] + slotCount.get(p.away)![s];
        if (cost < bestCost) {
          bestCost = cost;
          bestSlot = s;
        }
      }
      freeSlots.splice(freeSlots.indexOf(bestSlot), 1);
      slotCount.get(p.home)![bestSlot]++;
      slotCount.get(p.away)![bestSlot]++;
      gamesPerTeam.set(p.home, gamesPerTeam.get(p.home)! + 1);
      gamesPerTeam.set(p.away, gamesPerTeam.get(p.away)! + 1);

      games.push({
        home: p.home,
        away: p.away,
        round: p.round,
        scheduledAt: `${night.date}T${night.slots[bestSlot]}:00`,
        nightIndex: ni,
        slotIndex: bestSlot,
      });

      const mk = matchupKey(p.home, p.away);
      if (lastNightForMatchup.has(mk)) gaps.push(ni - lastNightForMatchup.get(mk)!);
      lastNightForMatchup.set(mk, ni);
    }
  }

  const pairingTally = new Map<string, number>();
  for (const g of games) {
    const mk = matchupKey(g.home, g.away);
    pairingTally.set(mk, (pairingTally.get(mk) ?? 0) + 1);
  }

  // Night-of-week distribution: each team's games per distinct weekday played.
  const usedWeekdays = [...new Set(nights.map((n) => weekdayOf(n.date)))].sort(
    (a, b) => a - b,
  );
  const nightTally = new Map<string, number[]>(
    teamIds.map((t) => [t, usedWeekdays.map(() => 0)]),
  );
  for (const g of games) {
    const wi = usedWeekdays.indexOf(weekdayOf(g.scheduledAt));
    if (wi < 0) continue;
    nightTally.get(g.home)![wi]++;
    nightTally.get(g.away)![wi]++;
  }

  return {
    games,
    report: {
      totalScheduled: games.length,
      unscheduled: pending.length,
      gamesPerTeam: teamIds.map((t) => ({ team: t, count: gamesPerTeam.get(t)! })),
      slotShareByTeam: teamIds.map((t) => ({ team: t, counts: slotCount.get(t)! })),
      weekdays: usedWeekdays.map((d) => WEEKDAY[d]),
      nightShareByTeam: teamIds.map((t) => ({ team: t, counts: nightTally.get(t)! })),
      pairingCounts: [...pairingTally.entries()].map(([matchup, count]) => ({
        matchup,
        count,
      })),
      minRematchGapNights: gaps.length ? Math.min(...gaps) : null,
    },
  };
}
