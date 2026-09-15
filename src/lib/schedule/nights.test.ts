import { describe, it, expect } from "vitest";
import {
  checkNightMove,
  groupIntoNights,
  moveNightTo,
  type NightRow,
  type SeasonNight,
  type SeasonNightGame,
} from "./nights";
import { leagueDateKey, leagueTimeKey } from "@/lib/format";

const TODAY = "2026-09-20";

const row = (over: Partial<NightRow> = {}): NightRow => ({
  id: "g1",
  scheduled_at: "2026-09-22T23:00:00Z", // 7pm EDT on the 22nd
  postponed_from: null,
  status: "scheduled",
  label: null,
  home_team_id: "home",
  away_team_id: "away",
  ...over,
});

describe("groupIntoNights", () => {
  it("groups games onto their league-local date", () => {
    const nights = groupIntoNights(
      [
        row({ id: "a", scheduled_at: "2026-09-22T23:00:00Z" }),
        row({ id: "b", scheduled_at: "2026-09-23T00:15:00Z" }), // 8:15pm, same night
        row({ id: "c", scheduled_at: "2026-09-24T23:00:00Z" }),
      ],
      TODAY,
    );
    expect(nights.map((n) => n.date)).toEqual(["2026-09-22", "2026-09-24"]);
    expect(nights[0].games.map((g) => g.id)).toEqual(["a", "b"]);
  });

  it("orders a night's games by ice time", () => {
    const nights = groupIntoNights(
      [
        row({ id: "late", scheduled_at: "2026-09-23T00:15:00Z" }),
        row({ id: "early", scheduled_at: "2026-09-22T23:00:00Z" }),
      ],
      TODAY,
    );
    expect(nights[0].games.map((g) => g.id)).toEqual(["early", "late"]);
  });

  it("locks a night in the past", () => {
    const nights = groupIntoNights(
      [row({ scheduled_at: "2026-09-15T23:00:00Z" })],
      TODAY,
    );
    expect(nights[0].locked).toBe(true);
  });

  it("leaves a future night of scheduled games unlocked", () => {
    expect(groupIntoNights([row()], TODAY)[0].locked).toBe(false);
  });

  it.each(["final", "in_progress", "cancelled"])(
    "locks a future night holding a %s game",
    (status) => {
      const nights = groupIntoNights(
        [row({ id: "a" }), row({ id: "b", status })],
        TODAY,
      );
      expect(nights[0].locked).toBe(true);
    },
  );

  it("keeps a postponed game on the night it was postponed from", () => {
    const nights = groupIntoNights(
      [
        row({ id: "played", scheduled_at: "2026-09-22T23:00:00Z" }),
        row({
          id: "off",
          scheduled_at: null,
          postponed_from: "2026-09-23T00:15:00Z",
          status: "postponed",
        }),
      ],
      TODAY,
    );
    expect(nights).toHaveLength(1);
    expect(nights[0].games.map((g) => g.id)).toEqual(["played", "off"]);
  });

  it("locks a night holding a postponed game", () => {
    const nights = groupIntoNights(
      [
        row({ id: "played" }),
        row({
          id: "off",
          scheduled_at: null,
          postponed_from: "2026-09-23T00:15:00Z",
          status: "postponed",
        }),
      ],
      TODAY,
    );
    expect(nights[0].locked).toBe(true);
  });

  it("reports a postponed game's own date as null, not the night's", () => {
    const nights = groupIntoNights(
      [
        row({ id: "played" }),
        row({
          id: "off",
          scheduled_at: null,
          postponed_from: "2026-09-23T00:15:00Z",
          status: "postponed",
        }),
      ],
      TODAY,
    );
    const off = nights[0].games.find((g) => g.id === "off");
    expect(off?.scheduledAt).toBeNull();
    // Still ordered by when it sat on the night, though.
    expect(nights[0].games.map((g) => g.id)).toEqual(["played", "off"]);
  });

  it("drops a game with no date at all", () => {
    const nights = groupIntoNights(
      [row({ id: "nowhere", scheduled_at: null, postponed_from: null })],
      TODAY,
    );
    expect(nights).toEqual([]);
  });
});

