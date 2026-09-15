import { describe, it, expect } from "vitest";
import {
  constraintConflicts,
  evaluateConstraints,
  forcedByeCredits,
  presentSpacing,
  refuteConstraints,
  resolveConstraints,
  FALLBACK_PLANNER_REASON,
  type ScheduleConstraint,
} from "./constraints";
import { assignNights, type Night } from "./assignNights";
import { buildBalancedPairings } from "./roundRobin";
import { buildNightMeta } from "./spacing";
import { eightTeamMonThu, sixTeamTuesdays } from "./calendars.test-support";

const TEAMS = ["a", "b", "c", "d"];
const SLOTS = ["19:00", "20:15"];

/** Four two-night weeks: Mon/Thu from Mon 2026-09-07. */
const NIGHTS: Night[] = [
  "2026-09-07",
  "2026-09-10",
  "2026-09-14",
  "2026-09-17",
  "2026-09-21",
  "2026-09-24",
  "2026-09-28",
  "2026-10-01",
].map((date) => ({ date, slots: SLOTS }));

const c = (
  id: string,
  teamId: string,
  kind: ScheduleConstraint["kind"],
  params: ScheduleConstraint["params"],
): ScheduleConstraint => ({ id, teamId, kind, params });

const resolve = (list: ScheduleConstraint[], nights = NIGHTS) =>
  resolveConstraints(list, { nights, teamIds: TEAMS });

const nameOf = (id: string) => id.toUpperCase();

describe("resolveConstraints", () => {
  it("turns a date into a night index and a week-of date into that week's nights", () => {
    const r = resolve([
      c("1", "b", "bye_on", { date: "2026-09-17" }),
      c("2", "c", "bye_week", { week_of: "2026-09-23" }),
    ]);
    expect(r.items[0].unresolved).toBeNull();
    expect(r.forced).toContainEqual({ team: 1, night: 3, plays: false });
    expect(r.items[1].nights).toEqual([4, 5]);
    expect(r.forced.filter((f) => f.team === 2)).toHaveLength(2);
  });

  it("makes slot_on imply play_on", () => {
    // ⛔ Without the implied play night, Phase P may bye the team and the pin can't be met.
    const r = resolve([
      c("1", "a", "slot_on", { date: "2026-09-14", time: "20:15" }),
    ]);
    expect(r.forced).toEqual([{ team: 0, night: 2, plays: true }]);
    expect(r.slotPins).toEqual([{ team: 0, night: 2, slot: 1 }]);
  });

  it("keeps bye_in_week out of the forced list — it is a disjunction", () => {
    const r = resolve([c("1", "d", "bye_in_week", { week_of: "2026-09-28" })]);
    expect(r.forced).toEqual([]);
    expect(r.byeInWeek).toEqual([{ team: 3, week: 3 }]);
  });

  it("builds a night mask and a direction for slot_bias", () => {
    const r = resolve([
      c("1", "a", "slot_bias", {
        from: "2026-09-10",
        to: "2026-09-21",
        prefer: "late",
      }),
    ]);
    expect(r.biases).toEqual([
      {
        team: 0,
        nights: [false, true, true, true, true, false, false, false],
        prefer: "late",
      },
    ]);
  });

  describe("a constraint can outlive what it names", () => {
    it("skips a team that is no longer enrolled", () => {
      const r = resolve([c("1", "gone", "bye_on", { date: "2026-09-07" })]);
      expect(r.items[0].unresolved).toMatch(/no longer enrolled/);
      expect(r.empty).toBe(true);
    });

    it("skips a date that is no longer a game night", () => {
      const r = resolve([c("1", "a", "bye_on", { date: "2026-09-08" })]);
      expect(r.items[0].unresolved).toMatch(/not a game night/);
      expect(r.forced).toEqual([]);
    });

    it("skips an ice time that night does not run", () => {
      const r = resolve([
        c("1", "a", "slot_on", { date: "2026-09-07", time: "22:45" }),
      ]);
      expect(r.items[0].unresolved).toMatch(/not an ice time/);
      expect(r.forced).toEqual([]);
    });

    it("skips a week that holds no game nights", () => {
      const r = resolve([c("1", "a", "bye_week", { week_of: "2026-11-30" })]);
      expect(r.items[0].unresolved).toMatch(/holds no game nights/);
    });

    it("survives junk in the jsonb column", () => {
      const r = resolve([c("1", "a", "bye_on", {} as never)]);
      expect(r.items[0].unresolved).toMatch(/no valid date/);
      expect(r.empty).toBe(true);
    });
  });
});

