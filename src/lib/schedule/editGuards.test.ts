import { describe, it, expect } from "vitest";
import { editable, legalAfter, type GuardRow } from "./editGuards";

const row = (
  id: string,
  home: string,
  away: string,
  at: string | null,
  extra: Partial<GuardRow> = {},
): GuardRow => ({
  id,
  home_team_id: home,
  away_team_id: away,
  scheduled_at: at,
  status: "scheduled",
  home_goals: null,
  away_goals: null,
  ...extra,
});

const TUE = "2027-01-05T19:00:00-05:00";
const TUE_LATE = "2027-01-05T20:15:00-05:00";
const THU = "2027-01-07T19:00:00-05:00";
const name = (id: string) =>
  ({ A: "Aces", B: "Bruins", C: "Colts", D: "Ducks" })[id] ?? id;

describe("editable", () => {
  it("allows an untouched scheduled game", () => {
    expect(editable(row("g1", "A", "B", TUE), name)).toBeNull();
  });

  /** ⛔ Postponed and cancelled are refused because the write path refuses them: a guard that
   *  allowed them offered games that failed forever. Widen both together. */
  it("refuses a postponed game, naming the status", () => {
    const why = editable(
      row("g1", "A", "B", TUE, { status: "postponed" }),
      name,
    );
    expect(why).toContain("postponed");
    expect(why).toMatch(/restore/i);
  });

  it("refuses a cancelled game, naming the status", () => {
    const why = editable(
      row("g1", "A", "B", TUE, { status: "cancelled" }),
      name,
    );
    expect(why).toContain("cancelled");
    expect(why).toMatch(/restore/i);
  });

  it("refuses a game holding goals", () => {
    const why = editable(row("g1", "A", "B", TUE, { home_goals: 2 }), name);
    expect(why).toMatch(/played|result|goals/i);
  });

  /** ⛔ Not redundant with the goals check: a 0-0 final holds no goals and is still played. */
  it("refuses a 0-0 final, which has no goals at all", () => {
    const why = editable(
      row("g1", "A", "B", TUE, {
        status: "final",
        home_goals: 0,
        away_goals: 0,
      }),
      name,
    );
    expect(why).toMatch(/played|final/i);
  });
});

describe("legalAfter", () => {
  it("accepts an ordinary night", () => {
    expect(
      legalAfter(
        [row("g1", "A", "B", TUE), row("g2", "C", "D", TUE_LATE)],
        name,
      ),
    ).toBeNull();
  });

  it("refuses a team playing itself", () => {
    const why = legalAfter([row("g1", "A", "A", TUE)], name);
    expect(why).toContain("Aces");
    expect(why).toMatch(/itself/i);
  });

  it("refuses a team playing twice on one night", () => {
    const why = legalAfter(
      [row("g1", "A", "B", TUE), row("g2", "A", "C", TUE_LATE)],
      name,
    );
    expect(why).toContain("Aces");
    expect(why).toMatch(/twice|two games/i);
  });

  it("allows the same team on two different nights", () => {
    expect(
      legalAfter([row("g1", "A", "B", TUE), row("g2", "A", "C", THU)], name),
    ).toBeNull();
  });

  /** ⛔ `exchangeSlots` moves dates, not teams: these predicates run over every primitive's
   *  post-edit rows, which is what catches a doubleheader made by a slot trade. */
  it("catches a doubleheader created by moving a date rather than a team", () => {
    const why = legalAfter(
      [row("g1", "A", "B", TUE), row("g2", "A", "C", TUE)],
      name,
    );
    expect(why).toMatch(/twice|two games/i);
  });

  /** A postponed game is not on the ice, so it cannot make a doubleheader. */
  it("ignores postponed games when counting a team's night", () => {
    expect(
      legalAfter(
        [
          row("g1", "A", "B", TUE),
          row("g2", "A", "C", TUE, { status: "postponed" }),
        ],
        name,
      ),
    ).toBeNull();
  });
});
