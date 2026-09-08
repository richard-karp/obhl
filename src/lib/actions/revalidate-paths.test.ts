import { describe, it, expect } from "vitest";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

/**
 * Convention guard, not a bug detector.
 *
 * Every route the actions revalidate now lives under `/[league]`, and there are
 * ~60 of these calls across 11 files. This catches the one that gets missed in a
 * sweep — a stale `/seasons` would fail silently, since a path that matches no
 * route simply revalidates nothing.
 *
 * It also enforces the `type` argument: Next requires it whenever the path
 * contains a dynamic segment, which every league-scoped path now does.
 */
/**
 * Every directory holding `revalidatePath` calls — NOT just the actions.
 *
 * ⚠️ `src/lib/games/shared.ts` was outside this scan, and it carries the score
 * pages' calls, two of which the `/manage/` flatten rewrote. So the guard written
 * to catch a missed rewrite did not cover the file most likely to have one. A
 * review caught it; the fix is the second entry.
 *
 * A file added elsewhere is still invisible here. The `calls.length` sentinel
 * below is what stops that going unnoticed for long — it is a floor on the total,
 * so a new call site outside these directories does not lower it, but a
 * directory disappearing from the scan does.
 */
const CALL_DIRS = ["src/lib/actions", "src/lib/games"].map((d) =>
  join(process.cwd(), d),
);

/**
 * Paths that are legitimately outside a league: the root landing page, and the
 * League Office. The office is instance-wide staff — it belongs to no league by
 * design, and lives outside `[league]` for that reason — so a league-scoped path
 * would revalidate the wrong thing, or nothing at all.
 */
const ROOT_ALLOWLIST = new Set(["/", "/manage/office"]);

/**
 * Every URL a route file in `src/app` actually serves.
 *
 * ⛔ THE ASSERTION THE REST OF THIS FILE WAS MISSING. Every check above is about
 * the SHAPE of a path — that it is league-scoped, typed, not interpolated, not
 * under the dead `/manage/` prefix. A path can satisfy all of them and still
 * name no route at all, which is precisely how a stale path fails: silently,
 * revalidating nothing. A rename anywhere in `src/app` leaves exactly that
 * behind, and until this walk existed nothing here would have reported it.
 *
 * Route groups — `(public)`, `(manage)` — and parallel-route slots (`@modal`)
 * are directories that contribute no URL segment, so they are traversed and
 * dropped rather than joined; an intercepting route's `(.)` marker is stripped.
 * Dynamic segments are kept verbatim, because a `revalidatePath` names the
 * PATTERN (`/[league]/games/[gameId]`) and not a filled-in URL.
 *
 * The root is a parameter so the walk's own edge cases can be exercised
 * against a fixture instead of only against the real `src/app`.
 */
function appRoutes(appDir = join(process.cwd(), "src/app")): Set<string> {
  // ⚠️ `layout` IS DELIBERATELY NOT HERE. A directory holding only a layout
  // serves no URL, so counting it would let the assertion below accept a path
  // that names nothing — the one direction that makes this test weaker rather
  // than noisier. No route in the tree is layout-only today, so dropping it
  // changes nothing now and keeps the set honest if one ever is.
  const isRouteFile = (f: string) => /^(page|route)\.(tsx?|jsx?)$/.test(f);
  const routes = new Set<string>();
  if (readdirSync(appDir).some(isRouteFile)) routes.add("/");
  const walk = (dir: string, url: string) => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (!statSync(full).isDirectory()) continue;
      // `_private` folders are not routes and hold none.
      if (entry.startsWith("_")) continue;
      // Two kinds of directory contribute no URL segment: route groups
      // `(marketing)` and parallel-route slots `@modal`. Both are traversed —
      // their children ARE routes — and neither is joined into the path.
      const noSegment =
        (entry.startsWith("(") && entry.endsWith(")")) || entry.startsWith("@");
      // An intercepting route's `(.)` / `(..)` / `(...)` marker is not part of
      // the URL it serves.
      const seg = entry.replace(/^\(\.{1,3}\)/, "");
      const next = noSegment ? url : `${url}/${seg}`;
      if (readdirSync(full).some(isRouteFile)) {
        routes.add(next === "" ? "/" : next);
        // An optional catch-all serves its parent path too.
        if (/^\[\[\.\.\..+\]\]$/.test(seg)) routes.add(url === "" ? "/" : url);
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
    // The failure mode this file exists to catch, made catchable. The prefix was
    // flattened away in one sweep of ~240 strings; a `revalidatePath` the sweep
    // missed still starts with "/[league]" and so satisfied every other
    // assertion here, while silently revalidating nothing — which is exactly how
    // a stale path fails. There are none today; this is what keeps that true.
    // Segment-anchored: a future `/[league]/managers` route is not a stale path.
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
      // ⛔ BOTH HALVES MATTER. A walk that silently returned an empty set would
      // make the next test vacuous in one direction; one that matched anything
      // would make it vacuous in the other. So: it found a real tree, it holds
      // a path we know exists, and it REJECTS one we know does not.
      expect(routes.size).toBeGreaterThan(20);
      expect(routes.has("/[league]/schedule")).toBe(true);
      expect(routes.has("/[league]/no-such-route")).toBe(false);
    });

    it("maps every App Router directory convention to the right URL", () => {
      // ⛔ AGAINST A FIXTURE, NOT `src/app`. These conventions do not all appear
      // in this repo, so the only way to know the walk handles them is to build
      // a tree that has them — which is why `appRoutes` takes its root. Each
      // one of these silently produced a wrong URL before this test existed.
      const root = mkdtempSync(join(tmpdir(), "approutes-"));
      const page = (...seg: string[]) => {
        const dir = join(root, ...seg);
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, "page.tsx"), "export default () => null;");
      };
      try {
        page("(marketing)", "about"); // group: contributes no segment
        page("@modal", "photo"); // parallel slot: contributes no segment
        page("(.)preview"); // intercepting: marker stripped
        page("shop", "[[...rest]]"); // optional catch-all: also serves parent
        page("[league]", "games", "[gameId]"); // dynamic: kept verbatim
        mkdirSync(join(root, "chrome"), { recursive: true });
        writeFileSync(join(root, "chrome", "layout.tsx"), "export default 0;");
        page("_internal"); // private: not a route at all

        expect([...appRoutes(root)].sort()).toEqual(
          [
            "/preview", // the intercepting marker is not part of the URL
            "/[league]/games/[gameId]",
            "/about",
            "/photo",
            "/shop",
            "/shop/[[...rest]]",
          ].sort(),
        );
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });

    it("revalidates a path that names a real route", () => {
      // The failure this catches: a route is renamed, the `revalidatePath` that
      // pointed at it is missed, and the call now refreshes nothing. Every other
      // assertion in this file still passes — the string is league-scoped, typed
      // and uninterpolated. Only this one looks at whether the route is there.
      const unresolved = calls
        .filter((c) => !routes.has(c.path))
        .map((c) => `${c.path} (${c.file})`);
      expect(unresolved).toEqual([]);
    });
  });
});
