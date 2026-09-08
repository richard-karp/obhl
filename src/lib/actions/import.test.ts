/**
 * What an import REPORTS, and when it redirects instead.
 *
 * ⛔ THIS FILE EXISTS BECAUSE THREE REVIEW ROUNDS FOUND THREE BUGS HERE AND NO
 * TEST TOUCHED ANY OF THEM. The import path had no coverage at all: both e2e
 * import specs are network-free by design and stop at the form, so nothing ever
 * ran a completed import. Every defect was the same shape — a run that lost work
 * finished looking clean — and every one was caught by a person reading, twice
 * after the previous fix had "closed" it.
 *
 * ⚠️ IT DELIBERATELY DOES NOT TEST THE DATABASE OR THE HTML PARSER. Those
 * boundaries are stubbed, and that is the point rather than a shortcut: none of
 * the three bugs involved either. They were decisions — which failures get
 * recorded, which recorded failure blocks the redirect — and a test that had to
 * carry HTML fixtures and a live schema would have been too expensive to write
 * on any of the three occasions it was needed.
 *
 * ⚠️ THE COST OF THAT CHOICE, stated so nobody mistakes green here for proof:
 * the admin-client fake below implements the shapes these actions use, not
 * supabase-js. If the real client ever reports an error differently this file
 * keeps passing. It proves the branching, and nothing about the writes
 * underneath it. (An unmodelled METHOD would throw rather than pass, which is
 * the right way round.)
 *
 * ⚠️ Two things the fake cannot express today, so nothing here covers them:
 *
 * 1. `error.code`, so the duplicate-league branch in `import.ts` that keys on
 *    `"23505"` is unreachable from a test.
 * 2. A PARTIAL failure within one table. Responses are keyed `"<table>.<verb>"`
 *    and shared by every call in a run, so "2 of 12 teams failed" — the
 *    realistic production shape — cannot be set up; only all-or-nothing.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type {
  ParsedGame,
  ParsedLeague,
  ParsedStat,
} from "@/lib/import/esportsdesk";

// ── The boundaries ─────────────────────────────────────────────────────────

const fetchLeague = vi.fn<() => Promise<ParsedLeague>>();
const fetchSchedule = vi.fn<() => Promise<ParsedGame[]>>();
const fetchStats = vi.fn<() => Promise<ParsedStat[]>>();
const addMembership =
  vi.fn<() => Promise<{ ok: boolean; error: string | null }>>();
const redirected = vi.fn<(path: string) => void>();

/**
 * `redirect` THROWS in production — that is the whole reason both actions have
 * to call it outside a `try`. The stub throws too, so a regression that moves it
 * inside one shows up here as a swallowed redirect (the action returning a
 * message instead), which is exactly how it would fail for real.
 */
