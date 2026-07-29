import { describe, it, expect } from "vitest";
import { groupIntoNights, type NightRow } from "./nights";

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

  // The reason this function was extracted. A postponed game has no
  // scheduled_at any more, so grouping on that alone would drop it — taking its
  // night's lock with it, and letting the one-off planner re-pair a night it
  // must not touch while seeing it one game short.
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
    // The one-off repair writes scheduledAt straight back to the column. If this
    // carried postponed_from, that write would resurrect the cleared date and
    // leave the row claiming both a date and a postponement.
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
    // Nothing ties it to a night, so there is nowhere to put it.
    const nights = groupIntoNights(
      [row({ id: "nowhere", scheduled_at: null, postponed_from: null })],
      TODAY,
    );
    expect(nights).toEqual([]);
  });
});
