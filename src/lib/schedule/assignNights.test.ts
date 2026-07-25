import { describe, it, expect } from "vitest";
import { roundRobin, buildBalancedPairings } from "./roundRobin";
import { assignNights, type Night } from "./assignNights";

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
});
