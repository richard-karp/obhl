import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

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
const ACTIONS_DIR = join(process.cwd(), "src/lib/actions");

/**
 * Paths that are legitimately outside a league: the root landing page, and the
 * League Office. The office is instance-wide staff — it belongs to no league by
 * design, and lives outside `[league]` for that reason — so a league-scoped path
 * would revalidate the wrong thing, or nothing at all.
 */
const ROOT_ALLOWLIST = new Set(["/", "/manage/office"]);

type Call = { file: string; path: string; type: string | null };

function revalidateCalls(): Call[] {
  const calls: Call[] = [];
  for (const file of readdirSync(ACTIONS_DIR)) {
    if (!file.endsWith(".ts") || file.endsWith(".test.ts")) continue;
    const src = readFileSync(join(ACTIONS_DIR, file), "utf8");
    // First argument only: a string literal or a template literal.
    const re = /revalidatePath\(\s*(?:"([^"]*)"|`([^`]*)`)\s*(?:,\s*"(page|layout)")?/g;
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

  it("passes a type alongside every path with a dynamic segment", () => {
    const untyped = calls.filter((c) => c.path.includes("[") && c.type === null);
    expect(untyped).toEqual([]);
  });

  it("never interpolates an id into the path", () => {
    // A literal `/seasons/<uuid>` only refreshes that one page and reads as
    // though the id mattered; the route pattern plus `type` covers all of them.
    const interpolated = calls.filter((c) => c.path.includes("${"));
    expect(interpolated).toEqual([]);
  });
});