describe("constraintConflicts", () => {
  it("names both requests when a team is asked to play and bye one night", () => {
    const out = constraintConflicts(
      resolve([
        c("1", "a", "bye_on", { date: "2026-09-14" }),
        c("2", "a", "play_on", { date: "2026-09-14" }),
      ]),
      nameOf,
    );
    expect(out).toHaveLength(1);
    expect(out[0]).toContain("A byes on 2026-09-14");
    expect(out[0]).toContain("A plays on 2026-09-14");
  });

  it("catches slot_on against a bye, through the play night it implies", () => {
    const out = constraintConflicts(
      resolve([
        c("1", "b", "bye_week", { week_of: "2026-09-14" }),
        c("2", "b", "slot_on", { date: "2026-09-17", time: "19:00" }),
      ]),
      nameOf,
    );
    expect(out).toHaveLength(1);
  });

  /** ⛔ Two is not a conflict: two teams on one ice time may be playing each other, which is
   *  unknowable before Phase M. Refusing it turned a satisfiable request into a refusal. */
  it("allows two teams on one sheet — they may be playing each other", () => {
    const out = constraintConflicts(
      resolve([
        c("1", "a", "slot_on", { date: "2026-09-14", time: "19:00" }),
        c("2", "c", "slot_on", { date: "2026-09-14", time: "19:00" }),
      ]),
      nameOf,
    );
    expect(out).toEqual([]);
  });

  it("refuses three teams pinned to one sheet — no pairing seats them", () => {
    const out = constraintConflicts(
      resolve([
        c("1", "a", "slot_on", { date: "2026-09-14", time: "19:00" }),
        c("2", "c", "slot_on", { date: "2026-09-14", time: "19:00" }),
        c("3", "d", "slot_on", { date: "2026-09-14", time: "19:00" }),
      ]),
      nameOf,
    );
    expect(out).toHaveLength(1);
    expect(out[0]).toContain("same ice time");
  });

  it("says nothing about a set that merely looks busy", () => {
    expect(
      constraintConflicts(
        resolve([
          c("1", "a", "bye_on", { date: "2026-09-14" }),
          c("2", "b", "bye_on", { date: "2026-09-14" }),
          c("3", "c", "slot_on", { date: "2026-09-17", time: "19:00" }),
        ]),
        nameOf,
      ),
    ).toEqual([]);
  });
});

