import { describe, it, expect } from "vitest";
import { roundRobin, buildBalancedPairings } from "./roundRobin";
import { assignNights, type Night } from "./assignNights";
import { weekdayOf } from "@/lib/format";
import { enumerateNights } from "./capacity";
import { weekdayExcessScaled, spacingReport } from "./spacing";

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
function twoNightsPerWeek(
  weeks: number,
  slots = ["19:00", "20:15", "21:30"],
): Night[] {
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

// ⛔ THE SUITE MUST RUN THE SEARCH PRODUCTION RUNS. `vitest.config.ts` used to
// pin OBHL_SLOT_RESTARTS to 2000 while `assignNights.ts` defaulted to 20000, so
// every quality bound below was a claim about a program nobody ran: at 20000 the
// two ice-time clustering tests in this file fail with "expected 13 to be less
// than or equal to 6". Measured 2026-09-09; see
// `docs/superpowers/specs/2026-09-09-schedule-variations-design.md` §1.
//
// A test config may raise a TIMEOUT. It may not override a constant that shapes
// the search.
it("runs Phase S at the production default, not a test-only one", () => {
  expect(process.env.OBHL_SLOT_RESTARTS).toBeUndefined();
});

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
      expect(Math.max(...w.counts) - Math.min(...w.counts)).toBeLessThanOrEqual(
        1,
      );
    }
    for (const s of report.slotShareByTeam) {
      // Ice-time evenness is priority #4; the spacing pass may trade it up to one
      // extra game to reduce byes/rematch clustering.
      expect(Math.max(...s.counts) - Math.min(...s.counts)).toBeLessThanOrEqual(
        2,
      );
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
      expect(Math.max(...s.counts) - Math.min(...s.counts)).toBeLessThanOrEqual(
        1,
      );
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
    const a = assignNights(buildBalancedPairings(ts, 14), ns, ts).games.map(
      key,
    );
    const b = assignNights(buildBalancedPairings(ts, 14), ns, ts).games.map(
      key,
    );
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
      const byes = ns.map((_, i) => i).filter((i) => !played.get(t)!.has(i));
      expect(byes.length).toBe(12);
      expect(byes.filter((i) => weekdayOf(ns[i].date) === 1).length).toBe(6);
    }
  });

  it("never repeats an opponent in the same week or in back-to-back weeks", () => {
    // All four, not three: this is the guard on the weekday-split term added in
    // Phase M, which is ranked below rematch spacing and must stay there.
    expect(report.spacing.rematchSameWeek).toBe(0);
    expect(report.spacing.rematchAdjNight).toBe(0);
    expect(report.spacing.rematchConsecWeek).toBe(0);
    expect(report.spacing.rematchConsecWeekSameDay).toBe(0);
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

  it("shares the ice times perfectly evenly (12 of each)", () => {
    for (const s of report.slotShareByTeam)
      expect(s.counts).toEqual([12, 12, 12]);
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

  // ---------------------------------------------------------------------------
  // The four goals the generator was missing. All four are modelled now, so
  // these assert what it achieves rather than what it used to.
  //
  // Two calibration notes:
  //  * These run under `vitest.config.ts`, which pins OBHL_SLOT_BUDGET_MS to the
  //    5000 production uses, so a goal-3 or goal-4 number seen here is evidence
  //    about the shipped one. It was 400 when these rows were written, and the
  //    figures agreed at both — which is itself the change: before Step 3 the
  //    long grind made the weekday split *worse*, and now it does not.
  //  * Phase S stops on wall clock, so goals 3 and 4 are asserted as bounds
  //    rather than exact values; the measured figures are in the comments.
  // ---------------------------------------------------------------------------

  it("goal 1: never byes a team on two game nights in a row", () => {
    // Was 1: a team sat both night 28 (Thu Dec 17) and night 29 (Mon Jan 4),
    // straddling the Christmas break. Every night needs exactly 2 teams on bye,
    // so someone must sit each of those nights — but sitting both is what turned
    // a 21-day layoff into a 24-day one, and 21 is this calendar's floor.
    expect(report.spacing.byesAdjNight).toBe(0);
    expect(report.spacing.longestLayoffDays).toBe(21);
  });

  it("goal 2: splits all 28 matchups evenly across weekdays", () => {
    const wd = ns.map((n) => weekdayOf(n.date));
    const used = [...new Set(wd)].sort((a, b) => a - b);
    const perWd = used.map((d) => wd.filter((x) => x === d).length);
    const counts = new Map<string, number[]>();
    for (const g of games) {
      const k = [g.home, g.away].sort().join("|");
      const v = counts.get(k) ?? used.map(() => 0);
      v[used.indexOf(wd[g.nightIndex])]++;
      counts.set(k, v);
    }
    expect(counts.size).toBe(28);
    // "Off its split" means a non-zero excess, which is the right test rather
    // than |Mon − Thu| > k: a 6-meeting pair at 2/4 is off its ideal 3/3 even
    // though the difference is only 2. Target was at most 3, with rematch at 0.
    //
    // Was 9 / 42 before Step 1, then 16 / 94 after it — Step 1's plateau sweep
    // moved it as a side effect, because nothing modelled it. Phase M then
    // scored it and `seedGreedy` seeded towards it, which took it to 2 / 8: the
    // cost term alone, from a weekday-blind seed, reaches 12 of 28.
    //
    // Those last two were structural, not a matter of weight. Both involved one
    // team and were mirror images — one Mon-heavy, one Thu-heavy — because
    // moving a meeting off a Monday means adding one on a Thursday, and the
    // single-night descent cannot represent a move that spans two nights. It is
    // Phase M's compound pass that clears them, by re-choosing two nights of
    // opposite weekdays together; `WD_SPLIT_W` is untouched, and all four
    // rematch metrics stay at 0 above.
    const off = [...counts.values()].filter(
      (v) => weekdayExcessScaled(v, perWd) > 0,
    );
    expect(off.length).toBe(0);
    expect(report.spacing.pairingWeekdayExcess).toBe(0);
  });

  it("goal 3: shares each ice time evenly within each weekday too", () => {
    // Was 56, with only one team even on both weekdays and the worst at
    // 9-5-4 Mon / 3-7-8 Thu. A single-weight Phase S then read 8: 14 of the 16
    // team-weekday cells at exactly 6-6-6 and two a step off, because clearing
    // the last three-game runs cost that much split.
    //
    // Best-of-k can reach a perfectly flat split — all 16 cells at 6-6-6 — and
    // now does: since Phase M's compound pass moved the pairing set under this
    // phase, the 200 candidate returns a flat split with no three-game run, and
    // took every one of five runs measured 2026-08-12.
    //
    // Still bounded at 8 rather than asserted at 0. Which candidate wins is a
    // property of the pairing set it is handed, and 0 is the prize where 8 is
    // the guarantee: a reading above 8 would mean best-of-k had picked something
    // worse than the single weight that shipped before it.
    expect(report.spacing.slotWeekdaySpread).toBeLessThanOrEqual(8);
    // Never bought at goal 4's expense — that is the comparator's job, and this
    // is the assertion that fails if the two are ever reordered.
    expect(report.spacing.slotStreak3).toBe(0);
  });

  it("goal 4: never runs a team three games deep in one ice time", () => {
    // Was 3, costed as two ordinary back-to-back repeats so that nothing
    // preferred two separate 2-runs to one 3-run. Now charged apart, and above
    // what breaking a run costs in ice share, so the schedule has none.
    // Measured: 0 at this budget and 0 at production budget.
    expect(report.spacing.slotStreak3).toBe(0);
    // The accepted trade, stated so a regression cannot hide as an improvement:
    // ordinary repeats were 39 before and may rise. Measured: 46 at both, then
    // 48 once the compound pass and the 200 candidate landed — which is what a
    // flat weekday split costs here, and still well inside the bound.
    expect(report.spacing.slotConsecutive).toBeLessThanOrEqual(55);
  });
});

// 6 teams, one game night a week, 3 sheets: everyone plays every week, so this
// is the shape where night order is free to move. Measured 2026-09-09: without
// the pass the worst team carries 14 clustered windows.
describe("assignNights — ice-time clustering, 6 teams on one weeknight", () => {
  const ts = teams(6);
  const SLOT_TIMES = ["19:00", "20:15", "21:30"];
  const ns = enumerateNights("2026-09-08", {
    weekdays: new Set([2]),
    slotTimes: SLOT_TIMES,
    excluded: new Set<string>(),
    maxNights: 23,
  });
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

  it("keeps no team far worse off than the rest on ice time", () => {
    // The floor measured by an exhaustive solver is 4. Assert the bound, not the
    // floor: pinning 4 would be asserting search luck.
    expect(report.spacing.slotClusterWorstTeam).toBeLessThanOrEqual(6);
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

  it("delivers that clustering through scheduledAt, not just the report", () => {
    const derived = fromScheduledAt();
    expect(derived.slotClusterWorstTeam).toBe(
      report.spacing.slotClusterWorstTeam,
    );
    expect(derived.slotClusterWorstTeam).toBeLessThanOrEqual(6);
    expect(derived.slotClusterWindows).toBe(report.spacing.slotClusterWindows);
  });

  it("buys that without giving up back-to-backs or runs", () => {
    expect(report.spacing.slotConsecutive).toBeLessThanOrEqual(6);
    expect(report.spacing.slotStreak3).toBe(0);
    expect(report.spacing.rematchAdjNight).toBe(0);
    expect(report.spacing.rematchConsecWeek).toBe(0);
  });

  it("still gives every team an even share of the three ice times", () => {
    for (const s of report.slotShareByTeam) {
      expect(Math.max(...s.counts) - Math.min(...s.counts)).toBeLessThanOrEqual(
        1,
      );
    }
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
