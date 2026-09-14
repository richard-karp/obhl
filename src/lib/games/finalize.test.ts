import { describe, expect, it, vi, beforeEach } from "vitest";

// Every test passes a client. Mocking keeps `next/headers`, which has no request context
// under vitest, out of the import graph.
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
 * A chainable PostgREST stand-in. `updated` is what the UPDATE's `.select()` settles with:
 * `[]` is a write that succeeds and does nothing, the bug these tests pin.
 */
function fakeClient(
  updated: Array<{ id: string }>,
  opts?: { gameMissing?: boolean; rosters?: unknown[]; updates?: unknown[] },
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
        data: opts?.rosters ?? [
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
            return (payload: unknown) => {
              opts?.updates?.push(payload);
              return chainable;
            };
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
   * ⛔ An RLS-refused UPDATE returns `error: null`, so without this throw the cron counts a
   * write that did nothing as a closed game, in the only signal the job has.
   */
  it("throws when the update matches no rows", async () => {
    await expect(
      finalizeGameById("g1", null, fakeClient([])),
    ).rejects.toThrow(/no rows/i);
  });

  /**
   * ⛔ The throw comes before the audit write: `logAudit` runs on the admin client, so auditing
   * first files a `finalize_game` entry for a game that was never finalized.
   */
  it("files no audit entry when the update matched nothing", async () => {
    await expect(
      finalizeGameById("g1", null, fakeClient([])),
    ).rejects.toThrow();
    expect(logAudit).not.toHaveBeenCalled();
  });

  /** ⛔ The other silent-success path: returning on an unreadable game reads as a completed finalize. */
  it("throws when the game cannot be read", async () => {
    await expect(
      finalizeGameById("g1", null, fakeClient([], { gameMissing: true })),
    ).rejects.toThrow(/g1/);
    expect(logAudit).not.toHaveBeenCalled();
  });

  it("writes each side's score as the sum of its roster's goals", async () => {
    const updates: unknown[] = [];
    const line = (
      team_id: string,
      player_id: string,
      goals: number | null,
      is_substitute = false,
    ) => ({
      team_id,
      goals,
      assists: 0,
      pim: 0,
      is_substitute,
      player_id,
      players: { first_name: "A", last_name: player_id },
    });
    await finalizeGameById(
      "g1",
      "u1",
      fakeClient([{ id: "g1" }], {
        updates,
        rosters: [
          line("home", "h1", 2),
          line("home", "h2", 1),
          line("home", "h3", 1, true), // a substitute's goal still counts for the side
          line("away", "a1", 1),
          line("away", "a2", null),
        ],
      }),
    );
    expect(updates).toHaveLength(1);
    expect(updates[0]).toMatchObject({
      status: "final",
      home_goals: 4,
      away_goals: 1,
    });
    expect(logAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "finalize_game",
        new_data: { home_goals: 4, away_goals: 1 },
      }),
    );
  });
});