describe("refuteConstraints", () => {
  const opts = {
    teamIds: TEAMS,
    nameOf,
    // 4 teams, 8 nights, 1 game a night → 6 games each, 2 byes each.
    gamesPerTeam: new Array(4).fill(6),
    gamesPerNight: new Array(8).fill(1),
    weekOfNight: buildNightMeta(NIGHTS).week,
  };

  it("refuses more byes than a team's budget, before any search runs", () => {
    const out = refuteConstraints(
      resolve(
        [0, 2, 4].map((n) =>
          c(`${n}`, "a", "bye_on", { date: NIGHTS[n].date }),
        ),
      ),
      opts,
    );
    expect(out).toHaveLength(1);
    expect(out[0]).toContain("3 byes but only has 2");
  });

  it("counts a bye_in_week toward the budget, unless a forced bye already pays for it", () => {
    const paid = refuteConstraints(
      resolve([
        c("1", "a", "bye_on", { date: NIGHTS[0].date }),
        c("2", "a", "bye_on", { date: NIGHTS[2].date }),
        c("3", "a", "bye_in_week", { week_of: NIGHTS[0].date }),
        c("4", "a", "bye_in_week", { week_of: NIGHTS[2].date }),
      ]),
      opts,
    );
    expect(paid).toEqual([]);

    const unpaid = refuteConstraints(
      resolve([
        c("1", "a", "bye_on", { date: NIGHTS[0].date }),
        c("2", "a", "bye_on", { date: NIGHTS[2].date }),
        c("3", "a", "bye_in_week", { week_of: NIGHTS[4].date }),
      ]),
      opts,
    );
    expect(unpaid[0]).toContain("3 byes but only has 2");
  });

  it("refuses more teams off a night than it has byes to give", () => {
    const out = refuteConstraints(
      resolve(
        ["a", "b", "c"].map((t, i) =>
          c(`${i}`, t, "bye_on", { date: NIGHTS[1].date }),
        ),
      ),
      opts,
    );
    expect(out.some((m) => m.includes("3 teams are asked to bye"))).toBe(true);
  });

  it("refuses more teams pinned to a night than it seats", () => {
    const out = refuteConstraints(
      resolve(
        ["a", "b", "c"].map((t, i) =>
          c(`${i}`, t, "play_on", { date: NIGHTS[1].date }),
        ),
      ),
      opts,
    );
    expect(out.some((m) => m.includes("only seats 2"))).toBe(true);
  });

  it("says nothing when the set fits", () => {
    expect(
      refuteConstraints(
        resolve([
          c("1", "a", "bye_on", { date: NIGHTS[0].date }),
          c("2", "b", "bye_on", { date: NIGHTS[0].date }),
        ]),
        opts,
      ),
    ).toEqual([]);
  });

  it("refuses a bye_in_week on a week that has no bye to give", () => {
    // Week 0 runs two games a night, seating all four teams (0 byes), yet the season budget is
    // 3 byes. ⛔ The budget arithmetic can't see this, which is why it went unrefuted.
    const fullFirstWeek = {
      ...opts,
      gamesPerTeam: new Array(4).fill(5),
      gamesPerNight: [2, 2, 1, 1, 1, 1, 1, 1],
    };

    const out = refuteConstraints(
      resolve([c("1", "a", "bye_in_week", { week_of: NIGHTS[0].date })]),
      fullFirstWeek,
    );
    expect(out).toHaveLength(1);
    expect(out[0]).toContain("no bye to give");

    // ⛔ Two controls: the same ask as `bye_on` was always refused, and a week later it must pass.
    expect(
      refuteConstraints(
        resolve([c("1", "a", "bye_on", { date: NIGHTS[0].date })]),
        fullFirstWeek,
      )[0],
    ).toContain("0 byes to give");

    expect(
      refuteConstraints(
        resolve([c("1", "a", "bye_in_week", { week_of: NIGHTS[2].date })]),
        fullFirstWeek,
      ),
    ).toEqual([]);
  });

  it("reads correctly when the week holds a single game night", () => {
    // ⛔ The commonest league shape, which the first message got wrong ("all 1 of its nights").
    // Five nights and four games a team leave a budget of one, so only this sentence fires.
    const weekly: Night[] = [
      "2026-09-07",
      "2026-09-14",
      "2026-09-21",
      "2026-09-28",
      "2026-10-05",
    ].map((date) => ({ date, slots: SLOTS }));

    const out = refuteConstraints(
      resolveConstraints(
        [c("1", "a", "bye_in_week", { week_of: weekly[1].date })],
        { nights: weekly, teamIds: TEAMS },
      ),
      {
        teamIds: TEAMS,
        nameOf,
        gamesPerTeam: new Array(4).fill(4),
        gamesPerNight: [2, 2, 2, 1, 1],
        weekOfNight: buildNightMeta(weekly).week,
      },
    );

    expect(out).toHaveLength(1);
    expect(out[0]).toContain(
      "its only game night seats every one of the 4 teams",
    );
    expect(out[0]).not.toContain("all 1 of");
  });
});

