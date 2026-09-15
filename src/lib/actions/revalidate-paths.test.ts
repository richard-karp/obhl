import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

// ⚠️ Every directory holding `revalidatePath` calls, not only the actions. A call elsewhere is
// invisible here; the `calls.length` floor catches a directory dropping out of the scan.
const CALL_DIRS = ["src/lib/actions", "src/lib/games"].map((d) =>
  join(process.cwd(), d),
);

// Paths legitimately outside a league: the landing page, and the League Office, which belongs to
// no league.
const ROOT_ALLOWLIST = new Set(["/", "/manage/office"]);

// Every URL pattern a route file in `src/app` serves. Route groups and `@slots` add no segment;
// dynamic segments stay verbatim, since `revalidatePath` names the pattern.
function appRoutes(appDir = join(process.cwd(), "src/app")): Set<string> {
  // ⚠️ `layout` is not a route file: a layout-only directory serves no URL, and counting one would
  // let a path naming nothing pass.
  const isRouteFile = (f: string) => /^(page|route)\.(tsx?|jsx?)$/.test(f);
  const routes = new Set<string>();
  if (readdirSync(appDir).some(isRouteFile)) routes.add("/");
  const walk = (dir: string, url: string) => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (!statSync(full).isDirectory()) continue;
      // `_private` opts its whole subtree out, so it is skipped, not descended.
      if (entry.startsWith("_")) continue;
      // ⛔ An intercepting route is skipped whole: it re-renders a path another directory registers,
      // and `(..)` points up a level, so joining its segment adds paths nothing serves.
      if (/^\(\.{1,3}\)/.test(entry)) continue;
      // Route groups `(marketing)` and parallel-route slots `@modal` contribute
      // no segment, but their children ARE routes, so both are traversed.
      const noSegment =
        (entry.startsWith("(") && entry.endsWith(")")) || entry.startsWith("@");
      const next = noSegment ? url : `${url}/${entry}`;
      if (readdirSync(full).some(isRouteFile)) {
        routes.add(next === "" ? "/" : next);
        // An optional catch-all serves its parent path too.
        if (/^\[\[\.\.\..+\]\]$/.test(entry))
          routes.add(url === "" ? "/" : url);
      }
      walk(full, next);
    }
  };
  walk(appDir, "");
  return routes;
}

type Call = { file: string; path: string; type: string | null };

function revalidateCalls(): Call[] {
  const calls: Call[] = [];
  for (const dir of CALL_DIRS)
    for (const file of readdirSync(dir)) {
      if (!file.endsWith(".ts") || file.endsWith(".test.ts")) continue;
      const src = readFileSync(join(dir, file), "utf8");
      // First argument only: a string literal or a template literal.
      const re =
        /revalidatePath\(\s*(?:"([^"]*)"|`([^`]*)`)\s*(?:,\s*"(page|layout)")?/g;
      for (const m of src.matchAll(re)) {
        calls.push({ file, path: m[1] ?? m[2], type: m[3] ?? null });
      }
    }
  return calls;
}

// A `revalidatePath` naming no route fails silently, so every call is checked for league scope, a
// `type` beside dynamic segments, and a real route.
describe("revalidatePath conventions", () => {
  const calls = revalidateCalls();

  it("finds the calls at all, so a passing suite means something", () => {
    expect(calls.length).toBeGreaterThan(40);
  });

  it("targets a league-scoped route, or an explicitly allowed root path", () => {
    const stray = calls.filter(
      (c) => !c.path.startsWith("/[league]") && !ROOT_ALLOWLIST.has(c.path),
    );
    expect(stray).toEqual([]);
  });

  it("names no route under the removed /manage/ prefix", () => {
    // A missed `/[league]/manage` still passes the league-scope check while revalidating nothing.
    // Segment-anchored: a future `/[league]/managers` route is not stale.
    const stale = calls.filter(
      (c) =>
        c.path === "/[league]/manage" || c.path.startsWith("/[league]/manage/"),
    );
    expect(stale).toEqual([]);
  });

  it("passes a type alongside every path with a dynamic segment", () => {
    const untyped = calls.filter(
      (c) => c.path.includes("[") && c.type === null,
    );
    expect(untyped).toEqual([]);
  });

  it("never interpolates an id into the path", () => {
    // A literal `/seasons/<uuid>` only refreshes that one page and reads as
    // though the id mattered; the route pattern plus `type` covers all of them.
    const interpolated = calls.filter((c) => c.path.includes("${"));
    expect(interpolated).toEqual([]);
  });

  describe("resolves against the real route tree", () => {
    const routes = appRoutes();

    it("finds the routes at all, and is not merely permissive", () => {
      // ⛔ Both halves: an empty walk makes the next test vacuous one way, a permissive one the
      // other, so it must hold a known route and reject a missing one.
      expect(routes.size).toBeGreaterThan(20);
      expect(routes.has("/[league]/schedule")).toBe(true);
      expect(routes.has("/[league]/no-such-route")).toBe(false);
    });

    it("revalidates a path that names a real route", () => {
      // The only check that the route exists: a renamed route leaves a league-scoped, typed,
      // uninterpolated call that refreshes nothing.
      const unresolved = calls
        .filter((c) => !routes.has(c.path))
        .map((c) => `${c.path} (${c.file})`);
      expect(unresolved).toEqual([]);
    });
  });
});
