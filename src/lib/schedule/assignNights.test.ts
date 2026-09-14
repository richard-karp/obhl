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

// ⛔ THE SUITE MUST RUN THE SEARCH PRODUCTION RUNS. `vitest.config.ts` used to
// pin OBHL_SLOT_RESTARTS to 2000 while `assignNights.ts` defaulted to 20000, so
// every quality bound below was a claim about a program nobody ran: at 20000 the
// two ice-time clustering tests in this file fail with "expected 13 to be less
// than or equal to 6". Measured 2026-09-09; see `RUNBOOK.md` → Standing gates.
//
// A test config may raise a TIMEOUT. It may not override a constant that shapes
// the search.
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
    // 6-team double = 10 rounds; Tue+Thu for 5 weeks = 10 nights × 3 slots.
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
      expect(Math.max(...w.counts) - Math.min(...w.counts)).toBeLessThanOrEqual(
        1,
      );
    }
  });
});

// The live OBHL setup, and the case the generator is tuned against: 8 teams on
// Mondays and Thursdays, 3 sheets of ice a night, 36 games each, with the last
// two weeks of December and one Thursday in March off. It comes out to 48 nights
// holding exactly 144 games, so every sheet is used and 2 of the 8 teams bye
// every night — which is what makes weekday balance and bye spacing fight.
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
    // One 6 per team, so the 6s form a perfect matching over the 8 teams.
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

// 6 teams, one game night a week, 3 sheets: everyone plays every week, so this
// is the shape where night order is free to move. Measured 2026-09-09: without
// the pass the worst team carries 14 clustered windows.
// Six seeds gave six distinct schedules when this was measured (see
// `RUNBOOK.md` → Schedule generator). Two is all this needs to assert: that the
// lever is connected at all.
//
// ⛔ Compares `scheduledAt`, the only positional field that is persisted.
// Comparing `nightIndex` would pass against a generator that changed nothing a
// manager can see — the exact failure mode the first clustering attempt shipped.
describe("assignNights — seeds produce different schedules", () => {
  const ts = teams(6);
  const ns = sixTeamTuesdays(23);
  const pairings = buildBalancedPairings(ts, 23);
  // ⚠️ `variations: 1` throughout. This describe tests the SEED lever, not
  // block selection — without it each call is a best-of-four and these three
  // tests run eight generates apiece, which is both eight times the cost and
  // past the 30 s `testTimeout`. Block selection has its own describe below.
  const stamps = (seed?: number) =>
    assignNights(pairings, ns, ts, { ...(seed === undefined ? {} : { seed }), variations: 1 })
      .games.map((g) => `${g.home}|${g.away}|${g.scheduledAt}`)
      .sort()
      .join("\n");

  // Hoisted: each of these is a full generate, and computing `stamps(1)` inside
  // three separate `it`s ran it three times for no extra coverage.
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

// A variation is the best of a block of seeds, ranked by `rankSchedule` — the
// same lexicographic comparator the planner rank-off uses, whose last two
// entries are the clustering terms. That is the ONLY place clustering can enter
// selection: Phase S's own `compareIceOutcome` cannot see it, which is why more
// Phase S search returns WORSE clustering (spec §2 of
// `2026-09-09-schedule-variations-design.md`).
describe("assignNights — a variation is the best of its block", () => {
  const ts = teams(6);
  const ns = sixTeamTuesdays(10);
  // ⚠️ A SHORT season on purpose. This describe tests the MECHANICS of block
  // selection — that the winner is the block's lexicographic minimum and comes
  // from the block — and those do not depend on season length. The quality
  // claims (worst-team clustering <= 6) live on the full 23-week fixture below,
  // which is the shape the league actually plays. Ten weeks keeps a generate at
  // ~3 s instead of ~6.6 s, and this file runs a dozen of them.
  const pairings = buildBalancedPairings(ts, 10);

  // Computed once and shared: each of these is a full generate (~6.6 s), and
  // running the block plus its four members per test doubled the file's cost.
  const stamps = (r: ReturnType<typeof assignNights>) =>
    r.games.map((g) => `${g.home}|${g.away}|${g.scheduledAt}`).sort().join("\n");
  const chosen = assignNights(pairings, ns, ts, { variations: 4 });
  const singles = [1, 2, 3, 4].map((seed) =>
    assignNights(pairings, ns, ts, { seed, variations: 1 }),
  );

  it("returns a schedule that is actually one of the four", () => {
    expect(singles.map(stamps)).toContain(stamps(chosen));
  });

  // ⛔ `home|away|scheduledAt`, never `scheduledAt` alone. Every schedule over
  // this calendar fills the same (night, slot) cells, so comparing timestamps
  // compares the CALENDAR and passes against two completely different
  // schedules. This was written that way first, and it did exactly that.
  it("variation 2 draws a different block than variation 1", () => {
    const second = assignNights(pairings, ns, ts, { seed: 2, variations: 4 });
    expect(stamps(second)).not.toBe(stamps(chosen));
  });

  // The regression this selection nearly shipped: ranked by `rankSchedule`'s own
  // order, best-of-4 picks the seed with fewer back-to-backs and far worse
  // clustering, so four draws produce a worse schedule than one. Measured
  // 2026-09-09: seed 1 is (b2b 6, worst-team 4); seed 2 is (b2b 4, worst-team
  // 10); plain `rankSchedule` selects seed 2.
});

describe("assignNights — ice-time clustering, 6 teams on one weeknight", () => {
  const ts = teams(6);
  const SLOT_TIMES = ["19:00", "20:15", "21:30"];
  const ns = sixTeamTuesdays(23);
  const { games, report } = assignNights(buildBalancedPairings(ts, 23), ns, ts);

  // Re-derive the season the way everything downstream actually sees it. Only
  // `scheduledAt` is persisted (`src/lib/actions/schedule.ts` writes
  // `scheduled_at`; `nightIndex`/`slotIndex` are in-memory scratch), so the CSV
  // and calendar exports, the manager preview and the database all reconstruct
  // night order and ice time from that one string. Anything `report.spacing`
  // claims that this disagrees with is a quality the product does not have.
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

  // ⛔ The night-order pass rewrites `nightIndex`, but `scheduledAt` is a STORED
  // field baked when the game is created — and it is the only one that reaches
  // the database. A pass that moves one and not the other reports a quality the
  // shipped schedule does not have. Measured 2026-09-09 before the fix: all 69
  // games disagreed, and the re-derived worst team was 14 against a reported 4 —
  // exactly the pre-branch number, i.e. the feature delivered nothing.
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

// A permutation carries each night's games onto whatever night lands in that
// position, slot indexes and all. `enumerateNights` gives every night the same
// `slotTimes`, so this shape only arises from hand-built nights — but every
// other placement site consults per-night `slots.length`, so it is a supported
// one, and once `scheduledAt` is rebuilt from the moved night an over-capacity
// landing writes a literal `Tundefined:00` into the row that ships.
//
// Verified this test can fail (2026-09-09): dropping the `overflow` term from
// the night-order scorer's admissibility puts 6 of these 54 games on
// `YYYY-MM-DDTundefined:00`.
describe("assignNights — night order respects per-night ice capacity", () => {
  const ts = teams(6);
  const ALL = ["19:00", "20:15", "21:30"];
  const ns: Night[] = [];
  for (let i = 0; i < 22; i++) {
    ns.push({
      date: new Date(Date.UTC(2026, 8, 8) + i * 7 * 86400000)
        .toISOString()
        .slice(0, 10),
      // Alternating 3 and 2 sheets — a night order that moves a 3-game block
      // onto a 2-sheet night is the failure this fixture exists to catch.
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
