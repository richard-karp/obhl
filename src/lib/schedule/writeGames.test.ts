import { describe, it, expect, vi } from "vitest";
import { writeGames } from "./writeGames";
import type { GameWrite } from "./gameWrites";

vi.mock("@/lib/audit", () => ({ logAudit: vi.fn(async () => {}) }));
import { logAudit } from "@/lib/audit";

/**
 * ⛔ THIS FILE IS THE ANSWER TO "WHAT REPLACED THE DELETED TESTS", AND IT IS NOT
 * THE OBVIOUS ONE. `0045` deleted 19 tests, and every one of them covered
 * compensation code that no longer exists — no loss. But the swap introduced
 * three NEW decision branches here, in a file that had no tests at all: what
 * happens when the RPC errors, when it returns an empty array, and when the
 * batch is empty. Those are pure, cheap to fake, and were untested.
 *
 * ⚠️ WHAT THIS FILE CANNOT COVER, so that nobody adds a fake and believes
 * otherwise: the advisory lock, the transaction, and the refusal logic all live
 * in SQL. `admin.rpc` here is a stub that returns whatever the test says. The
 * serialization evidence is the two-psql race in
 * `docs/superpowers/plans/2026-09-06-schedule-write-rpc.md`, against a real
 * Postgres. Vitest cannot see a lock.
 */
type RpcReply = { data: unknown; error: { message: string } | null };

function fakeAdmin(reply: RpcReply) {
  // Args typed, so `rpc.mock.calls[0][1]` is the payload rather than a tuple
  // the compiler believes is empty.
  const rpc = vi.fn(
    async (_fn: string, _args: Record<string, unknown>) => reply,
  );
  return { admin: { rpc } as never, rpc };
}

const write = (id: string): GameWrite => ({
  id,
  next: { label: "A" },
  prev: { label: "B" },
  expectScheduledAt: "2027-01-05T19:00:00+00:00",
});

describe("writeGames", () => {
  it("returns null and calls nothing on an empty batch", async () => {
    const { admin, rpc } = fakeAdmin({ data: [], error: null });
    expect(await writeGames(admin, "s1", "u1", "act", [])).toBeNull();
    expect(rpc).not.toHaveBeenCalled();
  });

  it("passes the season, statuses and draft scope through to the function", async () => {
    const { admin, rpc } = fakeAdmin({
      data: [{ applied: 1, refused: null, reason: null }],
      error: null,
    });
    await writeGames(
      admin,
      "s1",
      "u1",
      "act",
      [write("g1")],
      ["scheduled"],
      false,
    );
    expect(rpc).toHaveBeenCalledWith("apply_game_writes", {
      p_season: "s1",
      p_writes: [
        {
          id: "g1",
          expect: { label: "B", scheduled_at: "2027-01-05T19:00:00+00:00" },
          next: { label: "A" },
        },
      ],
      p_statuses: ["scheduled"],
      p_is_draft: false,
    });
  });

  /**
   * ⚠️ `undefined`, NOT `null`. The function defaults `p_is_draft` to null and
   * reads null as "both sides"; the generated Args type has it as optional
   * `boolean`, so omitting is how the unscoped case is expressed.
   */
  it("omits the draft scope rather than sending null when unscoped", async () => {
    const { admin, rpc } = fakeAdmin({
      data: [{ applied: 1, refused: null, reason: null }],
      error: null,
    });
    await writeGames(admin, "s1", "u1", "act", [write("g1")]);
    expect(rpc.mock.calls[0][1]).toMatchObject({ p_is_draft: undefined });
  });

  it("reports a refusal in the manager's words and audits it", async () => {
    const { admin } = fakeAdmin({
      data: [{ applied: 0, refused: "g1", reason: "conflict" }],
      error: null,
    });
    const msg = await writeGames(admin, "s1", "u1", "act", [write("g1")]);
    expect(msg).toMatch(/preview it again/);
    expect(logAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "act_failed" }),
    );
  });

  it("reports a database error rather than treating it as success", async () => {
    const { admin } = fakeAdmin({ data: null, error: { message: "boom" } });
    const msg = await writeGames(admin, "s1", "u1", "act", [write("g1")]);
    expect(msg).toContain("boom");
    expect(msg).toContain("Nothing was written.");
  });

  /**
   * A `returns table` RPC comes back as an array of one row. An empty array
   * means the function returned no row at all — it has no path to do that, so
   * reading `[0]` and finding `undefined` must become a refusal, never an `ok`.
   */
  it("treats an empty result array as a failure, not as success", async () => {
    const { admin } = fakeAdmin({ data: [], error: null });
    const msg = await writeGames(admin, "s1", "u1", "act", [write("g1")]);
    expect(msg).toMatch(/returned nothing/);
  });

  it("returns null when the batch applied in full", async () => {
    const { admin } = fakeAdmin({
      data: [{ applied: 2, refused: null, reason: null }],
      error: null,
    });
    expect(
      await writeGames(admin, "s1", "u1", "act", [write("g1"), write("g2")]),
    ).toBeNull();
  });

  it("refuses a short applied count even though the function reported no reason", async () => {
    const { admin } = fakeAdmin({
      data: [{ applied: 1, refused: null, reason: null }],
      error: null,
    });
    const msg = await writeGames(admin, "s1", "u1", "act", [
      write("g1"),
      write("g2"),
    ]);
    expect(msg).toContain("1 of 2");
  });
});
