import { describe, expect, it, vi, beforeEach } from "vitest";

// `finalizeGameById` only builds its own client when one is not passed, and
// every test here passes one. Mocking the module keeps `next/headers` — which
// `@/utils/supabase/server` imports at load and which has no request context
// under vitest — out of the import graph entirely.
vi.mock("@/utils/supabase/server", () => ({
  createClient: async () => {
    throw new Error("a client was passed; this must not be called");
  },
}));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));

const logAudit = vi.fn<(entry: unknown) => Promise<void>>();
vi.mock("@/lib/audit", () => ({ logAudit: (e: unknown) => logAudit(e) }));

import { finalizeGameById } from "@/lib/games/finalize";
import type { DbClient } from "@/lib/db/helpers";

/**
 * A chainable stand-in for a PostgREST builder, told only what the UPDATE
 * should report back.
 *
 * `updated` is the row list the UPDATE's `.select()` settles with: `[{id}]` for
 * a write that landed, `[]` for one that matched nothing. That is the only axis
 * these tests vary — the reads always succeed, because the bug being pinned is
 * about a write that SUCCEEDS AND DOES NOTHING.
 */
function fakeClient(
  updated: Array<{ id: string }>,
  opts?: { gameMissing?: boolean },
) {
  const build = (table: string) => {
    let isUpdate = false;
    const settle = () => {
      if (isUpdate) return Promise.resolve({ data: updated, error: null });
      if (table === "games")
        return Promise.resolve({
          data: opts?.gameMissing
            ? null
            : { id: "g1", home_team_id: "home", away_team_id: "away" },
          error: null,
        });
      // game_rosters: one home goal, so a successful finalize writes 1-0 and a
      // roster read that came back empty would be visible as 0.
      return Promise.resolve({
        data: [
          {
            team_id: "home",
            goals: 1,
            assists: 0,
            pim: 0,
            is_substitute: false,
            player_id: "p1",
            players: { first_name: "A", last_name: "B" },
          },
        ],
        error: null,
      });
    };

    const chainable: unknown = new Proxy(
      {},
      {
        get(_t, prop) {
          if (prop === "then")
            return (...args: Parameters<Promise<unknown>["then"]>) =>
              settle().then(...args);
          if (prop === "update") {
            isUpdate = true;
            return () => chainable;
          }
          return () => chainable;
        },
      },
    );
    return chainable;
  };

  return { from: (table: string) => build(table) } as unknown as DbClient;
}

describe("finalizeGameById", () => {
  beforeEach(() => logAudit.mockClear());

  it("completes a game when the update lands", async () => {
    await expect(
      finalizeGameById("g1", "u1", fakeClient([{ id: "g1" }])),
    ).resolves.toBeUndefined();
    expect(logAudit).toHaveBeenCalledTimes(1);
  });

  /**
   * ⛔ THE WHOLE POINT OF THIS FILE. An RLS-refused UPDATE is not an error: it
   * matches no rows and returns `error: null`, so `check()` sails through and
   * the function returns as though it had worked. That is how the nightly sweep
   * ran as `anon` for a week while reporting success — `/api/cron/close-night`
   * counted every call it made as a game closed, because a call that did
   * nothing is indistinguishable from one that worked.
   *
   * The response body is the only production signal this job has: Vercel's cron
   * log shows it, and nobody is watching at 2am. A count that cannot be trusted
   * is worse than no count.
   */
  it("throws when the update matches no rows", async () => {
    await expect(
      finalizeGameById("g1", null, fakeClient([])),
    ).rejects.toThrow(/no rows/i);
  });

  /**
   * ⛔ AND IT MUST THROW BEFORE THE AUDIT WRITE, NOT AFTER. `logAudit` runs on
   * the ADMIN client regardless of which client did the update, so an ordering
   * that audits first files a `finalize_game` entry for a game that was never
   * finalized — a false record in the one table whose job is saying what
   * happened. That half of the bug is invisible in the games table entirely.
   */
  it("files no audit entry when the update matched nothing", async () => {
    await expect(
      finalizeGameById("g1", null, fakeClient([])),
    ).rejects.toThrow();
    expect(logAudit).not.toHaveBeenCalled();
  });

  /**
   * ⛔ THE OTHER SILENT-SUCCESS PATH, AND IT IS THE SAME BUG WEARING A HAT. The
   * read at the top of the function used to `return` when the game came back
   * empty, which is indistinguishable from a completed finalize to every caller.
   * `/api/cron/close-night` would count it as closed. A game selected moments
   * earlier that cannot now be read is an anomaly worth a failure, not a shrug.
   */
  it("throws when the game cannot be read", async () => {
    await expect(
      finalizeGameById("g1", null, fakeClient([], { gameMissing: true })),
    ).rejects.toThrow(/g1/);
    expect(logAudit).not.toHaveBeenCalled();
  });
});
