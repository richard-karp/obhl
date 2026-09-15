import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

// Every action and manage page must ask the membership question: forgetting it fails open, and
// e2e cannot send the hand-made cross-league POST that would show it.
const ACTIONS_DIR = join(process.cwd(), "src/lib/actions");
const MANAGE_DIR = join(process.cwd(), "src/app/[league]/(manage)");

// Files allowed role-only guards, with a count so one more still fails. Only league creation
// qualifies: there is no league to be a member of yet.
const ROLE_ONLY_ALLOWED: Record<string, number> = {
  "import.ts": 1,
  "import-rosters.ts": 1,
};

// Guards, plus the wrappers that resolve a league and then guard. Check that a new wrapper
// really guards before listing it: a listed name is trusted.
const GUARD_CALLS = [
  "requireLeagueManager(",
  "requireLeagueManagerOf(",
  "requireLeagueRole(",
  // games.ts — resolves the game's league, then requireLeagueRole.
  "requireGameRole(",
  // schedule.ts — resolves the season's league, then requireLeagueManager.
  "targetSeasonForManager(",
  // schedule-edits.ts — resolves the game's league, then requireLeagueRole("league_manager").
  "managerOfGame(",
];

// Actions with no league to be guarded against, and why. Anything not listed must reach a guard.
const NO_LEAGUE_ACTIONS: Record<string, string> = {
  "auth.ts:sendMagicLink": "sign-in happens before any league is known",
  "auth.ts:sendPasswordReset": "sign-in happens before any league is known",
  "auth.ts:signInWithPassword": "sign-in happens before any league is known",
  "auth.ts:updateOwnPassword":
    "sets the caller's own password; touches no league data",
  "auth.ts:signOut":
    "ends the caller's own session; its one league read goes through RLS and only its slug is used, to validate the redirect target",
  "auth.ts:devSignIn": "sign-in happens before any league is known",
  "import.ts:previewEsportsdeskImport":
    "fetches an external URL and writes nothing",
  "import-rosters.ts:runRosterOnlyImport":
    "creates the league it would be guarded against",
  // No league, but not unguarded: the test below requires `requireCommissioner` in each, so
  // this list cannot become a way in.
  "office.ts:appointDeputy": "no league; guarded by requireCommissioner",
  "office.ts:removeDeputy": "no league; guarded by requireCommissioner",
  "office.ts:setStaffPassword": "no league; guarded by requireCommissioner",
};

// The office's own guard check, so that "has no league" cannot mean "needs no guard".
const OFFICE_ACTIONS_FILE = "office.ts";

// Anchored on `await`, so an import left behind by a deleted guard cannot satisfy it.
const LEAGUE_GUARDS =
  /await require(LeagueManager|LeagueManagerOf|LeagueRole)\(|await isLeagueMember\(/;

function actionFiles(): string[] {
  return readdirSync(ACTIONS_DIR).filter(
    (f) => f.endsWith(".ts") && !f.endsWith(".test.ts"),
  );
}

function managePages(dir = MANAGE_DIR, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) managePages(full, out);
    else if (entry === "page.tsx") out.push(full);
  }
  return out;
}

const countRoleOnly = (src: string) =>
  (src.match(/requireManager\(\)|requireRole\(/g) ?? []).length;

// Split on the next export, so a helper between two actions counts toward the one above: never
// put a guard call in such a helper, or an unguarded action reads as guarded.
function exportedActions(file: string): { id: string; body: string }[] {
  const src = readFileSync(join(ACTIONS_DIR, file), "utf8");
  return src
    .split(/(?=^export async function )/m)
    .map((body) => {
      const name = /^export async function (\w+)/.exec(body)?.[1];
      return name ? { id: `${file}:${name}`, body } : null;
    })
    .filter((a): a is { id: string; body: string } => a !== null);
}

describe("league-scoped guards", () => {
  const pages = managePages();

  it("finds the files at all, so a passing suite means something", () => {
    expect(actionFiles().length).toBeGreaterThan(10);
    expect(pages.length).toBeGreaterThan(10);
  });

  it("finds the actions inside those files too", () => {
    expect(actionFiles().flatMap(exportedActions).length).toBeGreaterThan(20);
  });

  it("reaches a league guard from every action that has a league", () => {
    const unguarded = actionFiles()
      .flatMap(exportedActions)
      .filter(({ id, body }) => {
        if (id in NO_LEAGUE_ACTIONS) return false;
        return !GUARD_CALLS.some((call) => body.includes(`await ${call}`));
      })
      .map(({ id }) => id);
    expect(unguarded).toEqual([]);
  });

  it("guards every League Office action with requireCommissioner", () => {
    const actions = exportedActions(OFFICE_ACTIONS_FILE);
    // The file exists and has actions in it, so a green here means something.
    expect(actions.length).toBeGreaterThan(0);
    const unguarded = actions
      .filter(({ body }) => !body.includes("await requireCommissioner("))
      .map(({ id }) => id);
    expect(unguarded).toEqual([]);
  });

  it("uses no role-only guard in an action outside the allowlist", () => {
    const stray = actionFiles()
      .map((f) => ({
        file: f,
        count: countRoleOnly(readFileSync(join(ACTIONS_DIR, f), "utf8")),
      }))
      .filter(({ file, count }) => count > (ROLE_ONLY_ALLOWED[file] ?? 0));
    expect(stray).toEqual([]);
  });

  it("guards every manage page on its league", () => {
    const unguarded = pages
      .filter((p) => !LEAGUE_GUARDS.test(readFileSync(p, "utf8")))
      .map((p) => p.slice(MANAGE_DIR.length));
    expect(unguarded).toEqual([]);
  });

  it("uses no role-only guard in a manage page", () => {
    const stray = pages
      .filter((p) => countRoleOnly(readFileSync(p, "utf8")) > 0)
      .map((p) => p.slice(MANAGE_DIR.length));
    expect(stray).toEqual([]);
  });
});
