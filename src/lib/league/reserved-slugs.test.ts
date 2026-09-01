import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { RESERVED_LEAGUE_SLUGS, isReservedLeagueSlug } from "./reserved-slugs";

describe("isReservedLeagueSlug", () => {
  it("rejects every reserved slug", () => {
    for (const slug of RESERVED_LEAGUE_SLUGS) {
      expect(isReservedLeagueSlug(slug)).toBe(true);
    }
  });

  it("rejects regardless of case or surrounding space", () => {
    // Lookup lower-cases the URL, so `/Login` would shadow a league too.
    expect(isReservedLeagueSlug("Login")).toBe(true);
    expect(isReservedLeagueSlug("  API  ")).toBe(true);
  });

  it("allows an ordinary league slug", () => {
    for (const slug of ["obhl", "harbor", "oceanview", "api-west", "logins"]) {
      expect(isReservedLeagueSlug(slug)).toBe(false);
    }
  });
});

/**
 * The same list lives in the database, because leagues are created by
 * hand-written SQL as often as by the importer. Two copies drift; this is what
 * stops them.
 */
describe("the database constraint matches this list", () => {
  const sql = readFileSync(
    join(process.cwd(), "supabase/migrations/0030_league_slug_reserved.sql"),
    "utf8",
  );

  /** The quoted slugs inside `check (slug not in (...))`. */
  const inConstraint = (() => {
    const m = sql.match(/leagues_slug_not_reserved\s*\n?\s*check \(slug not in \(([^)]*)\)\)/);
    if (!m) throw new Error("could not find the reserved-slug constraint");
    return [...m[1].matchAll(/'([^']*)'/g)].map((x) => x[1]).sort();
  })();

  it("lists exactly the same slugs, in both directions", () => {
    expect(inConstraint).toEqual([...RESERVED_LEAGUE_SLUGS].sort());
  });

  it("also refuses an empty slug, which no reserved list would catch", () => {
    expect(sql).toMatch(/leagues_slug_not_empty/);
  });
});
