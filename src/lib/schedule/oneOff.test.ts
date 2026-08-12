import { describe, it, expect } from "vitest";
import { buildBalancedPairings } from "./roundRobin";
import { assignNights, type Night } from "./assignNights";
import { weekdayOf } from "@/lib/format";
import {
  planOneOff,
  checkOneOffWrite,
  buildOneOffRows,
  iceTimeSpread,
  type BuildRowsOptions,
  type CheckWriteOptions,
  type OneOffNight,
  type OneOffPlan,
  type OneOffRow,
} from "./oneOff";
import { homeAwaySpread } from "./homeAway";

const SLOTS = ["19:00", "20:15", "21:30"];

/** Two recurring weeknights (Tue + Thu) for `weeks` weeks, chronological. */
function twoNightsPerWeek(weeks: number): Night[] {
  const ns: Night[] = [];
  const base = Date.UTC(2026, 8, 1); // 2026-09-01
  for (let w = 0; w < weeks; w++) {
    for (const off of [0, 2]) {
      const d = new Date(base + (w * 7 + off) * 86400000);
      ns.push({ date: d.toISOString().slice(0, 10), slots: SLOTS });
    }
  }
  return ns;
}

/**
 * A real generated season, converted to the planner's index-based shape. Eight
 * teams over three ice times means six of eight play each night — the reference
 * shape from SCHEDULE_HANDOFF.md, where byes are what make the problem hard.
 */
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
    nights.push({ date: cal[n].date, games: row.map((r) => r.pair), locked: false });
  }
  return { nights, teamCount: opts.teams };
}

