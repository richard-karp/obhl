import { describe, expect, it, vi } from "vitest";

// Every test passes a client. Mocking keeps `next/headers`, which has no request context
// under vitest, out of the import graph.
vi.mock("@/utils/supabase/server", () => ({
  createClient: async () => {
    throw new Error("a client was passed; this must not be called");
  },
}));

import { getGamesOnDate, getPublishState } from "@/lib/queries/schedule";
import type { DbClient } from "@/lib/db/helpers";

/** Kong's 502 body, verbatim, as it arrives over the wire. */
const GATEWAY_502 = "An invalid response was received from the upstream server";

/**
 * A chainable PostgREST stand-in. ⛔ The counter is per `from()`/`rpc()` call, not per query:
 * a retry rebuilds from the factory, which is how these tests tell attempts apart.
 */
function fakeClient(
  shouldFail: (read: { label: string; nth: number; call: number }) => boolean,
) {
  const calls: string[] = [];
  const perLabel = new Map<string, number>();

  const build = (label: string) => {
    const call = calls.push(label); // push returns the new 1-based length
    // Per-label attempt number, independent of where the read sits in the `Promise.all`.
    const nth = (perLabel.get(label) ?? 0) + 1;
    perLabel.set(label, nth);
    const failed = shouldFail({ label, nth, call });
    const settle = () =>
      Promise.resolve(
        failed
          ? { data: null, count: null, error: { message: GATEWAY_502 } }
          : {
              data: [{ id: "g1", scheduled_at: "2026-01-05T02:30:00Z" }],
              count: 3,
              error: null,
            },
      );

    const chainable: unknown = new Proxy(
      {},
      {
        get(_target, prop) {
          if (prop === "then") {
            return (onOk: unknown, onErr: unknown) =>
              settle().then(onOk as never, onErr as never);
          }
          // Symbols reach here during promise resolution; only `then` matters.
          if (typeof prop === "symbol") return undefined;
          return () => chainable;
        },
      },
    );
    return chainable;
  };

  const client = {
    from: (table: string) => build(`from:${table}`),
    rpc: (fn: string) => build(`rpc:${fn}`),
  };

  return { client: client as unknown as DbClient, calls };
}

const SEASON = "11111111-1111-1111-1111-111111111111";

describe("getPublishState — a lost response is not a failed read", () => {
  it("reads once each when nothing fails", async () => {
    const { client, calls } = fakeClient(() => false);

    const state = await getPublishState(SEASON, { client });

    expect(state.readFailed).toBe(false);
    expect(state.liveCount).toBe(3);
    // Seven reads, seven calls: the retry costs nothing on the happy path.
    expect(calls).toHaveLength(7);
  });

  it("absorbs a single gateway 502 on one read — the CI failure", async () => {
    // ⛔ By name, not position: `lowestId` is excluded from the failure list, so failing
    // whichever read sits first could leave `readFailed` false and pass vacuously.
    const { client, calls } = fakeClient(
      ({ label, nth }) => label === "rpc:season_is_started" && nth === 1,
    );

    const state = await getPublishState(SEASON, { client });

    expect(state.readFailed).toBe(false);
    expect(state.liveCount).toBe(3);
    expect(calls).toHaveLength(8);
  });

  it("absorbs a 502 on every read at once", async () => {
    // The first seven calls are the seven reads' first attempts, whatever order
    // they were built in — so this stays true under reordering too.
    const { client, calls } = fakeClient(({ call }) => call <= 7);

    const state = await getPublishState(SEASON, { client });

    expect(state.readFailed).toBe(false);
    expect(state.liveCount).toBe(3);
    expect(calls).toHaveLength(14);
  });

  it("still locks the builder when a read fails twice", async () => {
    // A broken query, not a blip: `started` locks shut, and `readFailed` travels with it so
    // nothing renders the counts as zero.
    const { client, calls } = fakeClient(() => true);

    const state = await getPublishState(SEASON, { client });

    expect(state.readFailed).toBe(true);
    expect(state.started).toBe(true);
    // Retried once and then stopped — not a retry loop.
    expect(calls).toHaveLength(14);
  });
});