describe("moveNightTo", () => {
  const at = (iso: string, id = "g") => ({ id, scheduledAt: iso });

  it("keeps each game's league-local ice time, in the same order", () => {
    const moved = moveNightTo(
      [
        at("2026-09-22T23:00:00Z", "a"), // 19:00 EDT
        at("2026-09-23T00:15:00Z", "b"), // 20:15 EDT
        at("2026-09-23T01:30:00Z", "c"), // 21:30 EDT
      ],
      "2026-09-29",
    );
    expect(moved.map((m) => m.id)).toEqual(["a", "b", "c"]);
    expect(moved.map((m) => leagueTimeKey(m.scheduledAt))).toEqual([
      "19:00",
      "20:15",
      "21:30",
    ]);
    expect(moved.map((m) => leagueDateKey(m.scheduledAt))).toEqual([
      "2026-09-29",
      "2026-09-29",
      "2026-09-29",
    ]);
  });

  it("preserves the gaps between slots, whatever they are", () => {
    const moved = moveNightTo(
      [
        at("2026-09-22T22:30:00Z", "a"), // 18:30 EDT
        at("2026-09-23T00:45:00Z", "b"), // 20:45 EDT — a 2h15 gap
      ],
      "2026-09-29",
    );
    const gapMs =
      Date.parse(moved[1].scheduledAt) - Date.parse(moved[0].scheduledAt);
    expect(gapMs).toBe(2 * 3_600_000 + 15 * 60_000);
  });

  /** ⛔ Why this is a function, not a swap of the date part: across DST the wall clock stays,
   *  and rewriting only the date would put a November 19:00 game on the ice at 18:00. */
  it("keeps the wall clock across the DST boundary, not the instant", () => {
    const moved = moveNightTo(
      [at("2026-10-27T23:00:00Z", "a")], // 19:00 EDT (-04:00)
      "2026-11-10", // EST (-05:00)
    );
    expect(leagueTimeKey(moved[0].scheduledAt)).toBe("19:00");
    expect(leagueDateKey(moved[0].scheduledAt)).toBe("2026-11-10");
    expect(moved[0].scheduledAt).toContain("-05:00");
  });

  it("moves nothing it was not given a time for", () => {
    expect(moveNightTo([{ id: "a", scheduledAt: null }], "2026-09-29")).toEqual(
      [],
    );
  });
});

describe("checkNightMove", () => {
  const game = (over: Partial<SeasonNightGame> = {}): SeasonNightGame => ({
    id: "g",
    homeTeamId: "home",
    awayTeamId: "away",
    scheduledAt: "2026-09-22T23:00:00Z",
    label: null,
    status: "scheduled",
    ...over,
  });
  const night = (
    date: string,
    over: Partial<SeasonNight> = {},
  ): SeasonNight => ({
    date,
    locked: false,
    games: [game()],
    ...over,
  });
  const nameOf = (id: string) => (id === "home" ? "Bears" : "Sharks");

  const TODAY = "2026-09-20";

  const check = (
    nights: SeasonNight[],
    from: string,
    to: string,
    season: { startsOn: string | null; endsOn: string | null } = {
      startsOn: null,
      endsOn: null,
    },
  ) => checkNightMove({ nights, from, to, today: TODAY, season, nameOf });

  it("allows a move onto an empty date", () => {
    expect(check([night("2026-09-22")], "2026-09-22", "2026-09-29")).toBeNull();
  });

  it("refuses a date that isn't a game night", () => {
    expect(check([night("2026-09-22")], "2026-09-23", "2026-09-29")).toMatch(
      /isn't a game night/,
    );
  });

  it("refuses moving a night onto its own date", () => {
    expect(check([night("2026-09-22")], "2026-09-22", "2026-09-22")).toMatch(
      /already on that date/,
    );
  });

  /** ⛔ The refusal has to name the game, not just say "locked". */
  it("names the game that locked the night", () => {
    const blocked = night("2026-09-22", {
      locked: true,
      games: [game({ id: "a" }), game({ id: "b", status: "final" })],
    });
    const why = check([blocked], "2026-09-22", "2026-09-29");
    expect(why).toContain("Sharks @ Bears");
    expect(why).toContain("final");
  });

  it("says a past night is past rather than blaming a game", () => {
    // Locked with every game still `scheduled` means the date is behind us.
    const past = night("2026-09-22", { locked: true });
    expect(check([past], "2026-09-22", "2026-09-29")).toMatch(/in the past/);
  });

  /** ⚠️ Merging nights is out of scope — the refusal names the count. */
  it("refuses a target that already runs games, naming how many", () => {
    const nights = [
      night("2026-09-22"),
      night("2026-09-24", { games: [game({ id: "x" }), game({ id: "y" })] }),
    ];
    expect(check(nights, "2026-09-22", "2026-09-24")).toContain("2 games");
  });

  /** ⛔ The one-way door: moving a live night into the past trips `season_is_started` for good,
   *  and the past night locks, so the move can't be reversed. */
  it("refuses moving a night into the past", () => {
    const why = check([night("2026-09-22")], "2026-09-22", "2026-09-19");
    expect(why).toMatch(/already passed/);
    expect(why).toMatch(/locks the season/i);
    expect(why).toMatch(/no undo/i);
  });

  it("allows a move onto today", () => {
    expect(check([night("2026-09-22")], "2026-09-22", TODAY)).toBeNull();
  });

  it("refuses a target before the season starts", () => {
    const season = { startsOn: "2026-09-21", endsOn: "2027-03-31" };
    expect(
      check([night("2026-09-22")], "2026-09-22", "2026-09-20", season),
    ).toMatch(/before .* season/i);
  });

  it("refuses a target after the season ends", () => {
    const season = { startsOn: "2026-09-01", endsOn: "2026-09-30" };
    expect(
      check([night("2026-09-22")], "2026-09-22", "2026-10-05", season),
    ).toMatch(/after .* season/i);
  });

  it("allows a target inside the season's dates", () => {
    const season = { startsOn: "2026-09-01", endsOn: "2027-03-31" };
    expect(
      check([night("2026-09-22")], "2026-09-22", "2026-09-29", season),
    ).toBeNull();
  });
});
