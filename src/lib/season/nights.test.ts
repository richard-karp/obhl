import { describe, it, expect } from "vitest";
import {
  NIGHT_LABEL,
  NIGHT_LONG,
  hasMultipleNights,
  resolveSeasonNights,
} from "./nights";

describe("resolveSeasonNights", () => {
  it("uses what the season stored, ignoring the games", () => {
    // The stored value is a DECLARATION — the nights the league books — and it
    // is what the manager ticked when they built the schedule. A season that
    // has so far only played Tuesdays still plays Thursdays.
    expect(resolveSeasonNights([2, 4], [2])).toEqual([2, 4]);
  });

  it("falls back to the weekdays the published games actually fall on", () => {
    // For a season nobody built here — the importer writes games without ever
    // running the generator — the games are the only statement there is.
    expect(resolveSeasonNights([], [1, 4])).toEqual([1, 4]);
    expect(resolveSeasonNights(null, [3])).toEqual([3]);
  });

  it("is empty when the season has neither", () => {
    expect(resolveSeasonNights([], [])).toEqual([]);
    expect(resolveSeasonNights(null, [])).toEqual([]);
  });

  it("sorts and de-duplicates whichever source it used", () => {
    expect(resolveSeasonNights([4, 2, 4], [])).toEqual([2, 4]);
    expect(resolveSeasonNights([], [6, 1, 6, 1])).toEqual([1, 6]);
  });
});

describe("hasMultipleNights", () => {
  // ⛔ THIS BOOLEAN GATES EVERY PIECE OF NIGHT UI — the roster column, the
  // dialog's select, the public team page. Exactly-one must be false or a
  // single-night league grows a control that can only ever say one thing.
  it("is false for none and for exactly one, true from two", () => {
    expect(hasMultipleNights([])).toBe(false);
    expect(hasMultipleNights([2])).toBe(false);
    expect(hasMultipleNights([2, 4])).toBe(true);
    expect(hasMultipleNights([1, 3, 5])).toBe(true);
  });
});

describe("night labels", () => {
  it("indexes by day-of-week, Sunday first", () => {
    // Must agree with `leagueWeekday()` and the `night_of_week` column, which
    // are both 0=Sun.
    expect(NIGHT_LABEL[0]).toBe("Sun");
    expect(NIGHT_LABEL[2]).toBe("Tue");
    expect(NIGHT_LABEL[4]).toBe("Thu");
    expect(NIGHT_LONG[0]).toBe("Sunday");
    expect(NIGHT_LONG[4]).toBe("Thursday");
    expect(NIGHT_LABEL).toHaveLength(7);
    expect(NIGHT_LONG).toHaveLength(7);
  });
});