class RedirectSignal extends Error {}
vi.mock("next/navigation", () => ({
  redirect: (path: string) => {
    redirected(path);
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
  // against — only the three network calls are replaced.
  const real =
    await importOriginal<typeof import("@/lib/import/esportsdesk")>();
  return {
    ...real,
    fetchEsportsdeskLeague: () => fetchLeague(),
    fetchEsportsdeskSchedule: () => fetchSchedule(),
    fetchEsportsdeskStats: () => fetchStats(),
  };
});

// ── The admin client fake ──────────────────────────────────────────────────

type Query = { table: string; verb: string; single: boolean };
type Result = { data?: unknown; error?: { message: string } | null };

/** Per-test overrides, keyed `"<table>.<verb>"`. Anything unset succeeds. */
let responses: Record<string, Result> = {};
/** Ids handed back by inserts, so the action's own bookkeeping stays coherent. */
let nextId = 0;

function defaultFor(q: Query): Result {
  if (q.verb === "select" && q.table === "games")
    return { data: gamesInSeason, error: null };
  if (q.single) return { data: { id: `${q.table}-${++nextId}` }, error: null };
  if (q.verb === "insert" && q.table === "players")
    return { data: lastPlayerIds, error: null };
  return { data: [], error: null };
}

/** Rows the stats block reads back after the schedule insert. */
let gamesInSeason: unknown[] = [];
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
        // ⛔ THE STATS BLOCK READS BACK WHAT THE SCHEDULE BLOCK WROTE, so the
        // fake has to carry rows across the two. Leaving this to a hand-written
        // fixture made `gamesInSeason` empty in every test, which silently
        // disabled the whole stats-matching path — two assertions then held
        // even with the logic they named deleted. Deriving it from the real
        // payload also keeps tests off the fake's id sequence.
        if (table === "games" && Array.isArray(payload))
          gamesInSeason = payload.map((g, i) => ({
            id: `game-${i}`,
            home_team_id: (g as Record<string, string>).home_team_id,
            away_team_id: (g as Record<string, string>).away_team_id,
            home_goals: (g as Record<string, number>).home_goals,
            away_goals: (g as Record<string, number>).away_goals,
          }));
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
      order: () => chain,
      single() {
        q.single = true;
        return chain;
      },
      then(resolve: (r: Result) => unknown) {
        const key = `${q.table}.${q.verb}`;
        return Promise.resolve(responses[key] ?? defaultFor(q)).then(resolve);
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

/** A game whose two names resolve against the default `league()` fixture. */
const MATCHED_GAME: ParsedGame = {
  date: "2026-01-05",
  homeName: "Otters",
  awayName: "Bears",
  homeGoals: 3,
  awayGoals: 2,
  isPlayoff: false,
};

/** One stat line per player of the default fixture, matched by name. */
const matchedStats = (): ParsedStat[] =>
  league().teams.flatMap((t) =>
    t.players.map((p) => ({
      name: `${p.firstName} ${p.lastName}`,
      jersey: p.number ?? 0,
      team: t.name,
      gp: 1,
      g: 1,
      a: 0,
      pim: 0,
    })),
  );

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
  gamesInSeason = [];
  lastPlayerIds = [];
  fetchLeague.mockResolvedValue(league());
  fetchSchedule.mockResolvedValue([]);
  fetchStats.mockResolvedValue([]);
  addMembership.mockResolvedValue({ ok: true, error: null });
});

// ── The full importer ──────────────────────────────────────────────────────

describe("runEsportsdeskImport", () => {
  it("redirects when a full source imported with everything matched", async () => {
    // ⛔ THE NEGATIVE CONTROL FOR `notes[]`, and the reason it must carry real
    // data. Without a run where the schedule AND the stats both match, every
    // "a note fires" assertion below holds just as well if notes fired
    // unconditionally — which is exactly what mutation testing found.
    const { runEsportsdeskImport } = await import("./import");
    fetchSchedule.mockResolvedValue([MATCHED_GAME]);
    fetchStats.mockResolvedValue(matchedStats());
    const r = await run(runEsportsdeskImport);
    expect(r.redirected).toBe(true);
    expect(redirected).toHaveBeenCalledWith("/new-league/seasons");
  });

  it("redirects when the source simply had no games or stats to import", async () => {
    // The other side of the distinction the gate exists for: a season not yet
    // played has nothing to import and is not a failure. Reporting it would
    // send every pre-season migration back to the form.
    const { runEsportsdeskImport } = await import("./import");
    fetchSchedule.mockResolvedValue([]);
    fetchStats.mockResolvedValue([]);
    const r = await run(runEsportsdeskImport);
    expect(r.redirected).toBe(true);
  });

  it("reports a PARTIAL stats shortfall, not only a total one", async () => {
    // One team whose stats-page name differs by a character loses that team's
    // stats and no other. This read `rosterRows.length === 0` and so stayed
    // silent for the commonest real failure.
    const { runEsportsdeskImport } = await import("./import");
    fetchSchedule.mockResolvedValue([MATCHED_GAME]);
    fetchStats.mockResolvedValue([
      ...matchedStats(),
      {
        name: "Ghost Player",
        jersey: 77,
        team: "Otters",
        gp: 1,
        g: 1,
        a: 0,
        pim: 0,
      },
    ]);
    const r = await run(runEsportsdeskImport);
    expect(r.redirected).toBe(false);
    if (r.redirected) return;
    expect(r.state.message).toMatch(
      /1 of \d+ published stat lines could not be matched/,
    );
  });

  it("reports, and does NOT redirect, when games were listed but matched nothing", async () => {
    // The round-2 bug: `if (rows.length)` skips the insert on an empty match, so
    // nothing threw, nothing counted, and the run redirected looking perfect.
    const { runEsportsdeskImport } = await import("./import");
    fetchSchedule.mockResolvedValue([
      {
        date: "2026-01-05",
        homeName: "Nobody",
        awayName: "Nobody Else",
        homeGoals: 3,
        awayGoals: 2,
        isPlayoff: false,
      },
    ]);
    const r = await run(runEsportsdeskImport);
    expect(r.redirected).toBe(false);
    if (r.redirected) return;
    expect(r.state.ok).toBe(true);
    expect(r.state.message).toMatch(/1 of 1 games could not be matched/);
    expect(redirected).not.toHaveBeenCalled();
  });

  it("reports when stats were published but matched no roster", async () => {
    const { runEsportsdeskImport } = await import("./import");
    fetchStats.mockResolvedValue([
      { name: "Nobody", jersey: 99, team: "Nobody", gp: 1, g: 1, a: 0, pim: 0 },
    ]);
    const r = await run(runEsportsdeskImport);
    expect(r.redirected).toBe(false);
    if (r.redirected) return;
    expect(r.state.message).toMatch(
      /1 of 1 published stat lines could not be matched/,
    );
  });

  it("records a team whose insert failed, and refuses to redirect past it", async () => {
    // The round-1 bug: a bare `continue` that recorded nothing.
    const { runEsportsdeskImport } = await import("./import");
    responses["teams.insert"] = {
      data: null,
      error: { message: "duplicate slug" },
    };
    const r = await run(runEsportsdeskImport);
    expect(r.redirected).toBe(false);
    if (r.redirected) return;
    expect(r.state.message).toMatch(/2 of 2 teams did not import cleanly/);
    expect(r.state.message).toMatch(/duplicate slug/);
    expect(r.state.slug).toBe("new-league");
  });

  it("records a roster insert failure without counting the team as imported", async () => {
    const { runEsportsdeskImport } = await import("./import");
    responses["team_players.insert"] = { error: { message: "fk violation" } };
    const r = await run(runEsportsdeskImport);
    expect(r.redirected).toBe(false);
    if (r.redirected) return;
    expect(r.state.message).toMatch(/roster: fk violation/);
    // Teams themselves landed, so the count is teams-not-clean, not teams-created.
    expect(r.state.message).toMatch(/Imported 2 teams, 0 players/);
  });

  it("does not offer a way in when the membership grant failed", async () => {
    const { runEsportsdeskImport } = await import("./import");
    addMembership.mockResolvedValue({ ok: false, error: "rls refused" });
    const r = await run(runEsportsdeskImport);
    expect(r.redirected).toBe(false);
    if (r.redirected) return;
    expect(r.state.canOpen).toBe(false);
    expect(r.state.message).toMatch(/You were NOT added to this league/);
  });

  it("refuses a source that parses to no teams, before writing anything", async () => {
    const { runEsportsdeskImport } = await import("./import");
    fetchLeague.mockResolvedValue(league([]));
    const r = await run(runEsportsdeskImport);
    expect(r.redirected).toBe(false);
    if (r.redirected) return;
    expect(r.state.ok).toBe(false);
    expect(r.state.message).toMatch(/No teams found/);
  });

  it("refuses a reserved slug before writing anything", async () => {
    const { runEsportsdeskImport } = await import("./import");
    const r = await run(runEsportsdeskImport, form({ league_name: "Manage" }));
    expect(r.redirected).toBe(false);
    if (r.redirected) return;
    expect(r.state.ok).toBe(false);
    expect(r.state.message).toMatch(/reserved/);
  });
});

// ── The rosters-only importer ──────────────────────────────────────────────

describe("runRosterOnlyImport", () => {
  it("redirects into the new league when every roster landed", async () => {
    const { runRosterOnlyImport } = await import("./import-rosters");
    const r = await run(runRosterOnlyImport);
    expect(r.redirected).toBe(true);
    expect(redirected).toHaveBeenCalledWith("/new-league/seasons");
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
    expect(r.state.canOpen).toBe(false);
  });
});