describe("evaluateConstraints", () => {
  const plays = (byes: [number, number][]) => {
    const m = TEAMS.map(() => new Array(NIGHTS.length).fill(true));
    for (const [t, n] of byes) m[t][n] = false;
    return m;
  };

  it("reads the answer off the placed games, not off the request", () => {
    const r = resolve([c("1", "a", "bye_on", { date: NIGHTS[2].date })]);
    expect(
      evaluateConstraints(r, {
        plays: plays([[0, 2]]),
        slotOf: () => 0,
        plannerHonours: true,
      })[0].satisfied,
    ).toBe(true);
    // Same request, a schedule that did not honour it.
    expect(
      evaluateConstraints(r, {
        plays: plays([[0, 3]]),
        slotOf: () => 0,
        plannerHonours: true,
      })[0],
    ).toMatchObject({ satisfied: false, reason: "the team plays that night" });
  });

  it("reports a pin unmet when the game landed on another sheet", () => {
    const r = resolve([
      c("1", "a", "slot_on", { date: NIGHTS[1].date, time: "20:15" }),
    ]);
    expect(
      evaluateConstraints(r, {
        plays: plays([]),
        slotOf: () => 0,
        plannerHonours: true,
      })[0],
    ).toMatchObject({ satisfied: false });
    expect(
      evaluateConstraints(r, {
        plays: plays([]),
        slotOf: () => 1,
        plannerHonours: true,
      })[0].satisfied,
    ).toBe(true);
  });

  /** ⛔ The midpoint must come from the ice available, not the ice taken: a team on slot 0 every
   *  night read `0 < 0` and failed. Four teams on two sheets, so the middle is 0.5. */
  describe("slot_bias reads against the ice available, not the ice taken", () => {
    const window = { from: NIGHTS[0].date, to: NIGHTS.at(-1)!.date };
    const evaluate = (prefer: "early" | "late", slot: (n: number) => number) =>
      evaluateConstraints(
        resolve([c("1", "a", "slot_bias", { ...window, prefer })]),
        {
          plays: plays([]),
          slotOf: (t, n) => (t === 0 ? slot(n) : 1 - slot(n)),
          plannerHonours: true,
        },
      )[0];

    it("counts the earliest sheet every night as MET for early", () => {
      expect(evaluate("early", () => 0).satisfied).toBe(true);
    });

    it("counts the latest sheet every night as MET for late", () => {
      expect(evaluate("late", () => 1).satisfied).toBe(true);
    });

    it("counts the wrong end as unmet, and says what the average was", () => {
      const out = evaluate("early", () => 1);
      expect(out.satisfied).toBe(false);
      expect(out.reason).toMatch(/average slot 2\.0.*middle of 1\.5/);
    });

    it("counts dead centre as unmet either way — it leans nowhere", () => {
      const halfAndHalf = (n: number) => n % 2;
      expect(evaluate("early", halfAndHalf).satisfied).toBe(false);
      expect(evaluate("late", halfAndHalf).satisfied).toBe(false);
    });
  });

  it("reports everything unmet when the fallback planner won", () => {
    // ⛔ `planByWeeks` forces nothing, so a request holding in its output holds by accident;
    // calling it met would be a false claim.
    const r = resolve([c("1", "a", "bye_on", { date: NIGHTS[2].date })]);
    expect(
      evaluateConstraints(r, {
        plays: plays([[0, 2]]),
        slotOf: () => 0,
        plannerHonours: false,
      })[0],
    ).toMatchObject({ satisfied: false, reason: FALLBACK_PLANNER_REASON });
  });

  it("carries an unresolved constraint's reason through as its verdict", () => {
    const r = resolve([c("1", "gone", "bye_on", { date: NIGHTS[0].date })]);
    expect(
      evaluateConstraints(r, {
        plays: plays([]),
        slotOf: () => 0,
        plannerHonours: true,
      })[0],
    ).toMatchObject({
      satisfied: false,
      reason: expect.stringMatching(/no longer enrolled/),
    });
  });
});

describe("forcedByeCredits", () => {
  const byedFrom = (byes: [number, number][]) => (t: number, n: number) =>
    byes.some(([bt, bn]) => bt === t && bn === n);

  it("credits a week the manager took off entirely", () => {
    const r = resolve([c("1", "a", "bye_week", { week_of: NIGHTS[2].date })]);
    const credits = forcedByeCredits(r, {
      nights: NIGHTS,
      teamIds: TEAMS,
      byed: byedFrom([
        [0, 2],
        [0, 3],
      ]),
    });
    expect(credits.byesMultiWeek).toBe(1);
    expect(credits.byesAdjNight).toBe(1);
  });

  it("does NOT credit a week the solver chose to put a second bye in", () => {
    const r = resolve([c("1", "a", "bye_on", { date: NIGHTS[2].date })]);
    const credits = forcedByeCredits(r, {
      nights: NIGHTS,
      teamIds: TEAMS,
      byed: byedFrom([
        [0, 2],
        [0, 3],
      ]),
    });
    expect(credits.byesMultiWeek).toBe(0);
  });

  it("is all zeroes when nothing is constrained", () => {
    const credits = forcedByeCredits(resolve([]), {
      nights: NIGHTS,
      teamIds: TEAMS,
      byed: byedFrom([
        [0, 2],
        [0, 3],
      ]),
    });
    expect(credits).toEqual({
      byesMultiWeek: 0,
      byesConsecWeek: 0,
      byesConsecWeekSameDay: 0,
      byesAdjNight: 0,
    });
  });
});

