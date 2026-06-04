import { describe, it, expect } from "vitest";
import { roundRobin } from "./roundRobin";
import { assignNights, type Night } from "./assignNights";

const teams = (n: number) => Array.from({ length: n }, (_, i) => `t${i + 1}`);

function nights(count: number, slots = ["19:00", "20:15", "21:30"]): Night[] {
  return Array.from({ length: count }, (_, i) => ({
    date: `2026-09-${String(1 + i).padStart(2, "0")}`,
    slots,
  }));
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
});
