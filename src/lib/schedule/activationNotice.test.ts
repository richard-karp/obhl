import { describe, it, expect } from "vitest";
import { needsActivation, type SeasonStamp } from "./activationNotice";

/**
 * ⛔ THE CASE THIS FILE EXISTS TO KEEP APART. "Published but not active" covers
 * two opposite situations, and the notice is right in one and harmful in the
 * other:
 *
 *   - the league's active season is OLDER than this one — next season is built
 *     and published and somebody forgot to flip it live. Warn.
 *   - the league's active season is NEWER than this one — this is a retired
 *     season, and the banner's one-click button would drag the public site back
 *     onto it. Stay quiet.
 *
 * A single "is some other season active?" boolean cannot tell those apart, and
 * an earlier version of this predicate used one. It suppressed both, which made
 * the notice unreachable for every league that had ever activated anything —
 * caught by CI, because the e2e asserting the banner could no longer see it.
 */

/** Spring 2026 — the league's long-running season. */
const SPRING: SeasonStamp = {
  startsOn: "2026-05-01",
  createdAt: "2026-01-10T00:00:00Z",
};
/** Fall 2026 — the one being built now. */
const FALL: SeasonStamp = {
  startsOn: "2026-09-15",
  createdAt: "2026-08-01T00:00:00Z",
};

const q = (over: {
  isActive?: boolean;
  liveCount?: number;
  readFailed?: boolean;
  thisSeason?: SeasonStamp;
  activeSeason?: SeasonStamp | null | "unreadable";
}) =>
  needsActivation({
    isActive: false,
    liveCount: 42,
    readFailed: false,
    thisSeason: FALL,
    activeSeason: null,
    ...over,
  });

describe("needsActivation — published games the public site never shows", () => {
  it("warns when the league has no active season at all", () => {
    // The original case: a league's first season, published and never flipped
    // live, so every public page reads "No active season".
    expect(q({ activeSeason: null })).toBe(true);
  });

  it("warns when the active season is OLDER — next season built and forgotten", () => {
    // Spring is still live while Fall sits published and invisible. The site
    // looks coherent, which is exactly why nobody notices.
    expect(q({ thisSeason: FALL, activeSeason: SPRING })).toBe(true);
  });

  it("stays quiet when the active season is NEWER — this one is retired", () => {
    // ⛔ THE ARCHIVE GUARD. Every row of /<league>/seasons links to a setup
    // page, so without this the banner appears on every season a league ever
    // retired, offering an unconfirmed activation that would drag the public
    // site back onto a finished season.
    expect(q({ thisSeason: SPRING, activeSeason: FALL })).toBe(false);
  });

  it("stays quiet when the active season could not be read", () => {
    // ⛔ ITS OWN ANSWER, not folded into null. `null` means "nothing is active",
    // which WARNS — so treating an errored read as null would fire a banner
    // carrying a destructive button on information nobody has. Same discipline
    // as `staleDraftFor`'s "unreadable".
    expect(q({ activeSeason: "unreadable" })).toBe(false);
  });

  it("stays quiet on the active season itself", () => {
    expect(q({ isActive: true })).toBe(false);
  });

  it("stays quiet before anything is published", () => {
    expect(q({ liveCount: 0 })).toBe(false);
  });

  it("stays quiet when a SIBLING read failed and the count is half a picture", () => {
    // ⛔ NOT "the count could not be read". `getPublishState` takes `liveCount`
    // from one read and `readFailed` from six, so when the count's own read
    // fails `liveCount` is already 0 and this guard is dead. It earns its place
    // in the opposite case: the count is accurate, something else errored.
    expect(q({ readFailed: true })).toBe(false);
  });

  describe("ordering matches getLeagueSeasons — starts_on desc, nulls last", () => {
    const NO_START: SeasonStamp = {
      startsOn: null,
      createdAt: "2026-06-01T00:00:00Z",
    };

    it("treats a null start as OLDER than any dated season", () => {
      // `nullsFirst: false` on a descending sort puts undated seasons last, so
      // they are the oldest. An undated active season therefore reads as a
      // forgotten one rather than an archive.
      expect(q({ thisSeason: FALL, activeSeason: NO_START })).toBe(true);
    });

    it("treats a dated active season as NEWER than this undated one", () => {
      expect(q({ thisSeason: NO_START, activeSeason: FALL })).toBe(false);
    });

    it("falls back to created_at when neither season has a start date", () => {
      const older: SeasonStamp = {
        startsOn: null,
        createdAt: "2026-01-01T00:00:00Z",
      };
      const newer: SeasonStamp = {
        startsOn: null,
        createdAt: "2026-07-01T00:00:00Z",
      };
      expect(q({ thisSeason: newer, activeSeason: older })).toBe(true);
      expect(q({ thisSeason: older, activeSeason: newer })).toBe(false);
    });

    it("falls back to created_at when the two share a start date", () => {
      const a: SeasonStamp = {
        startsOn: "2026-09-15",
        createdAt: "2026-01-01T00:00:00Z",
      };
      const b: SeasonStamp = {
        startsOn: "2026-09-15",
        createdAt: "2026-07-01T00:00:00Z",
      };
      expect(q({ thisSeason: b, activeSeason: a })).toBe(true);
      expect(q({ thisSeason: a, activeSeason: b })).toBe(false);
    });

    it("stays quiet on an exact tie — neither is newer, so nothing is archived", () => {
      // Same stamps on two different seasons is a degenerate fixture rather
      // than a real state, but it must not fall through to a warning by
      // accident: an unordered pair is not evidence that this one was forgotten.
      expect(q({ thisSeason: FALL, activeSeason: { ...FALL } })).toBe(false);
    });
  });
});