/** ⛔ No assertion that unconstrained teams read zero on the bye rules, on purpose: a
 *  constraint spends the season's slack, so collateral is reported, never gated. */
/** ⛔ The rank-off does not decide a constrained generation: eight teams on three sheets is
 *  the shape where Phase P produced a plan and used to lose it. */
describe("a constrained generation prefers Phase P", () => {
  const teams = ["t1", "t2", "t3", "t4", "t5", "t6", "t7", "t8"];
  const slots = ["19:00", "20:15", "21:30"];
  const dates = [
    "2026-09-15",
    "2026-09-17",
    "2026-09-22",
    "2026-09-24",
    "2026-09-29",
    "2026-10-01",
    "2026-10-06",
    "2026-10-08",
    "2026-10-13",
    "2026-10-15",
    "2026-10-20",
  ];
  const nights: Night[] = dates.map((date) => ({ date, slots }));
  const pairings = buildBalancedPairings(teams, 8);

  it("honours a bye the fallback planner would have thrown away", () => {
    const resolved = resolveConstraints(
      [c("1", "t1", "bye_on", { date: nights[2].date })],
      { nights, teamIds: teams },
    );
    const { report } = assignNights(pairings, nights, teams, {
      constraints: resolved,
    });
    expect(report.constraints[0].satisfied).toBe(true);
    expect(report.unscheduled).toBe(0);
    for (const t of report.gamesPerTeam) expect(t.count).toBe(8);
  });

  it("still runs the rank-off when nothing was asked for", () => {
    const { report } = assignNights(pairings, nights, teams);
    expect(report.constraints).toEqual([]);
    expect(report.unscheduled).toBe(0);
    for (const t of report.gamesPerTeam) expect(t.count).toBe(8);
  });
});

describe("what the manager is told", () => {
  const NIGHTS4: Night[] = [
    "2026-09-15",
    "2026-09-17",
    "2026-09-22",
    "2026-09-24",
  ].map((date) => ({ date, slots: ["19:00", "20:15", "21:30"] }));
  const SIX = ["a", "b", "c", "d", "e", "f"];

  it("reports a set whose every constraint failed to resolve", () => {
    const r = resolveConstraints(
      [c("1", "a", "bye_on", { date: "2030-01-01" })],
      {
        nights: NIGHTS4,
        teamIds: SIX,
      },
    );
    expect(r.empty).toBe(true);
    expect(r.items).toHaveLength(1);

    const { report } = assignNights(
      buildBalancedPairings(SIX, 4),
      NIGHTS4,
      SIX,
      {
        constraints: r,
      },
    );
    expect(report.constraints).toHaveLength(1);
    expect(report.constraints[0].satisfied).toBe(false);
    expect(report.constraints[0].reason).toMatch(/not a game night/);
  });

  it("does not call two identical pins a contradiction", () => {
    const dup = {
      teamId: "a",
      kind: "slot_on" as const,
      params: { date: "2026-09-15", time: "20:15" },
    };
    const r = resolveConstraints(
      [
        { id: "1", ...dup },
        { id: "2", ...dup },
      ],
      { nights: NIGHTS4, teamIds: SIX },
    );
    expect(constraintConflicts(r, (id) => id.toUpperCase())).toEqual([]);
  });

  it("still calls two DIFFERENT ice times on one night a contradiction", () => {
    const r = resolveConstraints(
      [
        c("1", "a", "slot_on", { date: "2026-09-15", time: "19:00" }),
        c("2", "a", "slot_on", { date: "2026-09-15", time: "20:15" }),
      ],
      { nights: NIGHTS4, teamIds: SIX },
    );
    expect(constraintConflicts(r, (id) => id.toUpperCase())).toHaveLength(1);
  });

  it("judges a slot_bias off the placed games whichever planner placed them", () => {
    const r = resolveConstraints(
      [
        c("1", "a", "slot_bias", {
          from: NIGHTS4[0].date,
          to: NIGHTS4.at(-1)!.date,
          prefer: "early",
        }),
      ],
      { nights: NIGHTS4, teamIds: SIX },
    );
    const out = evaluateConstraints(r, {
      plays: SIX.map(() => new Array(NIGHTS4.length).fill(true)),
      slotOf: (t) => (t === 0 ? 0 : 1),
      plannerHonours: false,
      plannerRan: false,
    });
    expect(out[0].satisfied).toBe(true);
    expect(out[0].reason).toBeNull();
  });
});