/** The state a plan produces, in the planner's own input shape. */
function applyPlan(nights: OneOffNight[], plan: OneOffPlan): OneOffNight[] {
  const out = nights.map((n) => ({ ...n, games: n.games.map((g) => [...g] as [number, number]) }));
  for (const c of plan.changes) out[c.night].games = c.to.map((g) => [...g] as [number, number]);
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

/**
 * A night both teams play but where they don't already meet. `accept` narrows it
 * further — the repair tests need a target whose exact repair is reachable, and
 * which of them is depends on the generated fixture.
 */
function pickTarget(
  nights: OneOffNight[],
  from: number,
  accept: (t: Target) => boolean = () => true,
): Target {
  for (let n = from; n < nights.length; n++) {
    const playing = [...new Set(nights[n].games.flat())];
    const meeting = new Set(nights[n].games.map((g) => [...g].sort().join("-")));
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
      const keys = after[target.night].games.map((g) => [...g].sort().join("-"));
      expect(keys).toContain(want);
    }
  });

  it("leaves opponent balance off target if nothing is repaired", () => {
    const baseline = plans.find((p) => p.id === "no-repair")!;
    expect(baseline.drift.length).toBeGreaterThan(0);
    expect(baseline.changes.every((c) => c.night === target.night)).toBe(true);
  });

  /**
   * ⚠️ Exact repair is a property of the *instance*, not an invariant, and this
   * fixture's target is picked by scanning the generated season — so which
   * instance it lands on moves whenever the generator does.
   *
   * Measured over all twelve pairs forceable onto this fixture's night 6: nine
   * repair exactly and three cannot, and raising the repair's own effort 25×
   * (300 restarts, 12 s) does not move them — so those three are the shape
   * `drift` documents, "pairs still off target if exact repair was unreachable".
   * Asserting exact repair for whichever pair the scan happens to return would
   * be asserting that luck, which is how this test read before.
   */
  // Finding a repairable target means planning each candidate until one lands,
  // and a plan is a full Phase M + Phase S run — seconds, not milliseconds.
  it("restores opponent balance where exact repair is reachable", { timeout: 60_000 }, () => {
    const repairable = pickTarget(nights, 6, (t) => {
      const r = planOneOff({
        teamCount: T,
        nights,
        oneOffNight: t.night,
        forcedPairs: [t.pair],
      });
      return r.ok && r.plans.some((p) => p.id !== "no-repair" && p.drift.length === 0);
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
  });

  it("never leaves opponent balance worse than leaving the season alone", () => {
    // The invariant that does hold everywhere: meeting counts are weighted far
    // above churn, so a repair may fail to close the gap but must never widen
    // it. This is what catches a weight that lets something outrank balance.
    const baseline = plans.find((p) => p.id === "no-repair")!;
    const off = (p: OneOffPlan) => p.drift.reduce((s, d) => s + Math.abs(d.delta), 0);
    const repairs = plans.filter((p) => p.id !== "no-repair");
    expect(repairs.length).toBeGreaterThan(0);
    for (const plan of repairs) expect(off(plan)).toBeLessThanOrEqual(off(baseline));
  });

  it("never leaves home/away worse than it found it", () => {
    for (const plan of plans.filter((p) => p.id !== "no-repair")) {
      expect(plan.homeAwaySpreadAfter).toBeLessThanOrEqual(
        plan.homeAwaySpreadBefore,
      );
    }
  });

  it("repairs ice-time share far better than doing nothing", () => {
    // Not a guarantee that it returns to the pre-edit value: the new matchups
    // decide which teams share a slot, so a perfect split may stop being
    // reachable. What it must do is beat leaving the season alone.
    const baseline = plans.find((p) => p.id === "no-repair")!;
    for (const plan of plans.filter((p) => p.id !== "no-repair")) {
      expect(plan.slotSpreadAfter).toBeLessThan(baseline.slotSpreadAfter);
    }
  });

  it("gets ice-time share all the way back when the feature slot is free", () => {
    // Holding the labelled game on the last ice time costs those two teams a
    // slot they'd otherwise have spread — the reason it's a choice, not a rule.
    const res = planOneOff({
      teamCount: T,
      nights,
      oneOffNight: target.night,
      forcedPairs: [target.pair],
      featureSlot: false,
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const best = Math.min(
      ...res.plans.filter((p) => p.id !== "no-repair").map((p) => p.slotSpreadAfter),
    );
    expect(best).toBe(0);
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
      const nightsChanged = plan.changes.map((c) => c.night).sort((a, b) => a - b);
      const split = [...plan.matchupNights, ...plan.sameOpponentNights].sort(
        (a, b) => a - b,
      );
      expect(split).toEqual(nightsChanged);
      for (const c of plan.changes) {
        expect(plan.matchupNights.includes(c.night)).toBe(c.matchupChanged);
      }
      // A same-opponent night means exactly that and no more: the pairs are
      // identical as a set. It does *not* mean only the ice time moved — the
      // orientation pass can flip home/away on a night whose matchups it never
      // touched, so describing these as "ice time only" would be a lie.
      const key = (ps: [number, number][]) =>
        ps.map((g) => [...g].sort().join("-")).sort().join(",");
      for (const n of plan.sameOpponentNights) {
        const c = plan.changes.find((x) => x.night === n)!;
        expect(key(c.to)).toBe(key(c.from));
      }
    }
  });

  it("returns no two plans with the same edit", () => {
    const sigs = plans.map((p) =>
      p.changes.map((c) => `${c.night}:${c.to.map((g) => g.join(">")).join("|")}`).join(";"),
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
    { date: "2026-09-01", games: [[0, 1], [2, 3]], locked: false },
    { date: "2026-09-03", games: [[0, 2], [1, 3]], locked: false },
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
          { date: "2026-09-01", games: [[0, 1], [0, 2]], locked: false },
        ],
      }),
    ).toMatch(/twice/);
  });

  it("rejects a locked night", () => {
    expect(reject({ nights: nights.map((n) => ({ ...n, locked: true })) })).toMatch(
      /already been played/,
    );
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
  // Four teams, two ice times, two nights. Small enough to reason about by
  // hand, big enough that a wrong permutation is a real one.
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
      },
      {
        date: "2027-01-07",
        locked: false,
        games: [
          ["A", "D"],
          ["B", "C"],
        ],
      },
    ],
    // Force A–C onto the 7th, leaving B and D to each other; swap the 5th to
    // give back the A–B and C–D meetings that displaces.
    changes: [
      { date: "2027-01-07", to: [[0, 2], [1, 3]] },
      { date: "2027-01-05", to: [[0, 3], [1, 2]] },
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
    o.changes.push({ date: "2027-01-05", to: [[0, 1], [2, 3]] });
    expect(checkOneOffWrite(o)).toMatch(/lists a night twice/);
  });

  it("rejects a night whose game count no longer matches", () => {
    const o = base();
    o.changes[0].to = [[0, 2]];
    expect(checkOneOffWrite(o)).toMatch(/schedule changed/);
  });

  it("rejects an out-of-range team index", () => {
    const o = base();
    o.changes[0].to = [[0, 9], [1, 3]];
    expect(checkOneOffWrite(o)).toMatch(/isn't a valid set of games/);
  });

  it("rejects a team playing itself", () => {
    const o = base();
    o.changes[0].to = [[0, 0], [1, 3]];
    expect(checkOneOffWrite(o)).toMatch(/isn't a valid set of games/);
  });

  it("rejects a team playing twice in a night", () => {
    const o = base();
    o.changes[0].to = [[0, 2], [0, 3]];
    expect(checkOneOffWrite(o)).toMatch(/twice in a night/);
  });

  it("rejects swapping in a team who wasn't playing that night", () => {
    // The check that carries the invariant. Needs a night someone sits out, so
    // give the 5th a single game and leave C and D on a bye; substituting C for
    // B would hand C a game and take one off B.
    const o = base();
    o.nights[0].games = [["A", "B"]];
    o.changes[1] = { date: "2027-01-05", to: [[0, 2]] };
    expect(checkOneOffWrite(o)).toMatch(/changes who plays that night/);
    // The same night left alone is fine.
    o.changes[1] = { date: "2027-01-05", to: [[1, 0]] };
    expect(checkOneOffWrite(o)).toBeNull();
  });

  it("rejects a plan that drops the game being scheduled", () => {
    const o = base();
    o.changes[0].to = [[0, 3], [1, 2]]; // back to the original pairing, no A–C
    expect(checkOneOffWrite(o)).toMatch(/doesn't include the game/);
  });

  it("rejects a plan whose one-off night is missing entirely", () => {
    const o = base();
    o.changes = [o.changes[1]];
    expect(checkOneOffWrite(o)).toMatch(/doesn't include the game/);
  });

  it("rejects an unenrolled team elsewhere on the one-off night", () => {
    // Unenrolling a team leaves its games scheduled. On the relabel path the
    // row builder maps that night's games back through `teamIds`, and a team
    // with no index there would reach the write as a row with no team on it.
    const o = base();
    o.nights[1].games[1] = ["E", "B"];
    expect(
      checkOneOffWrite({ ...o, forcedPairs: [["A", "D"]], changes: [] }),
    ).toMatch(/isn't enrolled/);
  });
});

describe("buildOneOffRows", () => {
  // Four teams over two ice times, two nights. The 5th already hosted the
  // semifinals, so a prior round's labels are sitting on real rows — which is
  // how a label gets a chance to survive, or to go stale.
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
    changes: [{ date: "2027-01-07", to: [[0, 2], [1, 3]] }],
  });

  const byId = (rows: OneOffRow[]) => new Map(rows.map((r) => [r.id, r]));

  it("rewrites a night's games in place, keeping each row's ice time", () => {
    const rows = buildOneOffRows(base());
    expect(rows).toEqual([
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

  it("takes the i-th planned game onto the i-th ice time", () => {
    const o = base();
    // The same two games, ordered the other way round.
    o.changes = [{ date: "2027-01-07", to: [[1, 3], [0, 2]] }];
    const rows = byId(buildOneOffRows(o));
    expect(rows.get("g3")).toMatchObject({ homeTeamId: "B", awayTeamId: "D" });
    expect(rows.get("g4")).toMatchObject({ homeTeamId: "A", awayTeamId: "C" });
  });

  it("clears the label of a game whose matchup changed", () => {
    const o = base();
    o.nights[1].games[1].label = "Consolation";
    o.changes = [
      { date: "2027-01-07", to: [[0, 2], [1, 3]] },
      { date: "2027-01-05", to: [[0, 3], [1, 2]] },
    ];
    const rows = byId(buildOneOffRows(o));
    expect(rows.get("g4")?.label).toBeNull(); // B–C became B–D
    expect(rows.get("g1")?.label).toBeNull(); // A–B became A–D
    expect(rows.get("g2")?.label).toBeNull(); // C–D became B–C
  });

  it("keeps a label when only home and away swap", () => {
    const o = base();
    o.changes.push({ date: "2027-01-05", to: [[1, 0], [2, 3]] });
    const rows = byId(buildOneOffRows(o));
    expect(rows.get("g1")).toMatchObject({
      homeTeamId: "B",
      awayTeamId: "A",
      label: "Semifinal 1",
    });
  });

  it("writes no row for a game the plan leaves exactly as it was", () => {
    const o = base();
    o.changes.push({ date: "2027-01-05", to: [[1, 0], [2, 3]] });
    // C–D on the 5th is untouched, home side and all.
    expect(byId(buildOneOffRows(o)).has("g2")).toBe(false);
  });

  it("labels only the one-off night, never a matching pair elsewhere", () => {
    const o = base();
    o.forcedPairs = [["A", "B"]];
    o.changes = [
      { date: "2027-01-07", to: [[0, 1], [2, 3]] },
      // A and B still meet on the 5th, with the sides swapped.
      { date: "2027-01-05", to: [[1, 0], [2, 3]] },
    ];
    const rows = byId(buildOneOffRows(o));
    expect(rows.get("g3")?.label).toBe("Championship");
    expect(rows.get("g1")?.label).toBe("Semifinal 1");
  });

  it("numbers semifinals in the order the games were given", () => {
    const o = base();
    o.round = "semifinals";
    o.label = "";
    o.forcedPairs = [["B", "D"], ["A", "C"]];
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
    expect(rows).toEqual([
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
              { id: "s1", homeTeamId: "A", awayTeamId: "B", scheduledAt: at("2027-02-04", "19:00"), label: "Semifinal 1" },
              { id: "s2", homeTeamId: "C", awayTeamId: "D", scheduledAt: at("2027-02-04", "20:15"), label: "Semifinal 2" },
              { id: "f1", homeTeamId: "E", awayTeamId: "F", scheduledAt: at("2027-02-04", "21:30"), label: null },
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
        forcedPairs: [["E", "F"], ["G", "H"]],
        changes: [],
        nights: [
          {
            date: "2027-02-04",
            games: [
              { id: "x1", homeTeamId: "A", awayTeamId: "B", scheduledAt: at("2027-02-04", "18:00"), label: "Semifinal 1" },
              { id: "x2", homeTeamId: "C", awayTeamId: "D", scheduledAt: at("2027-02-04", "19:00"), label: "Championship" },
              { id: "x3", homeTeamId: "E", awayTeamId: "F", scheduledAt: at("2027-02-04", "20:15"), label: null },
              { id: "x4", homeTeamId: "G", awayTeamId: "H", scheduledAt: at("2027-02-04", "21:30"), label: null },
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
