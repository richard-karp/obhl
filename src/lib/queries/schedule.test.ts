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

import { getPublishState } from "@/lib/queries/schedule";
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
              settle().then(
                onOk as never,
                onErr as never,
              );
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