/** Records every builder call: these tests assert the arguments (the range bounds), not retries. */
function recordingClient(rows: unknown[] = [], error: unknown = null) {
  const calls: Array<{ fn: string; args: unknown[] }> = [];
  const chainable: Record<string, unknown> = {};
  const proxy: unknown = new Proxy(chainable, {
    get(_target, prop) {
      if (prop === "then") {
        return (resolve: (v: unknown) => unknown) =>
          resolve({ data: error ? null : rows, error });
      }
      return (...args: unknown[]) => {
        calls.push({ fn: String(prop), args });
        return proxy;
      };
    },
  });
  const client = {
    from: (table: string) => {
      calls.push({ fn: "from", args: [table] });
      return proxy;
    },
  };
  const argsOf = (fn: string, first?: string) =>
    calls.find(
      (c) => c.fn === fn && (first === undefined || c.args[0] === first),
    )?.args;
  return { client: client as unknown as DbClient, calls, argsOf };
}

describe("getGamesOnDate — the day's games, across leagues", () => {
  it("bounds the day in league time, not UTC", async () => {
    const { client, argsOf } = recordingClient();
    await getGamesOnDate(["L1"], "2026-09-14", { client });

    // Midnight to midnight in league time (04:00Z). A UTC-bounded day would drop the 9:40pm
    // game, which lands at 01:40Z on the 15th.
    expect(argsOf("gte")?.[1]).toBe("2026-09-14T04:00:00.000Z");
    expect(argsOf("lt")?.[1]).toBe("2026-09-15T04:00:00.000Z");
  });

  it("uses each end's own offset across the DST boundary", async () => {
    const { client, argsOf } = recordingClient();
    // 1 Nov 2026 is the EDT->EST switch, a 25-hour day. One offset for both ends would clip
    // the hour a 9:40pm game sits in.
    await getGamesOnDate(["L1"], "2026-11-01", { client });

    // Midnight on the 1st is still EDT (04:00Z); midnight on the 2nd is EST
    // (05:00Z). 25 hours apart, which is what that night actually is.
    expect(argsOf("gte")?.[1]).toBe("2026-11-01T04:00:00.000Z");
    expect(argsOf("lt")?.[1]).toBe("2026-11-02T05:00:00.000Z");
  });

  it("excludes drafts explicitly rather than leaning on RLS", async () => {
    // An admin client bypasses the policy, so the filter has to be here.
    const { client, argsOf } = recordingClient();
    await getGamesOnDate(["L1"], "2026-09-14", { client });

    expect(argsOf("eq", "is_draft")?.[1]).toBe(false);
  });

  it("filters to the leagues it was given", async () => {
    const { client, argsOf } = recordingClient();
    await getGamesOnDate(["L1", "L2"], "2026-09-14", { client });

    expect(argsOf("in")).toEqual(["season.league_id", ["L1", "L2"]]);
  });

  it("returns nothing without querying when no leagues are given", async () => {
    // A viewer with no scorable league must not turn into an unfiltered read.
    const { client, calls } = recordingClient();

    expect(await getGamesOnDate([], "2026-09-14", { client })).toEqual({
      games: [],
      readFailed: false,
    });
    expect(calls).toEqual([]);
  });

  it("reports a failed read rather than calling it an empty night", async () => {
    // ⛔ A bare [] would tell a scorekeeper at the rink there are no games tonight when the
    // query errored.
    const { client } = recordingClient([], { message: "boom" });

    expect(await getGamesOnDate(["L1"], "2026-09-14", { client })).toEqual({
      games: [],
      readFailed: true,
    });
  });

  it("lifts the embedded league id onto the row", async () => {
    // The page needs it to build a per-row link, and every row can be a
    // different league.
    const { client } = recordingClient([
      { id: "g1", season: { league_id: "L2" } },
    ]);

    const { games } = await getGamesOnDate(["L1", "L2"], "2026-09-14", {
      client,
    });

    expect(games[0].league_id).toBe("L2");
  });
});
