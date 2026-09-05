import { describe, it, expect } from "vitest";
import {
  solveParticipation,
  describeParticipation,
  type ParticipationNight,
} from "./participation";

/** `weeks` calendar weeks of two game nights each, `games` games a night. */
function twoNightWeeks(weeks: number, games: number): ParticipationNight[] {
  const out: ParticipationNight[] = [];
  for (let w = 0; w < weeks; w++) {
    out.push({ week: w, weekday: 0, games });
    out.push({ week: w, weekday: 1, games });
  }
  return out;
}

describe("solveParticipation", () => {
  it("splits weekdays evenly and keeps byes out of consecutive weeks", () => {
    // 8 teams, 3 games (6 of 8 play) over 12 two-night weeks = 24 nights.
    // 18 games a team leaves 6 byes, comfortably spaced across 12 weeks.
    const nights = twoNightWeeks(12, 3);
    const res = solveParticipation({
      teamCount: 8,
      nights,
      gamesPerTeam: new Array(8).fill(18),
      weekdayCount: 2,
    });
    expect(res).not.toBeNull();
    expect(res!.weekdaySpread).toBe(0);
    expect(res!.byeMultiWeek).toBe(0);
    expect(res!.byeConsecWeek).toBe(0);
    expect(res!.byeConsecWeekSameDay).toBe(0);
  });

  it("honours the games-per-team row sums and per-night bye quotas", () => {
    const nights = twoNightWeeks(12, 3);
    const res = solveParticipation({
      teamCount: 8,
      nights,
      gamesPerTeam: new Array(8).fill(18),
      weekdayCount: 2,
    })!;
    for (const row of res.plays) expect(row.filter(Boolean).length).toBe(18);
    nights.forEach((n, i) => {
      const playing = res.plays.filter((row) => row[i]).length;
      expect(playing).toBe(2 * n.games);
    });
  });

  it("returns metrics that match an independent recount", () => {
    const nights = twoNightWeeks(12, 3);
    const res = solveParticipation({
      teamCount: 8,
      nights,
      gamesPerTeam: new Array(8).fill(18),
      weekdayCount: 2,
    })!;
    const { plays, optimal, ...metrics } = res;
    expect(typeof optimal).toBe("boolean");
    expect(describeParticipation(plays, nights)).toEqual(metrics);
  });

  // The ladder in planByParticipation falls back to these unpinned rungs when a
  // calendar's optimal per-weekday quotas can't be packed onto nights, so the
  // path needs to hold up on its own even though the pinned rungs usually win.
  it("solves with the per-weekday quotas left unpinned", () => {
    const nights = twoNightWeeks(12, 3);
    const res = solveParticipation({
      teamCount: 8,
      nights,
      gamesPerTeam: new Array(8).fill(18),
      weekdayCount: 2,
      exactWeekdayTargets: false,
    });
    expect(res).not.toBeNull();
    for (const row of res!.plays) expect(row.filter(Boolean).length).toBe(18);
    nights.forEach((n, i) => {
      expect(res!.plays.filter((row) => row[i]).length).toBe(2 * n.games);
    });
    // The slack band alone still pins 18 games to a 9/9 weekday split.
    expect(res!.weekdaySpread).toBe(0);
    expect(res!.byeMultiWeek).toBe(0);
  });

  it("still solves when a holiday gap splits the season into two runs", () => {
    // Weeks 0–5 then 8–13: byes either side of the gap aren't "consecutive".
    const nights: ParticipationNight[] = [];
    for (const w of [0, 1, 2, 3, 4, 5, 8, 9, 10, 11, 12, 13]) {
      nights.push({ week: w, weekday: 0, games: 3 });
      nights.push({ week: w, weekday: 1, games: 3 });
    }
    const res = solveParticipation({
      teamCount: 8,
      nights,
      gamesPerTeam: new Array(8).fill(18),
      weekdayCount: 2,
    });
    expect(res).not.toBeNull();
    expect(res!.weekdaySpread).toBe(0);
    expect(res!.byeConsecWeek).toBe(0);
    // The gap is exactly where a week-based rule goes blind: week 5's last night
    // and week 8's first are consecutive *nights* with three weeks of calendar
    // between them, so byeing both is the longest layoff this season can hand a
    // team — and the three rules above all read it as "not consecutive weeks".
    expect(res!.byeAdjNight).toBe(0);
  });

  it("counts back-to-back byes on a single-weekday calendar", () => {
    // One weekday: every pair of consecutive nights is also a pair of
    // consecutive weeks, so rule 4 and rule 3 fire on the same events. That
    // double charge is deliberate — the two rules agree here rather than
    // conflicting, and a team that byes two Thursdays running has still had two
    // game nights off in a row.
    const nights: ParticipationNight[] = [];
    for (let w = 0; w < 16; w++) nights.push({ week: w, weekday: 0, games: 3 });
    const res = solveParticipation({
      teamCount: 8,
      nights,
      gamesPerTeam: new Array(8).fill(12),
      weekdayCount: 1,
    });
    expect(res).not.toBeNull();
    for (const row of res!.plays) expect(row.filter(Boolean).length).toBe(12);
    // 8 teams over 16 nights of 3 games leaves each team 4 byes across 16 weeks
    // — enough room to keep every one of them isolated.
    expect(res!.byeAdjNight).toBe(0);
    expect(res!.byeConsecWeek).toBe(0);
    // Single weekday: a team's games are all on it, so the spread is trivially 0.
    expect(res!.weekdaySpread).toBe(0);
  });

  it("trades rule 2 for rule 4 when a bye every week leaves no other option", () => {
    // 8 teams, 2 games a night: only 4 of 8 play, so each team byes one of every
    // week's two nights. Rule 3 is unreachable, and rules 2 and 4 cannot both
    // hold: alternating weekdays satisfies rule 2 but makes every Thu-then-Mon
    // pair a back-to-back bye, while byeing one weekday for half the season and
    // the other for the rest costs rule 2 on every week but stays clear of
    // back-to-back nights. Rule 4 is weighted above rule 2 — a team sitting two
    // game nights running is the worse defect — so the solver takes the second,
    // and this is the one calendar shape in the suite where that shows.
    //
    // Rule 1 is unaffected either way and must still hold exactly.
    const nights = twoNightWeeks(14, 2);
    const res = solveParticipation({
      teamCount: 8,
      nights,
      gamesPerTeam: new Array(8).fill(14),
      weekdayCount: 2,
    });
    expect(res).not.toBeNull();
    expect(res!.weekdaySpread).toBe(0);
    expect(res!.byeMultiWeek).toBe(0);
    // Bounds, not exact values: this calendar can't be solved to proven
    // optimality inside the budget, so the search returns its best-so-far and
    // stops on wall clock. Measured: 4 and 96. The alternating pattern this
    // replaced scored ~56 on rule 4 and 0 on rule 2.
    expect(res!.byeAdjNight).toBeLessThanOrEqual(8);
    expect(res!.byeConsecWeekSameDay).toBeGreaterThan(0);
  });

  // 12 nights weighted 7 to weekday 0 and 5 to weekday 1: 5 full weeks then two
  // weeks that only host the first weekday. 3 games a night is 36 games, so 9 a
  // team and 3 byes each.
  const lopsided = (): ParticipationNight[] => {
    const nights: ParticipationNight[] = [];
    for (let w = 0; w < 5; w++) {
      nights.push({ week: w, weekday: 0, games: 3 });
      nights.push({ week: w, weekday: 1, games: 3 });
    }
    nights.push({ week: 5, weekday: 0, games: 3 });
    nights.push({ week: 6, weekday: 0, games: 3 });
    return nights;
  };

  it("declines when a weekday's byes can't be shared out evenly", () => {
    // An even 4-or-5 split each way would need 16 byes on weekday 0, but its
    // seven nights only hand out 14 — no assignment of nights can fix that, so
    // the arithmetic check refuses before any search happens.
    const res = solveParticipation({
      teamCount: 8,
      nights: lopsided(),
      gamesPerTeam: new Array(8).fill(9),
      weekdayCount: 2,
      weekdaySlack: 0,
    });
    expect(res).toBeNull();
  });

  it("solves the same calendar once the weekday target is loosened", () => {
    const nights = lopsided();
    const res = solveParticipation({
      teamCount: 8,
      nights,
      gamesPerTeam: new Array(8).fill(9),
      weekdayCount: 2,
      weekdaySlack: 1,
    });
    expect(res).not.toBeNull();
    for (const row of res!.plays) expect(row.filter(Boolean).length).toBe(9);
    // Six teams can reach a 5/4 split; the remaining two are stuck at 6/3
    // whatever we do, so the widest spread is 3 and only two teams see it.
    const spreads = res!.plays.map((row) => {
      const games = [0, 0];
      nights.forEach((n, i) => {
        if (row[i]) games[n.weekday]++;
      });
      return Math.max(...games) - Math.min(...games);
    });
    expect(Math.max(...spreads)).toBe(3);
    expect(spreads.filter((s) => s === 3).length).toBe(2);
  });
});

