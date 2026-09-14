import { describe, it, expect } from "vitest";
import { needsActivation } from "./activationNotice";

/**
 * Four booleans, sixteen combinations, all of them here — each named for the
 * sentence it protects rather than for its inputs.
 *
 * ⛔ THE POINT OF EXHAUSTING THE TABLE. A partial table over four terms is
 * indistinguishable from a lucky one: dropping a term from the implementation
 * has to turn a NAMED case red, and it only can if the case isolating that term
 * exists. The table is written out rather than generated so each row can say
 * what it is for.
 *
 * ⚠️ THERE IS NO `started` INPUT, DELIBERATELY — an inactive season that has
 * already started still has games the public site does not show, which is the
 * worst version of this rather than an exempt one. That absence is enforced by
 * the type, not by any assertion here; a previous version of this file carried
 * a ninth case that claimed to "pin" it and was byte-identical to the first,
 * so it could not have failed unless the first did.
 */
const q = (
  isActive: boolean,
  liveCount: number,
  readFailed: boolean,
  leagueHasAnotherActiveSeason: boolean,
) =>
  needsActivation({
    isActive,
    liveCount,
    readFailed,
    leagueHasAnotherActiveSeason,
  });

describe("needsActivation — published games the public site never shows", () => {
  it("warns when a season has published games, is not active, and nothing else is", () => {
    // The whole reason this exists. `replace_published_schedule` promotes the
    // draft games and stops there; `is_active` is a different action, so a
    // manager who published and walked away has a schedule the site never shows.
    expect(q(false, 42, false, false)).toBe(true);
  });

  it("stays quiet on the active season, which is what the public already sees", () => {
    expect(q(true, 42, false, false)).toBe(false);
  });

  it("stays quiet before anything is published — nothing is being withheld yet", () => {
    // An inactive season mid-setup is not a problem, it is step three of four.
    expect(q(false, 0, false, false)).toBe(false);
  });

  it("stays quiet when a SIBLING read failed and the count is only half a picture", () => {
    // ⛔ NOT "the count could not be read". `getPublishState` takes `liveCount`
    // from one read and `readFailed` from six, so when the count's own read
    // fails `liveCount` is already 0 and this guard is dead. The case it exists
    // for is this one: the count is accurate, something else errored, and the
    // panel withholds rather than acting on a partial picture.
    expect(q(false, 42, true, false)).toBe(false);
  });

  it("stays quiet on a retired season, where the button would swap the live one", () => {
    // ⛔ THE ARCHIVE GUARD. Every row of /<league>/seasons links to a setup
    // page, so without this the banner appears on every season a league ever
    // retired, offering an unconfirmed one-click activation that would drag the
    // public site back to a finished season.
    expect(q(false, 42, false, true)).toBe(false);
  });

  it("stays quiet on a future season being prepared while this one runs", () => {
    // Same guard, the other direction in time: next season is built and
    // published early and deliberately not yet active. Nothing is wrong.
    expect(q(false, 120, false, true)).toBe(false);
  });

  // The remaining ten combinations. None can warn — each already trips at least
  // one guard above — and they are here so that removing any single term from
  // the implementation fails a named case rather than slipping through.
  it("stays quiet: active, with games, sibling read failed", () => {
    expect(q(true, 42, true, false)).toBe(false);
  });

  it("stays quiet: active, with games, another season also marked active", () => {
    expect(q(true, 42, false, true)).toBe(false);
  });

  it("stays quiet: active, with games, read failed, another active", () => {
    expect(q(true, 42, true, true)).toBe(false);
  });

  it("stays quiet: inactive, no games, read failed", () => {
    expect(q(false, 0, true, false)).toBe(false);
  });

  it("stays quiet: inactive, no games, another season active", () => {
    expect(q(false, 0, false, true)).toBe(false);
  });

  it("stays quiet: inactive, no games, read failed, another active", () => {
    expect(q(false, 0, true, true)).toBe(false);
  });

  it("stays quiet: active, no games", () => {
    expect(q(true, 0, false, false)).toBe(false);
  });

  it("stays quiet: active, no games, read failed", () => {
    expect(q(true, 0, true, false)).toBe(false);
  });

  it("stays quiet: active, no games, another season active", () => {
    expect(q(true, 0, false, true)).toBe(false);
  });

  it("stays quiet: active, no games, read failed, another active", () => {
    expect(q(true, 0, true, true)).toBe(false);
  });
});
