import { describe, it, expect } from "vitest";
import { roundRobin, buildBalancedPairings } from "./roundRobin";
import { assignNights, type Night } from "./assignNights";
import { weekdayOf } from "@/lib/format";
import { enumerateNights } from "./capacity";

const teams = (n: number) => Array.from({ length: n }, (_, i) => `t${i + 1}`);

// `count` game nights in a realistic weekly cadence — two distinct weeknights
// (Tue + Fri) per calendar week. The generator groups games by calendar week, so
// tests must feed weekly-spaced nights, not consecutive calendar days.
function nights(count: number, slots = ["19:00", "20:15", "21:30"]): Night[] {
  const ns: Night[] = [];
  const base = Date.UTC(2026, 8, 1); // Tue 2026-09-01
  outer: for (let w = 0; ; w++) {
    for (const off of [0, 3]) {
      // Tue, Fri
      if (ns.length >= count) break outer;
      const d = new Date(base + (w * 7 + off) * 86400000);
      ns.push({ date: d.toISOString().slice(0, 10), slots });
    }
  }
  return ns;
}

// Two recurring weeknights (e.g. Tue + Thu) for `weeks` weeks, chronological.
function twoNightsPerWeek(weeks: number, slots = ["19:00", "20:15", "21:30"]): Night[] {
  const ns: Night[] = [];
  const base = Date.UTC(2026, 8, 1); // 2026-09-01
  for (let w = 0; w < weeks; w++) {
    for (const off of [0, 2]) {
      const d = new Date(base + (w * 7 + off) * 86400000);
      ns.push({ date: d.toISOString().slice(0, 10), slots });
    }
  }
  return ns;
}

