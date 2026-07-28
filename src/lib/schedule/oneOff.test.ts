import { describe, it, expect } from "vitest";
import { buildBalancedPairings } from "./roundRobin";
import { assignNights, weekdayOf, type Night } from "./assignNights";
import {
  planOneOff,
  checkOneOffWrite,
  iceTimeSpread,
  type CheckWriteOptions,
  type OneOffNight,
  type OneOffPlan,
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

/** A night both teams play but where they don't already meet. */
function pickTarget(nights: OneOffNight[], from: number) {
  for (let n = from; n < nights.length; n++) {
    const playing = [...new Set(nights[n].games.flat())];
    const meeting = new Set(nights[n].games.map((g) => [...g].sort().join("-")));
    for (const a of playing) {
      for (const b of playing) {
        if (a >= b) continue;
        if (!meeting.has([a, b].sort().join("-"))) return { night: n, pair: [a, b] as [number, number] };
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

  it("restores opponent balance when it repairs", () => {
    const repairs = plans.filter((p) => p.id !== "no-repair");
    expect(repairs.length).toBeGreaterThan(0);
    for (const plan of repairs) expect(plan.drift).toEqual([]);
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
});
