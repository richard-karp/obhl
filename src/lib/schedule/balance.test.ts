import { describe, it, expect } from "vitest";
import { countsFor, preserved, type BalanceRow } from "./balance";

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

  /** ⛔ Postponement takes a game off its night; counted, restoring one would read as an
   *  unbalancing edit and be refused. */
  it("ignores postponed and cancelled games in the per-night count", () => {
    const c = countsFor([
      row("g1", "A", "B", TUE),
      row("g2", "C", "D", TUE, "postponed"),
      row("g3", "E", "F", TUE, "cancelled"),
    ]);
    expect([...c.perNight.values()]).toEqual([1]);
  });

  /** ⚠️ But per team they count, deliberately: otherwise a postponed game could be traded
   *  away, ending the season a game short with every check green. */
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

  /** A substitution moves two totals and `preserved` names the first, so either team passes. */
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

  /** ⚠️ `nameOf` shipped unpassed for a review cycle with the suite green: a parameter no test
   *  observes can go unwired. */
  it("names teams through nameOf when one is supplied", () => {
    const after = countsFor([
      row("g1", "A", "B", TUE),
      row("g2", "C", "A", TUE_LATE),
      row("g3", "A", "C", THU),
      row("g4", "B", "D", THU),
    ]);
    const names: Record<string, string> = { A: "Falcons", D: "Otters" };
    const why = preserved(before, after, (id) => names[id] ?? id);
    expect(why).toMatch(/^(Falcons|Otters) would play \d+ games, not \d+\./);
  });

  /** A team new to the schedule is caught, not a crash on a missing key; either name is right. */
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