describe("assignNights", () => {
  it("schedules all 6-team games, no team twice a night, 5 games each", () => {
    const ts = teams(6);
    const { games, report } = assignNights(roundRobin(ts, 1), nights(5), ts);
    expect(report.unscheduled).toBe(0);
    expect(games.length).toBe(15);

    const perNight = new Map<number, Set<string>>();
    for (const g of games) {
      const set = perNight.get(g.nightIndex) ?? new Set<string>();
      expect(set.has(g.home)).toBe(false);
      expect(set.has(g.away)).toBe(false);
      set.add(g.home);
      set.add(g.away);
      perNight.set(g.nightIndex, set);
    }
    for (const t of report.gamesPerTeam) expect(t.count).toBe(5);
  });

  it("balances slot-time share per team (max-min <= 1)", () => {
    const ts = teams(6);
    const { report } = assignNights(roundRobin(ts, 2), nights(10), ts);
    for (const s of report.slotShareByTeam) {
      const max = Math.max(...s.counts);
      const min = Math.min(...s.counts);
      expect(max - min).toBeLessThanOrEqual(1);
    }
  });

  it("handles 7 teams (byes) without scheduling a team twice a night", () => {
    const ts = teams(7);
    const { games, report } = assignNights(roundRobin(ts, 1), nights(11), ts);
    expect(report.unscheduled).toBe(0);
    const perNight = new Map<number, Set<string>>();
    for (const g of games) {
      const set = perNight.get(g.nightIndex) ?? new Set<string>();
      expect(set.has(g.home)).toBe(false);
      expect(set.has(g.away)).toBe(false);
      set.add(g.home);
      set.add(g.away);
      perNight.set(g.nightIndex, set);
    }
    for (const t of report.gamesPerTeam) expect(t.count).toBe(6);
  });

  it("balances games per night-of-week across two weekly nights (max-min <= 1)", () => {
    const ts = teams(6);
    // 6-team double = 10 rounds; Tue+Thu for 5 weeks = 10 nights × 3 slots.
    const { report } = assignNights(roundRobin(ts, 2), twoNightsPerWeek(5), ts);
    expect(report.unscheduled).toBe(0);
    expect(report.weekdays.length).toBe(2);
    for (const n of report.nightShareByTeam) {
      const max = Math.max(...n.counts);
      const min = Math.min(...n.counts);
      expect(max - min).toBeLessThanOrEqual(1);
    }
  });

  it("reports unscheduled games when capacity is insufficient", () => {
    const ts = teams(6);
    const { report } = assignNights(roundRobin(ts, 1), nights(2), ts);
    expect(report.unscheduled).toBeGreaterThan(0);
    expect(report.totalScheduled).toBeLessThan(15);
  });

  it("balances weekday and slot share when slots < teams/2 (spilled rounds)", () => {
    const ts = teams(8);
    // 8 teams, 2 slots/night, Tue+Thu for 14 weeks = 28 nights x 2 = 56 slots.
    // Double round-robin = 14 games each = 56 games -> exact fit, rounds spill
    // across nights (a round is 4 games but a night holds only 2).
    const ns = twoNightsPerWeek(14, ["19:00", "20:15"]);
    const { report } = assignNights(buildBalancedPairings(ts, 14), ns, ts);
    expect(report.unscheduled).toBe(0);
    expect(report.weekdays.length).toBe(2);
    for (const t of report.gamesPerTeam) expect(t.count).toBe(14);
    for (const w of report.nightShareByTeam) {
      // Weekday balance is priority #1 — stays within one game.
      expect(Math.max(...w.counts) - Math.min(...w.counts)).toBeLessThanOrEqual(1);
    }
    for (const s of report.slotShareByTeam) {
      // Ice-time evenness is priority #4; the spacing pass may trade it up to one
      // extra game to reduce byes/rematch clustering.
      expect(Math.max(...s.counts) - Math.min(...s.counts)).toBeLessThanOrEqual(2);
    }
  });

  it("gives every team an equal number of byes", () => {
    const ts = teams(8);
    const ns = twoNightsPerWeek(14, ["19:00", "20:15"]);
    const { games } = assignNights(buildBalancedPairings(ts, 14), ns, ts);
    const played = new Map<string, Set<number>>(ts.map((t) => [t, new Set()]));
    for (const g of games) {
      played.get(g.home)!.add(g.nightIndex);
      played.get(g.away)!.add(g.nightIndex);
    }
    const byes = ts.map((t) => ns.length - played.get(t)!.size);
    expect(Math.max(...byes) - Math.min(...byes)).toBe(0);
  });

  it("keeps each team's times balanced and shares the worst time evenly", () => {
    const ts = teams(6);
    // 6 teams single RR = 5 games each; 3 slots -> 5 not divisible by 3.
    const { report } = assignNights(roundRobin(ts, 1), nights(5), ts);
    // Each team's own slot spread stays tight.
    for (const s of report.slotShareByTeam) {
      expect(Math.max(...s.counts) - Math.min(...s.counts)).toBeLessThanOrEqual(1);
    }
    // The latest (worst) time is shared evenly across teams — no team eats it
    // much more than another.
    const last = report.slotShareByTeam[0].counts.length - 1;
    const worst = report.slotShareByTeam.map((s) => s.counts[last]);
    expect(Math.max(...worst) - Math.min(...worst)).toBeLessThanOrEqual(1);
  });

  it("spreads rematches apart (never on back-to-back game nights)", () => {
    const ts = teams(6);
    const { report } = assignNights(roundRobin(ts, 2), nights(10), ts);
    expect(report.unscheduled).toBe(0);
    expect(report.minRematchGapNights).not.toBeNull();
    expect(report.minRematchGapNights!).toBeGreaterThanOrEqual(2);
  });

  it("is deterministic for a given input", () => {
    const ts = teams(8);
    const ns = twoNightsPerWeek(14, ["19:00", "20:15"]);
    const key = (g: { home: string; away: string; scheduledAt: string }) =>
      `${g.home}|${g.away}|${g.scheduledAt}`;
    const a = assignNights(buildBalancedPairings(ts, 14), ns, ts).games.map(key);
    const b = assignNights(buildBalancedPairings(ts, 14), ns, ts).games.map(key);
    expect(a).toEqual(b);
  });
});

