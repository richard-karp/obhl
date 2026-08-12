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
