import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * Convention guard, not a bug detector — a sibling of `revalidate-paths.test.ts`.
 *
 * Access control is now two questions: the role says what an account may do,
 * membership (`profile_leagues`) says which leagues it may do it in. The second
 * one is easy to forget, and forgetting it fails *open*: the page renders, the
 * action writes, and every existing test still passes, because the suite signs
 * in as a manager who belongs to every league.
 *
 * The e2e suite proves the guards that a browser can reach. It cannot reach a
 * server action with an id from another league — that needs a hand-made POST —
 * so this is what stands behind those: a new action wired to the role-only
 * guards is a test failure rather than a silent hole.
 */
const ACTIONS_DIR = join(process.cwd(), "src/lib/actions");
const MANAGE_DIR = join(process.cwd(), "src/app/[league]/manage");

/**
 * Files allowed to use the role-only guards, with the count they may use, so
 * adding one more still fails. Only league *creation* qualifies: it is the
 * single act with no league to be a member of yet. Both importers grant the
 * creating manager membership as their first write instead, and
 * `previewEsportsdeskImport` only fetches an external URL and writes nothing.
 */
const ROLE_ONLY_ALLOWED: Record<string, number> = {
  "import.ts": 2,
  // runRosterOnlyImport creates the league it would otherwise be guarded
  // against — the same exemption import.ts has, for the same reason.
  "import-rosters.ts": 1,
};

/**
 * What counts as reaching a guard.
 *
 * Not every action calls one directly: six of them go through a wrapper that
 * resolves the league first and then guards, so the wrappers are listed too.
 * **A new wrapper must be added here**, or the actions behind it read as
 * unguarded — and the fix for that failure is to check the wrapper actually
 * guards, not to add the name reflexively.
 */
const GUARD_CALLS = [
  "requireLeagueManager(",
  "requireLeagueManagerOf(",
  "requireLeagueRole(",
  // games.ts — resolves the game's league, then requireLeagueRole.
  "requireGameRole(",
  // schedule.ts — resolves the season's league, then requireLeagueManager.
  "targetSeasonForManager(",
];

/**
 * Actions with no league to be guarded against, and why. Anything not listed
 * here has to reach a guard.
 */
const NO_LEAGUE_ACTIONS: Record<string, string> = {
  "auth.ts:sendMagicLink": "sign-in happens before any league is known",
  "auth.ts:signOut": "ends a session; touches no league data",
  "auth.ts:devSignIn": "sign-in happens before any league is known",
  "import.ts:previewEsportsdeskImport": "fetches an external URL and writes nothing",
  "import.ts:runEsportsdeskImport": "creates the league it would be guarded against",
  "import-rosters.ts:runRosterOnlyImport":
    "creates the league it would be guarded against",
  // The office is instance-wide and belongs to no league, so there is no league
  // to be a member of. These are NOT unguarded: both call `requireCommissioner`,
  // and the test below insists on it, so this allowlist cannot become a way in.
  "office.ts:appointDeputy": "no league; guarded by requireCommissioner",
  "office.ts:removeDeputy": "no league; guarded by requireCommissioner",
  "office.ts:setStaffPassword": "no league; guarded by requireCommissioner",
};

/**
 * The office's own guard, since the league one does not apply to it.
 *
 * Without this, listing an action in `NO_LEAGUE_ACTIONS` would exempt it from
 * every check in this file — and the next office action added would only have to
 * be named there to pass with no guard at all. "Has no league" must not be
 * allowed to mean "needs no guard".
 */
const OFFICE_ACTIONS_FILE = "office.ts";

/**
 * Any of these means the file asked the league question. Anchored on `await`
 * so an import left behind by a deleted guard cannot satisfy the check — it is
 * still a text match, not a call graph, but it has to be a call.
 */
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

/**
 * Every `export async function` in an actions file, with its body.
 *
 * Split on the next export, so a non-exported helper defined between two
 * actions is attributed to the one above it. That can only ever make an
 * unguarded action look guarded, never the reverse — worth knowing, and worth
 * not putting a guard call in such a helper.
 */
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
    // The check the two roster bugs needed. Its predecessor only asked whether
    // a file used the OLD guards, so an action added with no guard at all —
    // the likelier mistake now that the old ones are nearly gone — passed.
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
