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
 * The same list lives in the database, where hand-written SQL creates leagues too.
 * Two copies drift; this is what stops them.
 */
describe("the database constraint matches this list", () => {
  const DIR = join(process.cwd(), "supabase/migrations");
  const CONSTRAINT =
    /leagues_slug_not_reserved\s*\n?\s*check \(slug not in \(([^)]*)\)\)/;

  /**
   * ⛔ The LAST migration defining the constraint, never `0030` by name: `0047` redefined it,
   * and a stale copy would pass while the two lists diverge.
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
    // ⚠️ Across all migrations, not `sql`: the empty-slug rule is a separate constraint,
    // no longer defined in the same file as the reserved list.
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
