/**
 * What the rosters-only import REPORTS, and when it redirects instead.
 *
 * ⚠️ The database and the HTML parser are stubbed. This proves which failures
 * get recorded and which block the redirect — nothing about the writes, and
 * nothing about the parser (`esportsdesk.test.ts` covers that).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ParsedLeague } from "@/lib/import/esportsdesk";

// ── The boundaries ─────────────────────────────────────────────────────────

const fetchLeague = vi.fn<() => Promise<ParsedLeague>>();
const addMembership =
  vi.fn<() => Promise<{ ok: boolean; error: string | null }>>();
const redirected = vi.fn<(path: string, type?: string) => void>();

/**
 * `redirect` THROWS in production — that is the whole reason both actions have
 * to call it outside a `try`. The stub throws too, so a regression that moves it
 * inside one shows up here as a swallowed redirect (the action returning a
 * message instead), which is exactly how it would fail for real.
 */
class RedirectSignal extends Error {}
vi.mock("next/navigation", () => ({
  // ⚠️ BOTH ARGUMENTS. Taking only `path` left `RedirectType.replace` unpinned
  // — swapping it for `push` survived — and the ⛔ note at the redirect argues
  // specifically for `replace`, since Back would otherwise land on a blank form
  // for a league that already exists.
  redirect: (path: string, type?: string) => {
    redirected(path, type);
    throw new RedirectSignal(path);
  },
  RedirectType: { replace: "replace", push: "push" },
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/auth/guards", () => ({
  requireManager: () => Promise.resolve({ id: "mgr-1" }),
}));
vi.mock("@/lib/audit", () => ({ logAudit: () => Promise.resolve() }));
vi.mock("@/lib/auth/membership", () => ({
  addLeagueMembership: () => addMembership(),
}));
vi.mock("@/lib/import/esportsdesk", async (importOriginal) => {
  // `parseEsportsdeskUrl` is pure and is part of what we are testing the action
  // against — only the network call is replaced.
  const real =
    await importOriginal<typeof import("@/lib/import/esportsdesk")>();
  return {
    ...real,
    fetchEsportsdeskLeague: () => fetchLeague(),
  };
});

// ── The admin client fake ──────────────────────────────────────────────────

type Query = { table: string; verb: string; single: boolean };
type Result = { data?: unknown; error?: { message: string } | null };

/**
 * Per-test overrides, keyed `"<table>.<verb>"`. Anything unset succeeds.
 *
 * An ARRAY is consumed one entry per call, which is what lets a test fail some
 * of a table's writes and not others. A single object applies to every call.
 * ⛔ Without the array form every "N of M" assertion had N === M, so the
 * denominators in those messages — the number that tells a manager how much
 * they lost — were pinned by nothing.
 */
let responses: Record<string, Result | Result[]> = {};
/** Ids handed back by inserts, so the action's own bookkeeping stays coherent. */
let nextId = 0;

function defaultFor(q: Query): Result {
  if (q.single) return { data: { id: `${q.table}-${++nextId}` }, error: null };
  if (q.verb === "insert" && q.table === "players")
    return { data: lastPlayerIds, error: null };
  return { data: [], error: null };
}

/** Ids returned for the most recent `players` insert, sized to the payload. */
let lastPlayerIds: { id: string }[] = [];

function makeAdmin() {
  const build = (table: string) => {
    const q: Query = { table, verb: "", single: false };
    const chain = {
      insert(payload: unknown) {
        q.verb = "insert";
        if (table === "players" && Array.isArray(payload))
          lastPlayerIds = payload.map(() => ({ id: `player-${++nextId}` }));
        return chain;
      },
      upsert() {
        q.verb = "upsert";
        return chain;
      },
      delete() {
        q.verb = "delete";
        return chain;
      },
      select() {
        if (!q.verb) q.verb = "select";
        return chain;
      },
      eq: () => chain,
      single() {
        q.single = true;
        return chain;
      },
      then(resolve: (r: Result) => unknown) {
        const key = `${q.table}.${q.verb}`;
        const queued = responses[key];
        // A queue that has run dry falls through to the default, so a test only
        // has to describe the calls it cares about.
        const out = Array.isArray(queued)
          ? (queued.shift() ?? defaultFor(q))
          : (queued ?? defaultFor(q));
        return Promise.resolve(out).then(resolve);
      },
    };
    return chain;
  };
  return { from: (table: string) => build(table) };
}
vi.mock("@/utils/supabase/admin", () => ({
  createAdminClient: () => makeAdmin(),
}));