/**
 * Manager constraints in Phase P.
 *
 * The invariant every one of these asserts, in one form or another: a forced
 * bye MOVES a bye. Games per team and the per-night bye quota are properties of
 * the calendar, not of the request, and nothing here is allowed to bend them.
 */
describe("solveParticipation with manager constraints", () => {
  const base = () => ({
    teamCount: 8,
    nights: twoNightWeeks(12, 3),
    gamesPerTeam: new Array(8).fill(18),
    weekdayCount: 2,
  });

  /** Games per team, and teams playing each night — the untouchable pair. */
  const expectStructureHolds = (
    plays: boolean[][],
    nights: ParticipationNight[],
    gamesPerTeam: number,
  ) => {
    for (const row of plays) expect(row.filter(Boolean).length).toBe(gamesPerTeam);
    nights.forEach((n, i) => {
      expect(plays.filter((row) => row[i]).length).toBe(2 * n.games);
    });
  };

  it("puts a forced bye exactly where it was asked for, and moves one to pay", () => {
    const opts = base();
    const res = solveParticipation({
      ...opts,
      forced: [{ team: 3, night: 5, plays: false }],
    })!;
    expect(res).not.toBeNull();
    expect(res.plays[3][5]).toBe(false);
    expectStructureHolds(res.plays, opts.nights, 18);
  });

  it("forces a play night, and nobody else loses a game to it", () => {
    const opts = base();
    // Night 4 is one this team byes when left alone, so the pin has work to do.
    const free = solveParticipation(base())!;
    const night = free.plays[2].findIndex((p) => !p);
    const res = solveParticipation({
      ...opts,
      forced: [{ team: 2, night, plays: true }],
    })!;
    expect(res).not.toBeNull();
    expect(res.plays[2][night]).toBe(true);
    expectStructureHolds(res.plays, opts.nights, 18);
  });

  it("takes a whole week off without spending an extra bye", () => {
    const opts = base();
    const res = solveParticipation({
      ...opts,
      // Week 4 is nights 8 and 9 under `twoNightWeeks`.
      forced: [
        { team: 1, night: 8, plays: false },
        { team: 1, night: 9, plays: false },
      ],
    })!;
    expect(res).not.toBeNull();
    expect(res.plays[1][8]).toBe(false);
    expect(res.plays[1][9]).toBe(false);
    expectStructureHolds(res.plays, opts.nights, 18);
    // The rule-1 breach the request creates is REAL in the solver's own metric —
    // it is only excluded when the numbers are presented. Asserting the solver
    // reports zero here would contradict the design: `byeRuleCost` is also the
    // basis of the admissible bound, and is deliberately left alone.
    expect(res.byeMultiWeek).toBeGreaterThanOrEqual(1);
  });

  it("satisfies a bye_in_week disjunction without pinning a night", () => {
    const opts = base();
    const res = solveParticipation({
      ...opts,
      byeInWeek: [{ team: 6, week: 7 }],
    })!;
    expect(res).not.toBeNull();
    // Week 7 is nights 14 and 15.
    expect(res.plays[6][14] && res.plays[6][15]).toBe(false);
    expectStructureHolds(res.plays, opts.nights, 18);
  });

  it("survives a constraint set that forces no cells at all", () => {
    // A season carrying only `slot_bias` — or only `bye_in_week` — arrives here
    // with an EMPTY `forced` array rather than none: the set is non-empty, so
    // the caller does not short-circuit. Crashed before the guard was written
    // against "has forced cells" instead of "was given a forced argument".
    const opts = base();
    const empty = solveParticipation({ ...opts, forced: [] });
    expect(empty).not.toBeNull();
    expectStructureHolds(empty!.plays, opts.nights, 18);
    // ...and it is the same schedule an unconstrained solve produces, since
    // nothing was actually asked for.
    expect(empty!.plays).toEqual(solveParticipation(base())!.plays);
    expect(solveParticipation({ ...opts, byeInWeek: [] })).not.toBeNull();
  });

  it("refuses a cell asked to be both a bye and a game", () => {
    expect(
      solveParticipation({
        ...base(),
        forced: [
          { team: 0, night: 3, plays: false },
          { team: 0, night: 3, plays: true },
        ],
      }),
    ).toBeNull();
  });

  it("refuses more forced byes than a night has to give", () => {
    // 8 teams, 3 games a night → exactly 2 byes available.
    const forced = [0, 1, 2].map((team) => ({ team, night: 3, plays: false }));
    expect(solveParticipation({ ...base(), forced })).toBeNull();
  });

  /**
   * The mechanism `chooseWeekdayByeTargets` gained: unconstrained teams keep
   * their exact even split and the slack lands on as few of them as the column
   * totals allow, instead of being smeared across the league.
   *
   * The arithmetic, so the bound below is not mistaken for a search result: 24
   * nights, 12 of each weekday, hands out 24 byes per weekday. Team 0's six byes
   * split 3/3 when nobody asks for anything. Forcing four of them onto Mondays
   * takes one Monday bye off the pool, so exactly one other team must drop to
   * two — the column sum says so, and no allocation can do better. What the
   * pinning buys is that it is ONE other team and not several.
   */
  it("lands a forced bye's weekday cost on as few other teams as the totals allow", () => {
    const opts = base();
    const res = solveParticipation({
      ...opts,
      // Nights 0, 2, 4, 6 are the first four Mondays.
      forced: [0, 2, 4, 6].map((night) => ({ team: 0, night, plays: false })),
      // A fourth Monday bye is one more than a perfectly even 18 games allows,
      // so the request only fits at all once the weekday band widens by a game.
      // The generator's own ladder does this for itself — this is the rung it
      // lands on, reached directly because the unit under test is the solver.
      weekdaySlack: 1,
    })!;
    expect(res).not.toBeNull();
    for (const night of [0, 2, 4, 6]) expect(res.plays[0][night]).toBe(false);
    expectStructureHolds(res.plays, opts.nights, 18);

    const spreadOf = (t: number) => {
      const games = [0, 0];
      opts.nights.forEach((n, i) => {
        if (res.plays[t][i]) games[n.weekday]++;
      });
      return Math.abs(games[0] - games[1]);
    };
    const others = [1, 2, 3, 4, 5, 6, 7].map(spreadOf);
    expect(others.filter((s) => s !== 0).length).toBeLessThanOrEqual(1);
  });
});

