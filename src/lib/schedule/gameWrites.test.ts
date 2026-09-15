import { describe, it, expect } from "vitest";
import {
  checkWrites,
  payloadFor,
  resultFrom,
  MAX_GAME_WRITES,
  type GameWrite,
} from "./gameWrites";

// ⛔ Serialization is proven against real Postgres, not here: Vitest cannot see a lock, so never
// add a fake and believe it covers the race. RUNBOOK.md, _Schedule edits and exports_.
const write = (id: string, over: Partial<GameWrite> = {}): GameWrite => ({
  id,
  next: { home_team_id: "team-new" },
  prev: { home_team_id: "team-old" },
  expectScheduledAt: "2027-01-05T19:00:00+00:00",
  ...over,
});

describe("checkWrites", () => {
  it("passes a batch worth sending", () => {
    expect(checkWrites([write("g1"), write("g2")])).toBeNull();
  });

  it("accepts a batch of exactly the ceiling", () => {
    const batch = Array.from({ length: MAX_GAME_WRITES }, (_, i) =>
      write(`g${i}`),
    );
    expect(checkWrites(batch)).toBeNull();
  });

  it("refuses one row over the ceiling, and says how many", () => {
    const batch = Array.from({ length: MAX_GAME_WRITES + 1 }, (_, i) =>
      write(`g${i}`),
    );
    const r = checkWrites(batch);
    expect(r).not.toBeNull();
    expect(r!.ok).toBe(false);
    if (!r!.ok) {
      expect(r!.kind).toBe("failed");
      expect(r!.message).toContain(String(MAX_GAME_WRITES + 1));
      expect(r!.message).toContain("Nothing was written.");
      // The audit needs the payload even when the batch never left.
      expect(r!.attempted).toHaveLength(MAX_GAME_WRITES + 1);
    }
  });

  /** `update … from` joins each row once, so a duplicate id is one arbitrary write. */
  it("throws when the same game appears twice in one batch", () => {
    expect(() => checkWrites([write("g1"), write("g2"), write("g1")])).toThrow(
      /g1 appears twice/,
    );
  });

  /** ⛔ Loud, not a refusal: a mismatch is a programmer error, a column written unchecked. */
  it("throws when next and prev name different columns", () => {
    expect(() =>
      checkWrites([
        write("g1", {
          next: { home_team_id: "a", label: "x" },
          prev: { home_team_id: "b" },
        }),
      ]),
    ).toThrow(/does not check first/);
  });

  it("treats a null label as a named column, not an absent one", () => {
    // `label: null` is a named column; a truthiness test in place of `in` would mismatch it.
    expect(
      checkWrites([
        write("g1", { next: { label: null }, prev: { label: null } }),
      ]),
    ).toBeNull();
  });
});

describe("payloadFor", () => {
  it("sends expect as prev plus the time the caller read", () => {
    const [row] = payloadFor([write("g1")]);
    expect(row).toEqual({
      id: "g1",
      expect: {
        home_team_id: "team-old",
        scheduled_at: "2027-01-05T19:00:00+00:00",
      },
      next: { home_team_id: "team-new" },
    });
  });

  /** ⚠️ `scheduled_at` is in `expect` even when not written: it is how the repair path notices a
   *  concurrent reschedule or postpone. */
  it("carries scheduled_at into expect for a write that does not set it", () => {
    const [row] = payloadFor([
      write("g1", { next: { label: "A" }, prev: { label: "B" } }),
    ]);
    expect(row.expect).toHaveProperty("scheduled_at");
    expect(row.next).not.toHaveProperty("scheduled_at");
  });

  it("keeps a night move's new time in next and the old one in expect", () => {
    const [row] = payloadFor([
      write("g1", {
        next: { scheduled_at: "2027-01-08T19:00:00+00:00" },
        prev: { scheduled_at: "2027-01-05T19:00:00+00:00" },
      }),
    ]);
    expect(row.next.scheduled_at).toBe("2027-01-08T19:00:00+00:00");
    expect(row.expect.scheduled_at).toBe("2027-01-05T19:00:00+00:00");
  });
});

describe("resultFrom", () => {
  const writes = [write("g1")];

  it("reports success when the function refused nothing", () => {
    expect(
      resultFrom({ applied: 1, refused: null, reason: null }, writes),
    ).toEqual({
      ok: true,
    });
  });

  it("turns a conflict into words a manager can act on", () => {
    const r = resultFrom(
      { applied: 0, refused: "g1", reason: "conflict" },
      writes,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.kind).toBe("conflict");
      expect(r.message).toMatch(/preview it again/);
      expect(r.message).toContain("Nothing was written.");
      expect(r.attempted).toEqual([
        { id: "g1", next: { home_team_id: "team-new" } },
      ]);
    }
  });

  /** ⛔ `applied` is a `row_count` of MATCHED rows: a no-op write still returns 1, so a short
   *  count is a failure. An old test asserted the opposite, which is why the check was missing. */
  it("reports a short applied count as a failure, not a success", () => {
    const two = [write("g1"), write("g2")];
    const r = resultFrom({ applied: 1, refused: null, reason: null }, two);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.kind).toBe("failed");
      expect(r.message).toContain("1 of 2");
      // Not "Nothing was written" — the function's transaction committed.
      expect(r.message).not.toContain("Nothing was written");
    }
  });

  it("accepts a count that matches the batch, including a no-op write", () => {
    const two = [write("g1"), write("g2")];
    expect(
      resultFrom({ applied: 2, refused: null, reason: null }, two),
    ).toEqual({ ok: true });
  });
});
