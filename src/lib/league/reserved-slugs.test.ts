import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
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
  const DIR = join(process.cwd(), "supabase/migrations");
  const CONSTRAINT =
    /leagues_slug_not_reserved\s*\n?\s*check \(slug not in \(([^)]*)\)\)/;

  /**
   * The slugs in the constraint AS IT NOW STANDS, which means the LAST
   * migration that defines it, not the first.
   *
   * ⛔ This used to read `0030_league_slug_reserved.sql` by name. That is the
   * migration which created the constraint, and it stopped being the one that
   * defines it the moment `0047` dropped and re-added it to add
   * `set-password` — so this guard, whose entire job is catching drift between
   * the two lists, would itself have compared against a stale copy and passed
   * while they diverged. Scanning in filename order fixes that for every future
   * redefinition too.
   */
  const sql = (() => {
    const hits = readdirSync(DIR)
      .filter((f) => f.endsWith(".sql"))
      .sort()
      .map((f) => readFileSync(join(DIR, f), "utf8"))
      .filter((text) => CONSTRAINT.test(text));
    if (!hits.length)
      throw new Error("no migration defines leagues_slug_not_reserved");
    return hits[hits.length - 1];
  })();

  /** The quoted slugs inside `check (slug not in (...))`. */
  const inConstraint = (() => {
    const m = sql.match(CONSTRAINT);
    if (!m) throw new Error("could not find the reserved-slug constraint");
    return [...m[1].matchAll(/'([^']*)'/g)].map((x) => x[1]).sort();
  })();

  it("lists exactly the same slugs, in both directions", () => {
    expect(inConstraint).toEqual([...RESERVED_LEAGUE_SLUGS].sort());
  });

  it("also refuses an empty slug, which no reserved list would catch", () => {
    // ⚠️ Across ALL migrations, not the one above. `sql` is now whichever
    // migration last defines the RESERVED constraint, and the empty-slug rule
    // is a separate constraint added in 0030 — tying this assertion to the same
    // file made it fail the moment the two stopped being defined together.
    const all = readdirSync(DIR)
      .filter((f) => f.endsWith(".sql"))
      .sort()
      .map((f) => readFileSync(join(DIR, f), "utf8"));
    expect(
      all.some((t) => /add constraint\s+leagues_slug_not_empty/.test(t)),
    ).toBe(true);
    // And nothing later takes it away again.
    expect(
      all.some((t) => /drop constraint\s+leagues_slug_not_empty/.test(t)),
    ).toBe(false);
  });
});
