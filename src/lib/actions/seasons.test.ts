/**
 * `createTeamForSeason`'s partial outcomes.
 *
 * ⛔ THIS FUNCTION HAD NO COVERAGE OF ANY KIND, which is how a silent skip
 * survived in it: `if (userId) { … }` with no `else` meant a captain whose
 * login could be neither created nor found was passed over without a word, and
 * the team reported as added with a captain who cannot sign in. No e2e drives
 * team-with-captain creation and no unit test existed, so nothing was going to
 * catch it.
 *
 * The function is deliberately full of partial exits — a team without a captain
 * is a valid state, so a captain step failing reports what landed rather than
 * rolling the team back. That design only works if each exit actually reports,
 * which is what this file pins.
 *
 * ⚠️ Same trade as `import.test.ts`: the database and the auth admin API are
 * stubbed, so this proves the branching and nothing about the writes. The fake
 * models the chains this function uses, not supabase-js.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const findUser = vi.fn<() => Promise<string | null>>();
const addMembership =
  vi.fn<() => Promise<{ ok: boolean; error: string | null }>>();
const createUser = vi.fn<
  () => Promise<{
    data: { user: { id: string } } | null;
    error: { message: string } | null;
  }>
>();

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/auth/guards", () => ({
  requireLeagueManager: () => Promise.resolve({ id: "mgr-1" }),
}));
vi.mock("@/lib/audit", () => ({ logAudit: () => Promise.resolve() }));
vi.mock("@/lib/auth/users", () => ({ findUserIdByEmail: () => findUser() }));
vi.mock("@/lib/auth/membership", () => ({
  addLeagueMembership: () => addMembership(),
}));

type Result = {
  data?: unknown;
  error?: { message: string; code?: string } | null;
};
/** Keyed `"<table>.<verb>"`; an array is consumed one entry per call. */
let responses: Record<string, Result | Result[]> = {};
let nextId = 0;

function makeAdmin() {
  const build = (table: string) => {
    const q = { table, verb: "", single: false };
    const chain = {
      insert() {
        q.verb = "insert";
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
      maybeSingle() {
        q.single = true;
        return chain;
      },
      then(resolve: (r: Result) => unknown) {
        const queued = responses[`${q.table}.${q.verb}`];
        const fallback: Result =
          q.table === "seasons"
            ? { data: { league_id: "league-1" }, error: null }
            : q.single
              ? { data: { id: `${q.table}-${++nextId}` }, error: null }
              : { data: [], error: null };
        const out = Array.isArray(queued)
          ? (queued.shift() ?? fallback)
          : (queued ?? fallback);
        return Promise.resolve(out).then(resolve);
      },
    };
    return chain;
  };
  return {
    from: (table: string) => build(table),
    auth: { admin: { createUser: () => createUser() } },
  };
}
vi.mock("@/utils/supabase/admin", () => ({
  createAdminClient: () => makeAdmin(),
}));

const form = (over: Record<string, string> = {}) => {
  const fd = new FormData();
  fd.set("season_id", "season-1");
  fd.set("name", "Otters");
  fd.set("captain_name", "Ada Lovelace");
  fd.set("captain_email", "ada@example.test");
  for (const [k, v] of Object.entries(over)) fd.set(k, v);
  return fd;
};

const run = async (fd = form()) => {
  const { createTeamForSeason } = await import("./seasons");
  return (await createTeamForSeason(null, fd)) as {
    ok: boolean;
    message: string;
  };
};

beforeEach(() => {
  vi.clearAllMocks();
  responses = {};
  nextId = 0;
  createUser.mockResolvedValue({
    data: { user: { id: "user-1" } },
    error: null,
  });
  findUser.mockResolvedValue(null);
  addMembership.mockResolvedValue({ ok: true, error: null });
});

describe("createTeamForSeason", () => {
  it("reports success when the team and its captain both land", async () => {
    const r = await run();
    expect(r.ok).toBe(true);
    expect(r.message).toMatch(/Added Otters \(captain Ada Lovelace\)/);
    expect(addMembership).toHaveBeenCalled();
  });

  it("adds a team with no captain at all", async () => {
    const r = await run(form({ captain_name: "", captain_email: "" }));
    expect(r.ok).toBe(true);
    expect(addMembership).not.toHaveBeenCalled();
  });

  it("falls back to looking the captain up when the account already exists", async () => {
    // `createUser` failing is the NORMAL path for a returning captain, not an
    // error — so this must still succeed.
    createUser.mockResolvedValue({
      data: null,
      error: { message: "email address already registered" },
    });
    findUser.mockResolvedValue("existing-user");
    const r = await run();
    expect(r.ok).toBe(true);
    expect(addMembership).toHaveBeenCalled();
  });

  it("reports a captain whose login could be neither created nor found", async () => {
    // ⛔ THE SILENT SKIP. `if (userId)` with no `else` passed over the whole
    // captain block here and still returned ok — a team reported as added with
    // a captain who cannot sign in. `findUserIdByEmail` returns null for a
    // FAILED `listUsers` exactly as it does for "not there", so any auth
    // outage lands on this path.
    createUser.mockResolvedValue({
      data: null,
      error: { message: "service unavailable" },
    });
    findUser.mockResolvedValue(null);
    const r = await run();
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/couldn't create or find their login/);
    expect(r.message).toMatch(/service unavailable/);
    // and nothing downstream was attempted with an undefined id
    expect(addMembership).not.toHaveBeenCalled();
  });

  it("reports a captain profile that could not be written", async () => {
    responses["profiles.upsert"] = { error: { message: "rls refused" } };
    const r = await run();
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/couldn't create their login \(rls refused\)/);
    expect(addMembership).not.toHaveBeenCalled();
  });

  it("reports a captain who was created but given no league access", async () => {
    // The grant is the last thing that has to land for the captain to reach
    // anything; discarded, it read exactly like success.
    addMembership.mockResolvedValue({ ok: false, error: "rls refused" });
    const r = await run();
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/couldn't give them access to this league/);
    expect(r.message).toMatch(/add them from People & Roles/i);
  });

  it("keeps the team when a captain step fails — it is a valid state", async () => {
    responses["profiles.upsert"] = { error: { message: "nope" } };
    const r = await run();
    expect(r.message).toMatch(/^Added Otters with captain/);
  });
});