// ── Fixtures ───────────────────────────────────────────────────────────────

const URL_OK =
  "https://www.esportsdesk.com/leagues/teams.cfm?clientID=1&leagueID=2";

const team = (name: string, players = 2): ParsedLeague["teams"][number] => ({
  sourceTeamId: name,
  name,
  players: Array.from({ length: players }, (_, i) => ({
    number: i + 1,
    firstName: "First",
    lastName: `${name}${i}`,
    isCaptain: false,
    position: "F" as const,
  })),
});

const league = (teams = ["Otters", "Bears"]): ParsedLeague => ({
  clientId: "1",
  leagueId: "2",
  leagueName: "Source League",
  season: null,
  seasons: [],
  teams: teams.map((t) => team(t)),
});

const form = (over: Record<string, string> = {}) => {
  const fd = new FormData();
  fd.set("url", URL_OK);
  fd.set("league_name", "New League");
  fd.set("season_name", "Imported Season");
  for (const [k, v] of Object.entries(over)) fd.set(k, v);
  return fd;
};

/** Run an action and report which way it ended, without the throw escaping. */
async function run(
  action: (p: null, f: FormData) => Promise<unknown>,
  fd = form(),
) {
  try {
    const state = await action(null, fd);
    return {
      redirected: false as const,
      state: state as Record<string, unknown>,
    };
  } catch (e) {
    if (e instanceof RedirectSignal)
      return { redirected: true as const, to: e.message };
    throw e;
  }
}

beforeEach(() => {
  vi.clearAllMocks();
  responses = {};
  nextId = 0;
  lastPlayerIds = [];
  fetchLeague.mockResolvedValue(league());
  addMembership.mockResolvedValue({ ok: true, error: null });
});

// ── The rosters-only importer ──────────────────────────────────────────────

describe("runRosterOnlyImport", () => {
  it("redirects into the new league when every roster landed", async () => {
    const { runRosterOnlyImport } = await import("./import-rosters");
    const r = await run(runRosterOnlyImport);
    expect(r.redirected).toBe(true);
    // ⚠️ The type too: `replace`, not the server-action default of `push`.
    expect(redirected).toHaveBeenCalledWith("/new-league/seasons", "replace");
  });

  it("reports a shortfall instead of redirecting", async () => {
    const { runRosterOnlyImport } = await import("./import-rosters");
    responses["teams.insert"] = { data: null, error: { message: "nope" } };
    const r = await run(runRosterOnlyImport);
    expect(r.redirected).toBe(false);
    if (r.redirected) return;
    expect(r.state.message).toMatch(/2 of 2 teams did not import cleanly/);
  });

  it("does not claim a shortfall when only the membership grant failed", async () => {
    // ⛔ THE REGRESSION THIS PINS: with the shortfall unconditional, a
    // membership-only failure read "0 of 2 teams did not import cleanly:"
    // followed by nothing.
    const { runRosterOnlyImport } = await import("./import-rosters");
    addMembership.mockResolvedValue({ ok: false, error: "rls refused" });
    const r = await run(runRosterOnlyImport);
    expect(r.redirected).toBe(false);
    if (r.redirected) return;
    expect(r.state.message).not.toMatch(/did not import cleanly/);
    // ⚠️ POSITIVE, not only the negative above. Asserting what the message does
    // NOT say left `${accessWarning}` unpinned in this file — deleting it kept
    // every test green, which is the same interpolation bug already fixed twice
    // in `import.ts`.
    expect(r.state.message).toMatch(/You were NOT added to this league/);
    expect(r.state.canOpen).toBe(false);
    expect(r.state.slug).toBe("new-league");
  });
});
