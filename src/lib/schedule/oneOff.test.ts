import { describe, it, expect } from "vitest";
import { buildBalancedPairings } from "./roundRobin";
import { assignNights } from "./assignNights";
import { weekdayOf } from "@/lib/format";
import {
  planOneOff,
  planRepair,
  checkOneOffWrite,
  buildOneOffRows,
  iceTimeSpread,
  type BuildRowsOptions,
  type CheckWriteOptions,
  type IceMetric,
  type OneOffNight,
  type OneOffPlan,
  type OneOffRow,
} from "./oneOff";
import { homeAwaySpread } from "./homeAway";
import { twoNightsPerWeek } from "./calendars.test-support";

/** A generated season in the planner's shape: 8 teams on three ice times, so byes make it
 *  hard. RUNBOOK.md, _Schedule generator_. */
function season(opts: { teams: number; weeks: number; gamesPerTeam: number }) {
  const ids = Array.from({ length: opts.teams }, (_, i) => `t${i + 1}`);
  const cal = twoNightsPerWeek(opts.weeks);
  const { games } = assignNights(
    buildBalancedPairings(ids, opts.gamesPerTeam),
    cal,
    ids,
  );
  const index = new Map(ids.map((t, i) => [t, i]));

  const byNight = new Map<number, { slot: number; pair: [number, number] }[]>();
  for (const g of games) {
    const row = byNight.get(g.nightIndex) ?? [];
    row.push({
      slot: g.slotIndex,
      pair: [index.get(g.home)!, index.get(g.away)!],
    });
    byNight.set(g.nightIndex, row);
  }

  const nights: OneOffNight[] = [];
  for (let n = 0; n < cal.length; n++) {
    const row = byNight.get(n);
    if (!row || row.length === 0) continue;
    row.sort((a, b) => a.slot - b.slot);
    nights.push({
      date: cal[n].date,
      games: row.map((r) => r.pair),
      locked: false,
    });
  }
  return { nights, teamCount: opts.teams };
}

/** The state a plan produces, in the planner's own input shape. */
function applyPlan(nights: OneOffNight[], plan: OneOffPlan): OneOffNight[] {
  const out = nights.map((n) => ({
    ...n,
    games: n.games.map((g) => [...g] as [number, number]),
  }));
  for (const c of plan.changes)
    out[c.night].games = c.to.map((g) => [...g] as [number, number]);
  return out;
}

/** The three things a one-off must never move. */
function invariants(teamCount: number, nights: OneOffNight[]) {
  const gp = new Array<number>(teamCount).fill(0);
  const byes = new Array<number>(teamCount).fill(0);
  const weekday = new Map<string, number>();
  nights.forEach((night) => {
    const playing = new Set(night.games.flat());
    const wd = weekdayOf(night.date);
    for (let t = 0; t < teamCount; t++) {
      if (playing.has(t)) {
        gp[t]++;
        weekday.set(`${t}:${wd}`, (weekday.get(`${t}:${wd}`) ?? 0) + 1);
      } else {
        byes[t]++;
      }
    }
  });
  return { gp, byes, weekday: [...weekday.entries()].sort() };
}

type Target = { night: number; pair: [number, number] };

/** A night both teams play but don't already meet; `accept` narrows it further. */
function pickTarget(
  nights: OneOffNight[],
  from: number,
  accept: (t: Target) => boolean = () => true,
): Target {
  for (let n = from; n < nights.length; n++) {
    const playing = [...new Set(nights[n].games.flat())];
    const meeting = new Set(
      nights[n].games.map((g) => [...g].sort().join("-")),
    );
    for (const a of playing) {
      for (const b of playing) {
        if (a >= b) continue;
        if (meeting.has([a, b].sort().join("-"))) continue;
        const t: Target = { night: n, pair: [a, b] };
        if (accept(t)) return t;
      }
    }
  }
  throw new Error("no eligible night in fixture");
}

