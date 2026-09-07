import { describe, it, expect } from "vitest";
import { countsFor, preserved, type BalanceRow } from "./balance";

/**
 * Rows are written by hand rather than generated: every case here is about one
 * specific difference, and a generator would hide which.
 *
 * Times are league-local evenings. `leagueDateKey` buckets by the LEAGUE's day,
 * so a 20:15 game and a 19:00 game on the same evening are one night — that is
 * the thing worth testing, not arithmetic on a Map.
 */
const row = (
  id: string,
  home: string,
  away: string,
  at: string | null,
  status = "scheduled",
): BalanceRow => ({
  id,
  home_team_id: home,
  away_team_id: away,
  scheduled_at: at,
  status,
});

const TUE = "2027-01-05T19:00:00-05:00";
const TUE_LATE = "2027-01-05T20:15:00-05:00";
const THU = "2027-01-07T19:00:00-05:00";

describe("countsFor", () => {
  it("counts a game for both teams", () => {
    const c = countsFor([row("g1", "A", "B", TUE)]);
    expect(c.perTeam.get("A")).toBe(1);
    expect(c.perTeam.get("B")).toBe(1);
  });

  it("buckets two ice times on one evening as a single night", () => {
    const c = countsFor([
      row("g1", "A", "B", TUE),
      row("g2", "C", "D", TUE_LATE),
      row("g3", "A", "C", THU),
    ]);
    expect([...c.perNight.values()]).toEqual([2, 1]);
  });

  /**
   * ⛔ THE RULE THE WHOLE FEATURE RESTS ON. Postponement takes a game off its
   * night — that is what postponing IS. If these rows counted, restoring a
   * postponed game would read as an edit that unbalanced the schedule, and the
   * invariant would refuse the one operation that repairs a rink closure.
   */
  it("ignores postponed and cancelled games in the per-night count", () => {
    const c = countsFor([
      row("g1", "A", "B", TUE),
      row("g2", "C", "D", TUE, "postponed"),
      row("g3", "E", "F", TUE, "cancelled"),
    ]);
    expect([...c.perNight.values()]).toEqual([1]);
  });

  /**
   * ⚠️ But they DO count per team, and that asymmetry is deliberate: a
   * postponed game is still a game the team owes. Dropping it from the totals
   * would let a manager postpone a game and then trade it away, ending the
   * season a game short with every check still green.
   */
  it("still counts postponed games toward a team's total", () => {
    const c = countsFor([row("g1", "A", "B", TUE, "postponed")]);
    expect(c.perTeam.get("A")).toBe(1);
  });

  it("ignores a game with no date in the per-night count", () => {
    const c = countsFor([row("g1", "A", "B", null)]);
    expect(c.perNight.size).toBe(0);
    expect(c.perTeam.get("A")).toBe(1);
  });
});

describe("preserved", () => {
  const before = countsFor([
    row("g1", "A", "B", TUE),
    row("g2", "C", "D", TUE_LATE),
    row("g3", "A", "C", THU),
    row("g4", "B", "D", THU),
  ]);

  it("accepts a trade of participants between two games", () => {
    // A↔C: every total is unchanged, no date moved.
    const after = countsFor([
      row("g1", "C", "B", TUE),
      row("g2", "A", "D", TUE_LATE),
      row("g3", "A", "C", THU),
      row("g4", "B", "D", THU),
    ]);
    expect(preserved(before, after)).toBeNull();
  });

  it("accepts two games trading dates", () => {
    const after = countsFor([
      row("g1", "A", "B", THU),
      row("g2", "C", "D", TUE_LATE),
      row("g3", "A", "C", TUE),
      row("g4", "B", "D", THU),
    ]);
    expect(preserved(before, after)).toBeNull();
  });

  /**
   * A substitution always moves TWO totals — one team gains, one loses — and
   * `preserved` reports the first difference it finds, not both. So the
   * contract under test is "names a team that moved, with both numbers", not
   * which of the pair it happens to reach first.
   */
  it("names a team whose total changed, and both numbers", () => {
    // D replaced by A in g2 — A gains, D loses.
    const after = countsFor([
      row("g1", "A", "B", TUE),
      row("g2", "C", "A", TUE_LATE),
      row("g3", "A", "C", THU),
      row("g4", "B", "D", THU),
    ]);
    const why = preserved(before, after);
    expect(why).toMatch(/^(A|D) would play \d+ games, not \d+\./);
  });

  it("names the night whose game count changed", () => {
    const after = countsFor([
      row("g1", "A", "B", TUE),
      row("g2", "C", "D", THU), // moved off Tuesday
      row("g3", "A", "C", THU),
      row("g4", "B", "D", THU),
    ]);
    const why = preserved(before, after);
    expect(why).toMatch(/2027-01-05|2027-01-07/);
    expect(why).toMatch(/game/);
  });

  /**
   * A team the schedule has never seen must be caught rather than crash on a
   * missing key — `Z` has no "before" count at all, and `B`, whom it replaced,
   * has no "after" one. Either name is a correct report; both are the same edit.
   */
  it("catches a substitution that introduces a team new to the schedule", () => {
    const after = countsFor([
      row("g1", "A", "Z", TUE),
      row("g2", "C", "D", TUE_LATE),
      row("g3", "A", "C", THU),
      row("g4", "B", "D", THU),
    ]);
    expect(preserved(before, after)).toMatch(/^(B|Z) would play \d+ games/);
  });
});