describe("presentSpacing", () => {
  const raw = {
    byesMultiWeek: 3,
    byesConsecWeek: 2,
    byesConsecWeekSameDay: 1,
    byesAdjNight: 4,
    other: "carried through",
  };

  it("subtracts the credits a forced bye earned", () => {
    const out = presentSpacing(raw, {
      byesMultiWeek: 1,
      byesConsecWeek: 1,
      byesConsecWeekSameDay: 0,
      byesAdjNight: 2,
    });
    expect(out).toEqual({
      byesMultiWeek: 2,
      byesConsecWeek: 1,
      byesConsecWeekSameDay: 1,
      byesAdjNight: 2,
      other: "carried through",
    });
  });

  it("never presents a negative count, however the credits were derived", () => {
    const out = presentSpacing(raw, {
      byesMultiWeek: 9,
      byesConsecWeek: 9,
      byesConsecWeekSameDay: 9,
      byesAdjNight: 9,
    });
    expect(out.byesMultiWeek).toBe(0);
    expect(out.byesConsecWeek).toBe(0);
    expect(out.byesConsecWeekSameDay).toBe(0);
    expect(out.byesAdjNight).toBe(0);
  });
});

describe("assignNights with manager constraints", () => {
  const ts = Array.from({ length: 8 }, (_, i) => `t${i + 1}`);
  const ns = eightTeamMonThu(16);
  const meta = buildNightMeta(ns);
  // The first calendar week holding two game nights — `bye_week` needs one.
  const fullWeek = meta.sortedWeeks.find(
    (w) => (meta.weekNights.get(w) ?? []).length === 2,
  )!;
  const weekNights = meta.weekNights.get(fullWeek)!;

  const constraints: ScheduleConstraint[] = [
    c("k1", "t1", "bye_week", { week_of: ns[weekNights[0]].date }),
    c("k2", "t4", "slot_on", { date: ns[1].date, time: "21:30" }),
    c("k3", "t6", "slot_bias", {
      from: ns[0].date,
      to: ns[7].date,
      prefer: "late",
    }),
  ];

  const pairings = buildBalancedPairings(ts, 12);
  const resolved = resolveConstraints(constraints, { nights: ns, teamIds: ts });
  const { games, report } = assignNights(pairings, ns, ts, {
    constraints: resolved,
  });

  it("places every game", () => {
    expect(report.unscheduled).toBe(0);
    expect(games.length).toBe(pairings.length);
  });

  it("invariant 1: total games per team is untouched", () => {
    for (const t of report.gamesPerTeam) expect(t.count).toBe(12);
  });

  it("invariant 2: games per night is untouched", () => {
    const perNight = new Array(ns.length).fill(0);
    for (const g of games) perNight[g.nightIndex]++;
    expect(perNight).toEqual(new Array(ns.length).fill(3));
    for (let n = 0; n < ns.length; n++) {
      const on = games
        .filter((g) => g.nightIndex === n)
        .flatMap((g) => [g.home, g.away]);
      expect(new Set(on).size).toBe(on.length);
    }
  });

  it("invariant 3: each pair meets exactly as often as it was asked to", () => {
    const key = (a: string, b: string) => [a, b].sort().join("|");
    const want = new Map<string, number>();
    for (const p of pairings)
      want.set(key(p.home, p.away), (want.get(key(p.home, p.away)) ?? 0) + 1);
    const got = new Map(report.pairingCounts.map((p) => [p.matchup, p.count]));
    expect(got).toEqual(want);
  });

  it("keeps the whole week off it was asked for", () => {
    const t1 = ts.indexOf("t1");
    const outcome = report.constraints.find((x) => x.id === "k1")!;
    expect(outcome.satisfied).toBe(true);
    for (const n of weekNights) {
      expect(
        games.some(
          (g) => g.nightIndex === n && (g.home === ts[t1] || g.away === ts[t1]),
        ),
      ).toBe(false);
    }
  });

  it("does not count a requested week off as a rule-1 breach in the presented metrics", () => {
    // ⛔ Credits computed here as production computes them (`forcedByeCredits` off the placed
    // games): a report field only this test read was how the wrong source got wired in.
    const plays = ts.map(() => new Array(ns.length).fill(false));
    for (const g of games) {
      plays[ts.indexOf(g.home)][g.nightIndex] = true;
      plays[ts.indexOf(g.away)][g.nightIndex] = true;
    }
    const credits = forcedByeCredits(resolved, {
      nights: ns,
      teamIds: ts,
      byed: (t, n) => !plays[t][n],
    });

    const presented = presentSpacing(report.spacing, credits);
    expect(credits.byesMultiWeek).toBeGreaterThanOrEqual(1);
    expect(report.spacing.byesMultiWeek).toBeGreaterThanOrEqual(1);
    expect(presented.byesMultiWeek).toBe(
      report.spacing.byesMultiWeek - credits.byesMultiWeek,
    );
    expect(presented.byesMultiWeek).toBeLessThan(report.spacing.byesMultiWeek);
  });

  it("reports every constraint, with a reason whenever one is unmet", () => {
    expect(report.constraints.map((x) => x.id)).toEqual(["k1", "k2", "k3"]);
    for (const outcome of report.constraints) {
      if (outcome.satisfied) expect(outcome.reason).toBeNull();
      else expect(outcome.reason).toEqual(expect.stringMatching(/\S/));
    }
  });
});