describe("planOneOff", () => {
  const base = season({ teams: 8, weeks: 8, gamesPerTeam: 12 });
  // Half the season already played, as it would be mid-season.
  const nights = base.nights.map((n, i) => ({ ...n, locked: i < 6 }));
  const T = base.teamCount;
  const target = pickTarget(nights, 6);

  const result = planOneOff({
    teamCount: T,
    nights,
    oneOffNight: target.night,
    forcedPairs: [target.pair],
  });
  if (!result.ok) throw new Error(result.reason);
  const plans = result.plans;

  it("produces the baseline plus at least one repair", () => {
    expect(plans.length).toBeGreaterThan(1);
    expect(plans[0].id).toBe("no-repair");
  });

  it("never moves games played, byes, or weekday counts", () => {
    const before = invariants(T, nights);
    for (const plan of plans) {
      const after = invariants(T, applyPlan(nights, plan));
      expect(after.gp).toEqual(before.gp);
      expect(after.byes).toEqual(before.byes);
      expect(after.weekday).toEqual(before.weekday);
    }
  });

  it("never touches a locked night", () => {
    for (const plan of plans) {
      for (const c of plan.changes) expect(nights[c.night].locked).toBe(false);
    }
  });

  it("puts the forced matchup on the chosen night in every plan", () => {
    const want = [...target.pair].sort().join("-");
    for (const plan of plans) {
      const after = applyPlan(nights, plan);
      const keys = after[target.night].games.map((g) =>
        [...g].sort().join("-"),
      );
      expect(keys).toContain(want);
    }
  });

  it("leaves opponent balance off target if nothing is repaired", () => {
    const baseline = plans.find((p) => p.id === "no-repair")!;
    expect(baseline.drift.length).toBeGreaterThan(0);
    expect(baseline.changes.every((c) => c.night === target.night)).toBe(true);
  });

  // ⚠️ Exact repair belongs to the instance, not an invariant (on night 6, nine of twelve pairs
  // repair exactly; 25× the effort moves none of the rest), so find a repairable target first.
  it(
    "restores opponent balance where exact repair is reachable",
    { timeout: 60_000 },
    () => {
      const repairable = pickTarget(nights, 6, (t) => {
        const r = planOneOff({
          teamCount: T,
          nights,
          oneOffNight: t.night,
          forcedPairs: [t.pair],
        });
        return (
          r.ok &&
          r.plans.some((p) => p.id !== "no-repair" && p.drift.length === 0)
        );
      });
      const result = planOneOff({
        teamCount: T,
        nights,
        oneOffNight: repairable.night,
        forcedPairs: [repairable.pair],
      });
      if (!result.ok) throw new Error(result.reason);
      const repairs = result.plans.filter((p) => p.id !== "no-repair");
      expect(repairs.length).toBeGreaterThan(0);
      expect(repairs.some((p) => p.drift.length === 0)).toBe(true);
    },
  );

  it("never leaves opponent balance worse than leaving the season alone", () => {
    // Meeting counts outweigh churn, so a repair may fail to close the gap but never widen it.
    const baseline = plans.find((p) => p.id === "no-repair")!;
    const off = (p: OneOffPlan) =>
      p.drift.reduce((s, d) => s + Math.abs(d.delta), 0);
    const repairs = plans.filter((p) => p.id !== "no-repair");
    expect(repairs.length).toBeGreaterThan(0);
    for (const plan of repairs)
      expect(off(plan)).toBeLessThanOrEqual(off(baseline));
  });

  it("never leaves home/away worse than it found it", () => {
    for (const plan of plans.filter((p) => p.id !== "no-repair")) {
      expect(plan.homeAwaySpreadAfter).toBeLessThanOrEqual(
        plan.homeAwaySpreadBefore,
      );
    }
  });

  it("repairs ice-time share far better than doing nothing", () => {
    // Not back to the pre-edit value (new matchups decide who shares a slot): only beats nothing.
    const baseline = plans.find((p) => p.id === "no-repair")!;
    for (const plan of plans.filter((p) => p.id !== "no-repair")) {
      expect(plan.slotSpreadAfter).toBeLessThan(baseline.slotSpreadAfter);
    }
  });

  it("holds the per-weekday ice split rather than chasing the season total", () => {
    // Every ice metric a repair regresses against no repair must appear in `worseThan`, and
    // nothing else; derived here independently of `oneOff.ts`'s helper.
    const res = planOneOff({
      teamCount: T,
      nights,
      oneOffNight: target.night,
      forcedPairs: [target.pair],
      featureSlot: false,
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const baseline = res.plans.find((p) => p.id === "no-repair")!;
    const repairs = res.plans.filter((p) => p.id !== "no-repair");
    expect(repairs.length).toBeGreaterThan(0);
    expect(baseline.worseThan).toEqual([]);
    for (const plan of repairs) {
      const regressed: IceMetric[] = [];
      if (plan.slotSpreadAfter > baseline.slotSpreadAfter) {
        regressed.push("seasonSpread");
      }
      if (
        plan.spacingAfter.slotWeekdaySpread >
        baseline.spacingAfter.slotWeekdaySpread
      ) {
        regressed.push("weekdaySpread");
      }
      if (plan.spacingAfter.slotStreak3 > baseline.spacingAfter.slotStreak3) {
        regressed.push("streak3");
      }
      if (
        plan.spacingAfter.slotConsecutive >
        baseline.spacingAfter.slotConsecutive
      ) {
        regressed.push("consecutive");
      }
      expect(plan.worseThan).toEqual(regressed);
    }
  });

  it("reports scorecards that match the schedule it would write", () => {
    for (const plan of plans) {
      const after = applyPlan(nights, plan);
      const games = after.map((n) => n.games);
      expect(plan.slotSpreadAfter).toBe(iceTimeSpread(T, games));
      expect(plan.homeAwaySpreadAfter).toBe(homeAwaySpread(T, games.flat()));
    }
  });

  it("splits new-opponent nights from same-opponent ones", () => {
    for (const plan of plans) {
      const nightsChanged = plan.changes
        .map((c) => c.night)
        .sort((a, b) => a - b);
      const split = [...plan.matchupNights, ...plan.sameOpponentNights].sort(
        (a, b) => a - b,
      );
      expect(split).toEqual(nightsChanged);
      for (const c of plan.changes) {
        expect(plan.matchupNights.includes(c.night)).toBe(c.matchupChanged);
      }
      // Same opponents means the same pairs as a set, not "ice time only": orientation can
      // flip home/away on a night whose matchups it never touched.
      const key = (ps: [number, number][]) =>
        ps
          .map((g) => [...g].sort().join("-"))
          .sort()
          .join(",");
      for (const n of plan.sameOpponentNights) {
        const c = plan.changes.find((x) => x.night === n)!;
        expect(key(c.to)).toBe(key(c.from));
      }
    }
  });

  it("returns no two plans with the same edit", () => {
    const sigs = plans.map((p) =>
      p.changes
        .map((c) => `${c.night}:${c.to.map((g) => g.join(">")).join("|")}`)
        .join(";"),
    );
    expect(new Set(sigs).size).toBe(sigs.length);
  });

  it("does nothing when the two teams already meet that night", () => {
    const n = nights.findIndex((x, i) => i > 5 && !x.locked);
    const already = nights[n].games[0];
    const res = planOneOff({
      teamCount: T,
      nights,
      oneOffNight: n,
      forcedPairs: [already],
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.relabelOnly).toBe(true);
    expect(res.plans[0].changes).toEqual([]);
    expect(res.plans[0].drift).toEqual([]);
  });
});

describe("planOneOff preconditions", () => {
  const nights: OneOffNight[] = [
    {
      date: "2026-09-01",
      games: [
        [0, 1],
        [2, 3],
      ],
      locked: false,
    },
    {
      date: "2026-09-03",
      games: [
        [0, 2],
        [1, 3],
      ],
      locked: false,
    },
  ];

  const reject = (o: Partial<Parameters<typeof planOneOff>[0]>) => {
    const res = planOneOff({
      teamCount: 4,
      nights,
      oneOffNight: 0,
      forcedPairs: [[0, 2]],
      ...o,
    });
    expect(res.ok).toBe(false);
    return res.ok ? "" : res.reason;
  };

  it("rejects a team playing twice on one night", () => {
    expect(
      reject({
        nights: [
          {
            date: "2026-09-01",
            games: [
              [0, 1],
              [0, 2],
            ],
            locked: false,
          },
        ],
      }),
    ).toMatch(/twice/);
  });

  it("rejects a locked night", () => {
    expect(
      reject({ nights: nights.map((n) => ({ ...n, locked: true })) }),
    ).toMatch(/already been played/);
  });

  it("rejects a team that isn't scheduled that night", () => {
    expect(
      reject({
        nights: [{ date: "2026-09-01", games: [[0, 1]], locked: false }],
        forcedPairs: [[0, 2]],
      }),
    ).toMatch(/already scheduled/);
  });

  it("rejects a team appearing in two of the forced games", () => {
    expect(
      reject({
        forcedPairs: [
          [0, 2],
          [0, 3],
        ],
      }),
    ).toMatch(/two of these games/);
  });
});

describe("checkOneOffWrite", () => {
  const teamIds = ["A", "B", "C", "D"];
  const base = (): CheckWriteOptions => ({
    teamIds,
    date: "2027-01-07",
    forcedPairs: [["A", "C"]],
    nights: [
      {
        date: "2027-01-05",
        locked: false,
        games: [
          ["A", "B"],
          ["C", "D"],
        ],
        gameIds: ["n5-0", "n5-1"],
      },
      {
        date: "2027-01-07",
        locked: false,
        games: [
          ["A", "D"],
          ["B", "C"],
        ],
        gameIds: ["n7-0", "n7-1"],
      },
    ],
    // Force A–C onto the 7th, leaving B and D to each other; swap the 5th to
    // give back the A–B and C–D meetings that displaces.
    changes: [
      {
        date: "2027-01-07",
        to: [
          [0, 2],
          [1, 3],
        ],
        gameIds: ["n7-0", "n7-1"],
      },
      {
        date: "2027-01-05",
        to: [
          [0, 3],
          [1, 2],
        ],
        gameIds: ["n5-0", "n5-1"],
      },
    ],
  });

  it("accepts a plan that keeps the same teams on each night", () => {
    expect(checkOneOffWrite(base())).toBeNull();
  });

  it("accepts a relabel — no changes at all — when the pair already meets", () => {
    expect(
      checkOneOffWrite({
        ...base(),
        forcedPairs: [["A", "D"]],
        changes: [],
      }),
    ).toBeNull();
  });

  it("rejects a date that isn't a game night", () => {
    expect(checkOneOffWrite({ ...base(), date: "2027-02-02" })).toMatch(
      /isn't a game night/,
    );
  });

  it("rejects a locked one-off night even when no changes touch it", () => {
    // The relabel path: without an unconditional check this reaches the write
    // with the night's lock state never examined.
    const o = base();
    o.nights[1].locked = true;
    expect(
      checkOneOffWrite({ ...o, forcedPairs: [["A", "D"]], changes: [] }),
    ).toMatch(/already been played/);
  });

  it("rejects changing a locked night", () => {
    const o = base();
    o.nights[0].locked = true;
    expect(checkOneOffWrite(o)).toMatch(/already been played/);
  });

  it("rejects a night listed twice", () => {
    const o = base();
    o.changes.push({
      date: "2027-01-05",
      gameIds: ["n5-0", "n5-1"],
      to: [
        [0, 1],
        [2, 3],
      ],
    });
    expect(checkOneOffWrite(o)).toMatch(/lists a night twice/);
  });

  it("rejects a night whose game count no longer matches", () => {
    const o = base();
    o.changes[0].to = [[0, 2]];
    expect(checkOneOffWrite(o)).toMatch(/schedule changed/);
  });

  /** ⛔ The positional hazard: a reschedule between preview and apply reorders a night while
   *  every other check passes, and only the previewed game ids can see it. */
  it("rejects a night whose games have been re-timed since the preview", () => {
    const o = base();
    o.changes[0].gameIds = ["n7-1", "n7-0"]; // the same two games, re-ordered
    expect(checkOneOffWrite(o)).toMatch(/re-timed/);
  });

  it("rejects a night whose games are no longer the ones previewed", () => {
    const o = base();
    o.changes[0].gameIds = ["n7-0", "someone-elses-game"];
    expect(checkOneOffWrite(o)).toMatch(/re-timed/);
  });

  it("accepts a plan whose game ids still match, in order", () => {
    const o = base();
    o.changes[0].gameIds = ["n7-0", "n7-1"];
    expect(checkOneOffWrite(o)).toBeNull();
  });

  it("rejects an out-of-range team index", () => {
    const o = base();
    o.changes[0].to = [
      [0, 9],
      [1, 3],
    ];
    expect(checkOneOffWrite(o)).toMatch(/isn't a valid set of games/);
  });

  it("rejects a team playing itself", () => {
    const o = base();
    o.changes[0].to = [
      [0, 0],
      [1, 3],
    ];
    expect(checkOneOffWrite(o)).toMatch(/isn't a valid set of games/);
  });

  it("rejects a team playing twice in a night", () => {
    const o = base();
    o.changes[0].to = [
      [0, 2],
      [0, 3],
    ];
    expect(checkOneOffWrite(o)).toMatch(/twice in a night/);
  });

  it("rejects swapping in a team who wasn't playing that night", () => {
    // The check that carries the invariant: the 5th runs one game, so C for B would hand C a
    // game and take one off B.
    const o = base();
    o.nights[0].games = [["A", "B"]];
    // Shrink the ids too, or the identity check fires first and this tests nothing.
    o.nights[0].gameIds = ["n5-0"];
    o.changes[1] = {
      date: "2027-01-05",
      to: [[0, 2]],
      gameIds: ["n5-0"],
    };
    expect(checkOneOffWrite(o)).toMatch(/changes who plays that night/);
    // The same night left alone is fine.
    o.changes[1] = {
      date: "2027-01-05",
      to: [[1, 0]],
      gameIds: ["n5-0"],
    };
    expect(checkOneOffWrite(o)).toBeNull();
  });

  it("rejects a plan that drops the game being scheduled", () => {
    const o = base();
    o.changes[0].to = [
      [0, 3],
      [1, 2],
    ]; // back to the original pairing, no A–C
    expect(checkOneOffWrite(o)).toMatch(/doesn't include the game/);
  });

  it("rejects a plan whose one-off night is missing entirely", () => {
    const o = base();
    o.changes = [o.changes[1]];
    expect(checkOneOffWrite(o)).toMatch(/doesn't include the game/);
  });

  it("rejects an unenrolled team elsewhere on the one-off night", () => {
    const o = base();
    o.nights[1].games[1] = ["E", "B"];
    expect(
      checkOneOffWrite({ ...o, forcedPairs: [["A", "D"]], changes: [] }),
    ).toMatch(/isn't enrolled/);
  });
});

describe("buildOneOffRows", () => {
  // The 5th already hosted the semifinals, so a prior round's labels sit on real rows.
  const teamIds = ["A", "B", "C", "D"]; // A=0, B=1, C=2, D=3
  const at = (date: string, time: string) => `${date}T${time}:00-05:00`;

  const base = (): BuildRowsOptions => ({
    teamIds,
    date: "2027-01-07",
    round: "final",
    label: "Championship",
    forcedPairs: [["A", "C"]],
    nights: [
      {
        date: "2027-01-05",
        games: [
          {
            id: "g1",
            homeTeamId: "A",
            awayTeamId: "B",
            scheduledAt: at("2027-01-05", "19:00"),
            label: "Semifinal 1",
          },
          {
            id: "g2",
            homeTeamId: "C",
            awayTeamId: "D",
            scheduledAt: at("2027-01-05", "20:15"),
            label: "Semifinal 2",
          },
        ],
      },
      {
        date: "2027-01-07",
        games: [
          {
            id: "g3",
            homeTeamId: "A",
            awayTeamId: "D",
            scheduledAt: at("2027-01-07", "19:00"),
            label: null,
          },
          {
            id: "g4",
            homeTeamId: "B",
            awayTeamId: "C",
            scheduledAt: at("2027-01-07", "20:15"),
            label: null,
          },
        ],
      },
    ],
    // A–C onto the 7th, leaving B and D to each other.
    changes: [
      {
        date: "2027-01-07",
        to: [
          [0, 2],
          [1, 3],
        ],
      },
    ],
  });

  const byId = (rows: OneOffRow[]) => new Map(rows.map((r) => [r.id, r]));

  /** ⛔ The label-wipe regression: a repair that swaps two games' ice times must keep both
   *  labels, since labels follow the matchup, not the row. */
  it("keeps a night's labels when a repair only swaps their ice times", () => {
    const o = base();
    // The repair path (no one-off) over the 5th: the same two matchups, opposite ice times.
    o.date = null;
    o.forcedPairs = [];
    o.changes = [
      {
        date: "2027-01-05",
        to: [
          [2, 3],
          [0, 1],
        ],
      },
    ];
    const rows = byId(buildOneOffRows(o));
    // g1 (19:00) now hosts C–D, which carried "Semifinal 2"; g2 hosts A–B,
    // which carried "Semifinal 1". Both labels moved with their matchup.
    expect(rows.get("g1")?.label).toBe("Semifinal 2");
    expect(rows.get("g2")?.label).toBe("Semifinal 1");
  });

  it("still clears a label whose matchup left the night entirely", () => {
    const o = base();
    o.date = null;
    o.forcedPairs = [];
    // The 7th's games re-paired; neither new pair was on that night before, and
    // neither carried a label, so nothing is invented.
    const rows = byId(buildOneOffRows(o));
    expect(rows.get("g3")?.label).toBeNull();
    expect(rows.get("g4")?.label).toBeNull();
  });

  it("rewrites a night's games in place, keeping each row's ice time", () => {
    const rows = buildOneOffRows(base());
    // `toMatchObject`: rows also carry `prev*`, asserted on their own below.
    expect(rows).toMatchObject([
      {
        id: "g3",
        homeTeamId: "A",
        awayTeamId: "C",
        label: "Championship",
        scheduledAt: at("2027-01-07", "19:00"),
      },
      {
        id: "g4",
        homeTeamId: "B",
        awayTeamId: "D",
        label: null,
        scheduledAt: at("2027-01-07", "20:15"),
      },
    ]);
  });

  /** ⛔ `prev*` is what each row held: the write sends it as `prev`, refusing a row changed
   *  since the plan. Never an upsert, which would resurrect a deleted game. */
  it("carries what each row held before, for the undo", () => {
    const rows = buildOneOffRows(base());
    const g3 = rows.find((r) => r.id === "g3")!;
    expect(g3.prevHomeTeamId).toBe("A");
    expect(g3.prevAwayTeamId).toBe("D");
    expect(g3.prevLabel).toBeNull();
  });

  it("takes the i-th planned game onto the i-th ice time", () => {
    const o = base();
    // The same two games, ordered the other way round.
    o.changes = [
      {
        date: "2027-01-07",
        to: [
          [1, 3],
          [0, 2],
        ],
      },
    ];
    const rows = byId(buildOneOffRows(o));
    expect(rows.get("g3")).toMatchObject({ homeTeamId: "B", awayTeamId: "D" });
    expect(rows.get("g4")).toMatchObject({ homeTeamId: "A", awayTeamId: "C" });
  });

  it("clears the label of a game whose matchup changed", () => {
    const o = base();
    o.nights[1].games[1].label = "Consolation";
    o.changes = [
      {
        date: "2027-01-07",
        to: [
          [0, 2],
          [1, 3],
        ],
      },
      {
        date: "2027-01-05",
        to: [
          [0, 3],
          [1, 2],
        ],
      },
    ];
    const rows = byId(buildOneOffRows(o));
    expect(rows.get("g4")?.label).toBeNull(); // B–C became B–D
    expect(rows.get("g1")?.label).toBeNull(); // A–B became A–D
    expect(rows.get("g2")?.label).toBeNull(); // C–D became B–C
  });

  it("keeps a label when only home and away swap", () => {
    const o = base();
    o.changes.push({
      date: "2027-01-05",
      to: [
        [1, 0],
        [2, 3],
      ],
    });
    const rows = byId(buildOneOffRows(o));
    expect(rows.get("g1")).toMatchObject({
      homeTeamId: "B",
      awayTeamId: "A",
      label: "Semifinal 1",
    });
  });

  it("writes no row for a game the plan leaves exactly as it was", () => {
    const o = base();
    o.changes.push({
      date: "2027-01-05",
      to: [
        [1, 0],
        [2, 3],
      ],
    });
    // C–D on the 5th is untouched, home side and all.
    expect(byId(buildOneOffRows(o)).has("g2")).toBe(false);
  });

  it("labels only the one-off night, never a matching pair elsewhere", () => {
    const o = base();
    o.forcedPairs = [["A", "B"]];
    o.changes = [
      {
        date: "2027-01-07",
        to: [
          [0, 1],
          [2, 3],
        ],
      },
      // A and B still meet on the 5th, with the sides swapped.
      {
        date: "2027-01-05",
        to: [
          [1, 0],
          [2, 3],
        ],
      },
    ];
    const rows = byId(buildOneOffRows(o));
    expect(rows.get("g3")?.label).toBe("Championship");
    expect(rows.get("g1")?.label).toBe("Semifinal 1");
  });

  it("numbers semifinals in the order the games were given", () => {
    const o = base();
    o.round = "semifinals";
    o.label = "";
    o.forcedPairs = [
      ["B", "D"],
      ["A", "C"],
    ];
    const rows = byId(buildOneOffRows(o));
    expect(rows.get("g4")?.label).toBe("Semifinal 1"); // B–D, given first
    expect(rows.get("g3")?.label).toBe("Semifinal 2"); // A–C, given second
  });

  it("falls back to Final when no label was typed", () => {
    const o = base();
    o.label = "   ";
    expect(byId(buildOneOffRows(o)).get("g3")?.label).toBe("Final");
  });

  it("labels the existing row when the pair already meets that night", () => {
    // The relabel path: the plan carries no changes at all.
    const o = base();
    o.forcedPairs = [["A", "D"]];
    o.changes = [];
    const rows = buildOneOffRows(o);
    expect(rows).toMatchObject([
      {
        id: "g3",
        homeTeamId: "A",
        awayTeamId: "D",
        label: "Championship",
        scheduledAt: at("2027-01-07", "19:00"),
      },
    ]);
  });

  it("leaves another round's labels alone on a shared night", () => {
    // Six teams over three ice times: the semifinals and the final can land on
    // the same night, and scheduling the final must not erase the semifinals.
    const rows = byId(
      buildOneOffRows({
        teamIds: ["A", "B", "C", "D", "E", "F"],
        date: "2027-02-04",
        round: "final",
        label: "Championship",
        forcedPairs: [["E", "F"]],
        changes: [],
        nights: [
          {
            date: "2027-02-04",
            games: [
              {
                id: "s1",
                homeTeamId: "A",
                awayTeamId: "B",
                scheduledAt: at("2027-02-04", "19:00"),
                label: "Semifinal 1",
              },
              {
                id: "s2",
                homeTeamId: "C",
                awayTeamId: "D",
                scheduledAt: at("2027-02-04", "20:15"),
                label: "Semifinal 2",
              },
              {
                id: "f1",
                homeTeamId: "E",
                awayTeamId: "F",
                scheduledAt: at("2027-02-04", "21:30"),
                label: null,
              },
            ],
          },
        ],
      }),
    );
    expect(rows.get("f1")?.label).toBe("Championship");
    expect(rows.has("s1")).toBe(false); // untouched, so not written at all
    expect(rows.has("s2")).toBe(false);
  });

  it("clears a stale semifinal but keeps a final when semifinals re-run", () => {
    // The same rule the other way round. Both labels sit on games this run
    // isn't labelling, so the round's ownership is what decides each one.
    const rows = byId(
      buildOneOffRows({
        teamIds: ["A", "B", "C", "D", "E", "F", "G", "H"],
        date: "2027-02-04",
        round: "semifinals",
        label: "",
        forcedPairs: [
          ["E", "F"],
          ["G", "H"],
        ],
        changes: [],
        nights: [
          {
            date: "2027-02-04",
            games: [
              {
                id: "x1",
                homeTeamId: "A",
                awayTeamId: "B",
                scheduledAt: at("2027-02-04", "18:00"),
                label: "Semifinal 1",
              },
              {
                id: "x2",
                homeTeamId: "C",
                awayTeamId: "D",
                scheduledAt: at("2027-02-04", "19:00"),
                label: "Championship",
              },
              {
                id: "x3",
                homeTeamId: "E",
                awayTeamId: "F",
                scheduledAt: at("2027-02-04", "20:15"),
                label: null,
              },
              {
                id: "x4",
                homeTeamId: "G",
                awayTeamId: "H",
                scheduledAt: at("2027-02-04", "21:30"),
                label: null,
              },
            ],
          },
        ],
      }),
    );
    expect(rows.get("x3")?.label).toBe("Semifinal 1");
    expect(rows.get("x4")?.label).toBe("Semifinal 2");
    expect(rows.get("x1")?.label).toBeNull(); // stale semifinal, this round's
    expect(rows.has("x2")).toBe(false); // the final's label is not
  });

  it("clears a stale label left on the one-off night by an earlier run", () => {
    // The final was scheduled here once already, then moved to the other game
    // on the same night. Two games labelled "Championship" is not a schedule.
    const o = base();
    o.nights[1].games[0].label = "Championship";
    o.forcedPairs = [["B", "C"]];
    o.changes = [];
    const rows = byId(buildOneOffRows(o));
    expect(rows.get("g4")?.label).toBe("Championship");
    expect(rows.get("g3")?.label).toBeNull();
  });
});

/** ⛔ These drive the one-off planner's engine, never `generateSchedule`: repair must keep
 *  working after `season_is_started` shuts generate, applying an in-place UPDATE by id. */
describe("planRepair", () => {
  const base = season({ teams: 8, weeks: 8, gamesPerTeam: 12 });
  // Half the season played, as it would be mid-season.
  const nights = base.nights.map((n, i) => ({ ...n, locked: i < 6 }));
  const T = base.teamCount;

  /** An unlocked night, a team playing on it, and a team sitting it out. */
  const openNight = 6;
  const playing = [...new Set(nights[openNight].games.flat())];
  const bye = Array.from({ length: T }, (_, t) => t).find(
    (t) => !playing.includes(t),
  )!;

  it("has a fixture with both a player and a bye on the pinned night", () => {
    // Two of eight sit out; if that stops being true, the unmet test below tests nothing.
    expect(playing.length).toBeGreaterThan(0);
    expect(bye).toBeGreaterThanOrEqual(0);
  });

  it("accepts a play_on pin for a team already on that night", () => {
    const res = planRepair({
      teamCount: T,
      nights,
      pin: { kind: "play_on", team: playing[0], night: openNight },
    });
    if (!res.ok) throw new Error(res.reason);
    expect(res.unmet).toBeNull();
  });

  /** ⚠️ A satisfiable `play_on` is already met by definition (repair can't add a team), and the
   *  page must say so rather than imply the pin produced the plans. */
  it("reports a satisfiable play_on pin as already met", () => {
    const res = planRepair({
      teamCount: T,
      nights,
      pin: { kind: "play_on", team: playing[0], night: openNight },
    });
    if (!res.ok) throw new Error(res.reason);
    expect(res.pinAlreadyMet).toBe(true);
  });

  it("reports a slot_on pin as already met when the game is on that ice time", () => {
    const team = playing[0];
    const current = nights[openNight].games.findIndex((g) => g.includes(team));
    const res = planRepair({
      teamCount: T,
      nights,
      pin: { kind: "slot_on", team, night: openNight, slot: current },
    });
    if (!res.ok) throw new Error(res.reason);
    expect(res.pinAlreadyMet).toBe(true);
    expect(res.unmet).toBeNull();
  });

  /** ⛔ The pin is checked, not assumed: an unlocatable game drops it quietly while `unmet`
   *  says null, so every returned plan must put the team on the requested slot. */
  it("returns only plans that actually honour a slot_on pin", () => {
    const team = playing[0];
    const slots = nights[openNight].games.length;
    const currently = nights[openNight].games.findIndex((g) =>
      g.includes(team),
    );
    const wanted = (currently + 1) % slots;
    const res = planRepair({
      teamCount: T,
      nights,
      pin: { kind: "slot_on", team, night: openNight, slot: wanted },
    });
    if (!res.ok) throw new Error(res.reason);
    if (res.unmet) {
      // A legitimate outcome, and then it must be honest: no plans that ignore the pin.
      expect(res.plans).toEqual([]);
      return;
    }
    expect(res.plans.length).toBeGreaterThan(0);
    for (const plan of res.plans) {
      const after = applyPlan(nights, plan);
      expect(after[openNight].games.findIndex((g) => g.includes(team))).toBe(
        wanted,
      );
    }
  });

  /** ⛔ The likeliest misreading: "X needs to play that night" doesn't add X, since that
   *  changes byes; the honest answer is to say so. */
  it("reports a play_on pin unmet, with a reason, when the team byes that night", () => {
    const res = planRepair({
      teamCount: T,
      nights,
      pin: { kind: "play_on", team: bye, night: openNight },
    });
    if (!res.ok) throw new Error(res.reason);
    expect(res.unmet).toBeTruthy();
    expect(res.unmet).toMatch(/bye/i);
    // And it offers nothing that pretends otherwise.
    expect(res.plans).toEqual([]);
  });

  it("puts a slot_on pin's game on the ice time it asked for", () => {
    const team = playing[0];
    const slots = nights[openNight].games.length;
    const currently = nights[openNight].games.findIndex((g) =>
      g.includes(team),
    );
    const wanted = (currently + 1) % slots;
    const res = planRepair({
      teamCount: T,
      nights,
      pin: { kind: "slot_on", team, night: openNight, slot: wanted },
    });
    if (!res.ok) throw new Error(res.reason);
    expect(res.unmet).toBeNull();
    expect(res.plans.length).toBeGreaterThan(0);
    for (const plan of res.plans) {
      const after = applyPlan(nights, plan);
      const landed = after[openNight].games.findIndex((g) => g.includes(team));
      expect(landed).toBe(wanted);
    }
  });

  it("refuses a slot_on pin for a team that byes that night, with a reason", () => {
    const res = planRepair({
      teamCount: T,
      nights,
      pin: { kind: "slot_on", team: bye, night: openNight, slot: 0 },
    });
    if (!res.ok) throw new Error(res.reason);
    expect(res.unmet).toMatch(/bye/i);
  });

  it("refuses an ice time that night does not run", () => {
    const res = planRepair({
      teamCount: T,
      nights,
      pin: {
        kind: "slot_on",
        team: playing[0],
        night: openNight,
        slot: nights[openNight].games.length,
      },
    });
    if (!res.ok) throw new Error(res.reason);
    expect(res.unmet).toBeTruthy();
  });

  /** ⛔ The invariant every plan on this path has to keep. */
  it("never moves games played, byes, or weekday counts", () => {
    const res = planRepair({ teamCount: T, nights, pin: null });
    if (!res.ok) throw new Error(res.reason);
    const before = invariants(T, nights);
    for (const plan of res.plans) {
      expect(invariants(T, applyPlan(nights, plan))).toEqual(before);
    }
  });

  it("never touches a locked night", () => {
    const res = planRepair({ teamCount: T, nights, pin: null });
    if (!res.ok) throw new Error(res.reason);
    for (const plan of res.plans) {
      for (const c of plan.changes) expect(nights[c.night].locked).toBe(false);
    }
  });

  /** ⚠️ Item 4 must be able to say "nothing to improve": hand-built so there is structurally
   *  nothing to change, since a generated season's "found nothing" is a timing claim. */
  it("says there is nothing to improve when no plan changes anything", () => {
    const res = planRepair({
      teamCount: 4,
      nights: [
        { date: "2026-09-01", games: [[0, 1]], locked: true },
        { date: "2026-09-03", games: [[2, 3]], locked: true },
        { date: "2026-09-08", games: [[1, 0]], locked: false },
      ],
      pin: null,
    });
    if (!res.ok) throw new Error(res.reason);
    expect(res.nothingToImprove).toBe(true);
    expect(res.plans).toEqual([]);
  });

  it("refuses a repair on a season with every night played", () => {
    const res = planRepair({
      teamCount: T,
      nights: nights.map((n) => ({ ...n, locked: true })),
      pin: null,
    });
    // ⛔ Not "nothing to improve": nothing is allowed to move, which is a different sentence.
    expect(res.ok).toBe(false);
  });

  /** ⛔ Id stability: a plan writes only rows that already exist, since a regenerate's new ids
   *  replace every subscriber's calendar events. The e2e checks the real id set. */
  it("writes only rows that already exist, keeping every ice time", () => {
    const res = planRepair({ teamCount: T, nights, pin: null });
    if (!res.ok) throw new Error(res.reason);
    const plan = res.plans[0];
    // No repair on this fixture is a legitimate outcome; the branch above owns it.
    if (!plan) return;

    const teamIds = Array.from({ length: T }, (_, i) => `team-${i}`);
    const rowNights = nights.map((n) => ({
      date: n.date,
      games: n.games.map((g, i) => ({
        id: `${n.date}-${i}`,
        homeTeamId: teamIds[g[0]],
        awayTeamId: teamIds[g[1]],
        scheduledAt: `${n.date}T23:0${i}:00Z`,
        label: null,
      })),
    }));
    const existing = new Set(
      rowNights.flatMap((n) => n.games.map((g) => g.id)),
    );

    const rows = buildOneOffRows({
      nights: rowNights,
      teamIds,
      date: null,
      round: "final",
      label: "",
      forcedPairs: [],
      changes: plan.changes.map((c) => ({
        date: nights[c.night].date,
        to: c.to,
      })),
    });
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) {
      expect(existing.has(r.id)).toBe(true);
      // The times are the night's, never the game's, so a repair cannot move a
      // game onto an ice time the night does not already run.
      expect(r.scheduledAt).toBeTruthy();
    }
  });

  it("passes the write check it will be applied through", () => {
    const res = planRepair({ teamCount: T, nights, pin: null });
    if (!res.ok) throw new Error(res.reason);
    const plan = res.plans[0];
    if (!plan) return;
    const teamIds = Array.from({ length: T }, (_, i) => `team-${i}`);
    expect(
      checkOneOffWrite({
        nights: nights.map((n) => ({
          date: n.date,
          locked: n.locked,
          games: n.games.map(
            (g) => [teamIds[g[0]], teamIds[g[1]]] as [string, string],
          ),
          gameIds: n.games.map((_, i) => `${n.date}-${i}`),
        })),
        teamIds,
        date: null,
        forcedPairs: [],
        changes: plan.changes.map((c) => ({
          date: nights[c.night].date,
          to: c.to,
          gameIds: nights[c.night].games.map(
            (_, i) => `${nights[c.night].date}-${i}`,
          ),
        })),
      }),
    ).toBeNull();
  });
});
