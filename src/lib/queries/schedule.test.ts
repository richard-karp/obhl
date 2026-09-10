import { describe, expect, it, vi } from "vitest";

// `getPublishState` only builds its own client when one is not passed, and
// every test here passes one. Mocking the module keeps `next/headers` — which
// `@/utils/supabase/server` imports at load and which has no request context
// under vitest — out of the import graph entirely.
vi.mock("@/utils/supabase/server", () => ({
  createClient: async () => {
    throw new Error("a client was passed; this must not be called");
  },
}));

import { getGamesOnDate, getPublishState } from "@/lib/queries/schedule";
import type { DbClient } from "@/lib/db/helpers";

/**
 * Kong's 502 body, verbatim. This is the string CI saw — it is not generated
 * anywhere in `node_modules`, it arrives over the wire when the gateway cannot
 * get a valid response out of PostgREST.
 */
const GATEWAY_502 = "An invalid response was received from the upstream server";

/**
 * A chainable stand-in for a PostgREST builder.
 *
 * Every filter method (`select`, `eq`, `not`, `order`, `limit`, …) returns the
 * same object, and awaiting it settles. That is enough for all seven reads in
 * `getPublishState` without enumerating their chains, which differ.
 *
 * ⛔ THE COUNTER IS PER `from()`/`rpc()` CALL, NOT PER QUERY. A retry rebuilds
 * its query from the factory, so it lands as a *new* call — which is exactly
 * how these tests tell a first attempt from a second one.
 */
function fakeClient(
  shouldFail: (read: { label: string; nth: number; call: number }) => boolean,
) {
  const calls: string[] = [];
  const perLabel = new Map<string, number>();

  const build = (label: string) => {
    const call = calls.push(label); // push returns the new 1-based length
    // Per-label attempt number, so a test can say "the first time the RPC is
    // read" without knowing where in the `Promise.all` that read sits.
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
    // ⛔ TARGETED BY NAME, NOT BY POSITION. `season_is_started` is one of the
    // six reads that lock, and naming it keeps this test testing what it claims
    // if the `Promise.all` is ever reordered. Keyed off an index it could pass
    // VACUOUSLY instead: `lowestId` is deliberately excluded from the failure
    // list, so failing whichever read happened to sit first would leave
    // `readFailed` false whether the retry worked or not.
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
    // A genuinely broken query, not a blip. The fail-closed rule is unchanged:
    // `started` locks shut and `readFailed` travels with it so nothing renders
    // the counts as though they were zero.
    const { client, calls } = fakeClient(() => true);

    const state = await getPublishState(SEASON, { client });

    expect(state.readFailed).toBe(true);
    expect(state.started).toBe(true);
    // Retried once and then stopped — not a retry loop.
    expect(calls).toHaveLength(14);
  });
});

/**
 * Records every builder call so a test can assert the filters that were built.
 *
 * Deliberately dumber than `fakeClient` above: these tests care about the
 * ARGUMENTS (the range bounds), not about call ordering or retries.
 */
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

    // 00:00 on the night itself through 00:00 the next night, both stamped with
    // the league's offset. In UTC these are 04:00 and 04:00 — a UTC-bounded day
    // would drop the 9:40pm game, which lands at 01:40Z on the 15th.
    expect(argsOf("gte")?.[1]).toBe("2026-09-14T04:00:00.000Z");
    expect(argsOf("lt")?.[1]).toBe("2026-09-15T04:00:00.000Z");
  });

  it("uses each end's own offset across the DST boundary", async () => {
    const { client, argsOf } = recordingClient();
    // 1 Nov 2026 is the EDT->EST switch: the day starts at -04:00 and ends at
    // -05:00, so it is 25 hours long. One offset for both ends would clip an
    // hour off it — the hour a 9:40pm game sits in.
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
    // ⛔ THE WHOLE POINT OF `readFailed`. Returning a bare [] here would tell a
    // scorekeeper standing at the rink that there are no games tonight when the
    // query actually errored — on the only page they have. Same rule
    // `getScheduleConstraints` states: "no rows" and "I was not allowed to look"
    // must not be the same value.
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