/**
 * Two requests naming ONE cell.
 *
 * The per-weekday bye limits are per-cell, `forced` is a list of requests, and
 * the two are not the same length. Neither route in requires the manager to do
 * anything wrong: `saveScheduleConstraint` is a plain insert with no unique
 * index and the picker keeps its team after a successful add, so a double-click
 * duplicates a request; and a `bye_week` plus a `bye_on` inside that same week
 * resolves to two entries for one night with no duplicate request at all.
 *
 * ⚠️ `exactWeekdayTargets: true` — the bug lives in the exact-target pinning,
 * and the generator's rung ladder drops to `exact: false` at rung 4, which is
 * why this never surfaced as a refusal end-to-end. It surfaced as a worse
 * schedule and no message, so it is asserted here at the solver.
 */
describe("solveParticipation with duplicate forced cells", () => {
  // Tighter than `base()` above on purpose: 8 nights leaves 2 byes a team, so
  // a single duplicated request is already enough to over-count a weekday.
  const tight = () => ({
    teamCount: 8,
    nights: twoNightWeeks(4, 3),
    gamesPerTeam: new Array(8).fill(6),
    weekdayCount: 2,
    exactWeekdayTargets: true,
  });
  const bye = { team: 0, night: 0, plays: false };

  it("plans on one request, which is the control", () => {
    const res = solveParticipation({ ...tight(), forced: [bye] });
    expect(res).not.toBeNull();
    expect(res!.plays[0][0]).toBe(false);
  });

  it("plans on the same request twice", () => {
    const res = solveParticipation({ ...tight(), forced: [bye, bye] });
    expect(res).not.toBeNull();
    expect(res!.plays[0][0]).toBe(false);
  });

  it("plans on a bye_week overlapping a bye_on", () => {
    // Week 0 is nights 0 and 1. `bye_week` forces both; `bye_on` re-forces one.
    const res = solveParticipation({
      ...tight(),
      forced: [
        { team: 1, night: 0, plays: false },
        { team: 1, night: 1, plays: false },
        { team: 1, night: 0, plays: false },
      ],
    });
    expect(res).not.toBeNull();
    expect(res!.plays[1][0]).toBe(false);
    expect(res!.plays[1][1]).toBe(false);
  });
});