// The live OBHL setup, and the case the generator is tuned against: 8 teams on
// Mondays and Thursdays, 3 sheets of ice a night, 36 games each, with the last
// two weeks of December and one Thursday in March off. It comes out to 48 nights
// holding exactly 144 games, so every sheet is used and 2 of the 8 teams bye
// every night — which is what makes weekday balance and bye spacing fight.
describe("assignNights — full-season reference schedule", () => {
  const ts = teams(8);
  const ns = enumerateNights("2026-09-10", {
    weekdays: new Set([1, 4]), // Mon + Thu
    slotTimes: ["19:00", "20:15", "21:30"],
    excluded: new Set([
      "2026-12-21",
      "2026-12-24",
      "2026-12-28",
      "2026-12-31",
      "2027-03-04",
    ]),
    maxNights: 48,
  });
  const { games, report } = assignNights(buildBalancedPairings(ts, 36), ns, ts);

  it("fills the calendar exactly, 36 games a team", () => {
    expect(ns.length).toBe(48);
    expect(report.unscheduled).toBe(0);
    expect(games.length).toBe(144);
    for (const t of report.gamesPerTeam) expect(t.count).toBe(36);
  });

  it("gives every team a perfectly even weekday split (18 Mon / 18 Thu)", () => {
    for (const n of report.nightShareByTeam) expect(n.counts).toEqual([18, 18]);
  });

  it("satisfies all three bye rules", () => {
    // 1: never two byes in one week. 2: never the same weekday in consecutive
    // weeks. 3: never two bye weeks back to back at all.
    expect(report.spacing.byesMultiWeek).toBe(0);
    expect(report.spacing.byesConsecWeekSameDay).toBe(0);
    expect(report.spacing.byesConsecWeek).toBe(0);
  });

  it("gives every team the same 12 byes, split evenly across weekdays", () => {
    const played = new Map<string, Set<number>>(ts.map((t) => [t, new Set()]));
    for (const g of games) {
      played.get(g.home)!.add(g.nightIndex);
      played.get(g.away)!.add(g.nightIndex);
    }
    for (const t of ts) {
      const byes = ns
        .map((_, i) => i)
        .filter((i) => !played.get(t)!.has(i));
      expect(byes.length).toBe(12);
      expect(byes.filter((i) => weekdayOf(ns[i].date) === 1).length).toBe(6);
    }
  });

  it("never repeats an opponent in the same week or in back-to-back weeks", () => {
    expect(report.spacing.rematchSameWeek).toBe(0);
    expect(report.spacing.rematchAdjNight).toBe(0);
    expect(report.spacing.rematchConsecWeek).toBe(0);
  });

  it("keeps opponents balanced — 36 games over 7 opponents is 5s and one 6", () => {
    expect(report.pairingCounts.length).toBe(28);
    const sixes = report.pairingCounts.filter((p) => p.count === 6);
    expect(report.pairingCounts.every((p) => p.count === 5 || p.count === 6)).toBe(true);
    // One 6 per team, so the 6s form a perfect matching over the 8 teams.
    expect(sixes.length).toBe(4);
    expect(new Set(sixes.flatMap((p) => p.matchup.split("|"))).size).toBe(8);
  });

  it("shares the ice times perfectly evenly (12 of each)", () => {
    for (const s of report.slotShareByTeam) expect(s.counts).toEqual([12, 12, 12]);
  });

  it("never books a team twice on one night", () => {
    const perNight = new Map<number, Set<string>>();
    for (const g of games) {
      const set = perNight.get(g.nightIndex) ?? new Set<string>();
      expect(set.has(g.home)).toBe(false);
      expect(set.has(g.away)).toBe(false);
      set.add(g.home);
      set.add(g.away);
      perNight.set(g.nightIndex, set);
    }
  });
});
