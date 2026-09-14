import { describe, it, expect, vi } from "vitest";
import { writeGames } from "./writeGames";
import type { GameWrite } from "./gameWrites";

vi.mock("@/lib/audit", () => ({ logAudit: vi.fn(async () => {}) }));
import { logAudit } from "@/lib/audit";

// ⚠️ `admin.rpc` is a stub: the lock, the transaction and the refusals live in SQL, and Vitest
// cannot see a lock. RUNBOOK.md, _Schedule edits and exports_.
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

  /** ⚠️ `undefined`, not `null`: omitting `p_is_draft` is how the unscoped case is expressed. */
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

  /** An empty `returns table` array means no row: a refusal, never `ok`. */
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