describe("assignNights — a pinned slot survives the clustering pass", () => {
  // The 6-team one-weeknight shape, loose enough for the night-order pass to move nights; the
  // 8-team fixture above isn't, so it would never exercise a moved pin.
  const ts = Array.from({ length: 6 }, (_, i) => `t${i + 1}`);
  const ns = sixTeamTuesdays(23);
  const pairings = buildBalancedPairings(ts, 23);
  const constraints: ScheduleConstraint[] = [
    c("p1", "t3", "slot_on", { date: ns[11].date, time: "21:30" }),
  ];
  const resolved = resolveConstraints(constraints, { nights: ns, teamIds: ts });
  const { games, report } = assignNights(pairings, ns, ts, {
    constraints: resolved,
  });

  it("still places every game", () => {
    expect(report.unscheduled).toBe(0);
    expect(games.length).toBe(pairings.length);
  });

  it("keeps the pinned slot_on satisfied", () => {
    const outcome = report.constraints.find((x) => x.id === "p1")!;
    expect(outcome.satisfied).toBe(true);
  });
});

describe("assignNights — a constrained season still gets its ice time spread", () => {
  const ts = Array.from({ length: 6 }, (_, i) => `t${i + 1}`);
  const ns = sixTeamTuesdays(23);
  const pairings = buildBalancedPairings(ts, 23);
  // ⛔ Night 15, and the number matters: with `nightClass` deleted, pins on 7, 15 and 19 go
  // unmet; one on night 11 passes anyway and asserts nothing about the labels.
  const resolved = resolveConstraints(
    [c("p1", "t3", "slot_on", { date: ns[15].date, time: "21:30" })],
    { nights: ns, teamIds: ts },
  );
  const { report } = assignNights(pairings, ns, ts, { constraints: resolved });

  it("keeps the pin satisfied", () => {
    expect(report.constraints.find((x) => x.id === "p1")!.satisfied).toBe(true);
  });

  it.each([
    ["slot_on", "t3", { date: ns[15].date, time: "21:30" }],
    ["slot_bias", "t1", { from: ns[0].date, to: ns[11].date, prefer: "late" }],
  ])("a %s request survives the night-order pass", (kind, team, params) => {
    const r = resolveConstraints(
      [
        c(
          "k1",
          team,
          kind as ScheduleConstraint["kind"],
          params as ScheduleConstraint["params"],
        ),
      ],
      { nights: ns, teamIds: ts },
    );
    // Guards the fixture: a wrong param key resolves to no solver entry and tests nothing.
    expect(r.empty).toBe(false);
    // ⛔ `variations: 1`: a block of four hides a broken class check, since selection ranks unmet
    // requests first. Verified by mutation (passes at the default block, fails here).
    const out = assignNights(pairings, ns, ts, {
      constraints: r,
      variations: 1,
    });
    expect(out.report.constraints.find((x) => x.id === "k1")!.satisfied).toBe(
      true,
    );
  }, 180_000);
});
