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
  it("splits weekdays evenly", () => {
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

  // The unpinned rungs `planByParticipation` falls back to must hold up on their own.
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
  });

  it("solves a single-weekday calendar", () => {
    // One weekday: consecutive nights are consecutive weeks, so rules 3 and 4 fire on the same
    // events. Deliberate: they agree here rather than conflict.
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
    expect(res!.weekdaySpread).toBe(0);
  });

  it("still splits weekdays evenly when every team byes every week", () => {
    // 4 of 8 play, so each team byes one night a week: rules 2 and 4 can't both hold, and rule 4
    // outranks rule 2. Rule 1 must still hold exactly.
    const nights = twoNightWeeks(14, 2);
    const res = solveParticipation({
      teamCount: 8,
      nights,
      gamesPerTeam: new Array(8).fill(14),
      weekdayCount: 2,
    });
    expect(res).not.toBeNull();
    expect(res!.weekdaySpread).toBe(0);
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
    // An even split needs 16 byes on weekday 0, but its seven nights hand out only 14.
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
  });
});

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
    for (const row of plays)
      expect(row.filter(Boolean).length).toBe(gamesPerTeam);
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
    // The rule-1 breach is real in the solver's metric and excluded only when presented: don't
    // assert zero (`byeRuleCost` is the admissible bound's basis).
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
    // A `slot_bias`- or `bye_in_week`-only season arrives with `forced: []`, not none.
    const opts = base();
    const empty = solveParticipation({ ...opts, forced: [] });
    expect(empty).not.toBeNull();
    expectStructureHolds(empty!.plays, opts.nights, 18);
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

  it("puts four forced byes on one weekday once the band widens by a game", () => {
    const opts = base();
    const res = solveParticipation({
      ...opts,
      // Nights 0, 2, 4, 6 are the first four Mondays.
      forced: [0, 2, 4, 6].map((night) => ({ team: 0, night, plays: false })),
      // A fourth Monday bye fits only once the weekday band widens by a game.
      weekdaySlack: 1,
    })!;
    expect(res).not.toBeNull();
    for (const night of [0, 2, 4, 6]) expect(res.plays[0][night]).toBe(false);
    expectStructureHolds(res.plays, opts.nights, 18);
  });
});

/** Two requests naming one cell (a double-click, or `bye_week` overlapping `bye_on`). ⚠️ Pinned
 *  to `exactWeekdayTargets: true`: the ladder's unpinned rungs hid the bug end to end. */
describe("solveParticipation with duplicate forced cells", () => {
  // Tighter than `base()`: 2 byes a team, so one duplicate already over-counts a weekday.
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
