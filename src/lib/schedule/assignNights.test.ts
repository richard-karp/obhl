import { describe, it, expect } from "vitest";
import { roundRobinRounds, buildBalancedPairings } from "./roundRobin";
import { assignNights, type Night } from "./assignNights";
import { spacingReport } from "./spacing";
import {
  eightTeamMonThu,
  sixTeamTuesdays,
  twoNightsPerWeek,
} from "./calendars.test-support";

const teams = (n: number) => Array.from({ length: n }, (_, i) => `t${i + 1}`);

// Two weeknights (Tue + Fri) a week: the generator groups games by calendar week, so tests
// must feed weekly-spaced nights, not consecutive days.
function nights(count: number, slots = ["19:00", "20:15", "21:30"]): Night[] {
  const ns: Night[] = [];
  const base = Date.UTC(2026, 8, 1); // Tue 2026-09-01
  outer: for (let w = 0; ; w++) {
    for (const off of [0, 3]) {
      if (ns.length >= count) break outer;
      const d = new Date(base + (w * 7 + off) * 86400000);
      ns.push({ date: d.toISOString().slice(0, 10), slots });
    }
  }
  return ns;
}

// ⛔ A test config may raise a timeout, never set a search constant: at a test-only restart
// count the suite tests a search production never runs. RUNBOOK.md, _Standing gates_.
it("runs Phase S at the production default, not a test-only one", () => {
  expect(process.env.OBHL_SLOT_RESTARTS).toBeUndefined();
});

describe("assignNights", () => {
  it("schedules all 6-team games, no team twice a night, 5 games each", () => {
    const ts = teams(6);
    const { games, report } = assignNights(
      roundRobinRounds(ts, 5),
      nights(5),
      ts,
    );
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

  it("handles 7 teams (byes) without scheduling a team twice a night", () => {
    const ts = teams(7);
    const { games, report } = assignNights(
      roundRobinRounds(ts, 7),
      nights(11),
      ts,
    );
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
    const { report } = assignNights(
      roundRobinRounds(ts, 10),
      twoNightsPerWeek(5),
      ts,
    );
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
    const { report } = assignNights(roundRobinRounds(ts, 5), nights(2), ts);
    expect(report.unscheduled).toBeGreaterThan(0);
    expect(report.totalScheduled).toBeLessThan(15);
  });

  it("balances weekday share when slots < teams/2 (spilled rounds)", () => {
    const ts = teams(8);
    const ns = twoNightsPerWeek(14, ["19:00", "20:15"]);
    const { report } = assignNights(buildBalancedPairings(ts, 14), ns, ts);
    expect(report.unscheduled).toBe(0);
    expect(report.weekdays.length).toBe(2);
    for (const t of report.gamesPerTeam) expect(t.count).toBe(14);
    for (const w of report.nightShareByTeam) {
      expect(Math.max(...w.counts) - Math.min(...w.counts)).toBeLessThanOrEqual(
        1,
      );
    }
  });
});

// The live league's shape: 144 games fill 48 nights exactly, so weekday balance and byes fight.
describe("assignNights — full-season reference schedule", () => {
  const ts = teams(8);
  const ns = eightTeamMonThu(48, [
    "2026-12-21",
    "2026-12-24",
    "2026-12-28",
    "2026-12-31",
    "2027-03-04",
  ]);
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

  it("keeps opponents balanced — 36 games over 7 opponents is 5s and one 6", () => {
    expect(report.pairingCounts.length).toBe(28);
    const sixes = report.pairingCounts.filter((p) => p.count === 6);
    expect(
      report.pairingCounts.every((p) => p.count === 5 || p.count === 6),
    ).toBe(true);
    expect(sixes.length).toBe(4);
    expect(new Set(sixes.flatMap((p) => p.matchup.split("|"))).size).toBe(8);
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

// ⛔ Compares `scheduledAt`, the only persisted positional field: `nightIndex` would pass
// against a generator that changed nothing a manager sees.
describe("assignNights — seeds produce different schedules", () => {
  const ts = teams(6);
  const ns = sixTeamTuesdays(23);
  const pairings = buildBalancedPairings(ts, 23);
  // ⚠️ `variations: 1`: this tests the seed lever, and a best-of-four per call runs eight
  // generates per test, past the 30 s `testTimeout`.
  const stamps = (seed?: number) =>
    assignNights(pairings, ns, ts, { ...(seed === undefined ? {} : { seed }), variations: 1 })
      .games.map((g) => `${g.home}|${g.away}|${g.scheduledAt}`)
      .sort()
      .join("\n");

  // Hoisted: each of these is a full generate.
  const one = stamps(1);
  const oneAgain = stamps(1);
  const two = stamps(2);
  const bare = stamps();

  it("returns the same schedule for the same seed", () => {
    expect(oneAgain).toBe(one);
  });

  it("returns a different schedule for a different seed", () => {
    expect(two).not.toBe(one);
  });

  it("defaults to seed 1", () => {
    expect(bare).toBe(one);
  });
});

describe("assignNights — a variation is the best of its block", () => {
  const ts = teams(6);
  const ns = sixTeamTuesdays(10);
  // ⚠️ A short season on purpose: this tests block-selection mechanics, which don't depend on
  // length; the quality bounds live on the 23-week fixture below.
  const pairings = buildBalancedPairings(ts, 10);

  const stamps = (r: ReturnType<typeof assignNights>) =>
    r.games.map((g) => `${g.home}|${g.away}|${g.scheduledAt}`).sort().join("\n");
  const chosen = assignNights(pairings, ns, ts, { variations: 4 });
  const singles = [1, 2, 3, 4].map((seed) =>
    assignNights(pairings, ns, ts, { seed, variations: 1 }),
  );

  it("returns a schedule that is actually one of the four", () => {
    expect(singles.map(stamps)).toContain(stamps(chosen));
  });

  // ⛔ `home|away|scheduledAt`, never `scheduledAt` alone: every schedule here fills the same
  // cells, so timestamps alone compare the calendar and pass on different schedules.
  it("variation 2 draws a different block than variation 1", () => {
    const second = assignNights(pairings, ns, ts, { seed: 2, variations: 4 });
    expect(stamps(second)).not.toBe(stamps(chosen));
  });
});

describe("assignNights — ice-time clustering, 6 teams on one weeknight", () => {
  const ts = teams(6);
  const SLOT_TIMES = ["19:00", "20:15", "21:30"];
  const ns = sixTeamTuesdays(23);
  const { games, report } = assignNights(buildBalancedPairings(ts, 23), ns, ts);

  // Re-derived the way everything downstream sees it: only `scheduledAt` persists, so anything
  // `report.spacing` claims beyond it is a quality the product does not have.
  const fromScheduledAt = () => {
    const dates = [
      ...new Set(games.map((g) => g.scheduledAt.slice(0, 10))),
    ].sort();
    const nightOf = new Map(dates.map((d, i) => [d, i]));
    return spacingReport(
      games.map((g) => ({
        home: g.home,
        away: g.away,
        nightIndex: nightOf.get(g.scheduledAt.slice(0, 10))!,
        slotIndex: SLOT_TIMES.indexOf(g.scheduledAt.slice(11, 16)),
      })),
      dates.map((date) => ({ date, slots: SLOT_TIMES })),
      ts,
    );
  };

  it("schedules the whole season", () => {
    expect(report.unscheduled).toBe(0);
    expect(games.length).toBe(69);
    for (const t of report.gamesPerTeam) expect(t.count).toBe(23);
  });

  // ⛔ The night-order pass rewrites `nightIndex`, but only `scheduledAt` reaches the database:
  // a pass moving one and not the other reports a quality the shipped schedule lacks.
  it("moves scheduledAt with nightIndex", () => {
    for (const g of games)
      expect(g.scheduledAt.slice(0, 10)).toBe(ns[g.nightIndex].date);
  });

  it("reports the clustering the stored scheduledAt actually has", () => {
    const derived = fromScheduledAt();
    expect(derived.slotClusterWorstTeam).toBe(
      report.spacing.slotClusterWorstTeam,
    );
    expect(derived.slotClusterWindows).toBe(report.spacing.slotClusterWindows);
  });
});

// ⚠️ Fewer sheets on some nights is a supported shape: a night order moving a 3-game block onto
// a 2-sheet night ships `Tundefined:00`. Dropping the `overflow` term fails this.
describe("assignNights — night order respects per-night ice capacity", () => {
  const ts = teams(6);
  const ALL = ["19:00", "20:15", "21:30"];
  const ns: Night[] = [];
  for (let i = 0; i < 22; i++) {
    ns.push({
      date: new Date(Date.UTC(2026, 8, 8) + i * 7 * 86400000)
        .toISOString()
        .slice(0, 10),
      slots: i % 2 === 0 ? ALL : ALL.slice(0, 2),
    });
  }
  const { games, report } = assignNights(buildBalancedPairings(ts, 18), ns, ts);

  it("places the whole season", () => {
    expect(report.unscheduled).toBe(0);
    expect(games.length).toBe(54);
  });

  it("never stamps an ice time its night does not have", () => {
    for (const g of games) {
      expect(g.slotIndex).toBeLessThan(ns[g.nightIndex].slots.length);
      expect(g.scheduledAt).toBe(
        `${ns[g.nightIndex].date}T${ns[g.nightIndex].slots[g.slotIndex]}:00`,
      );
    }
  });
});
