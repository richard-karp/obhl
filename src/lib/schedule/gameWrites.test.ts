import { describe, it, expect } from "vitest";
import {
  checkWrites,
  payloadFor,
  resultFrom,
  MAX_GAME_WRITES,
  type GameWrite,
} from "./gameWrites";

/**
 * ⚠️ THIS FILE LOST TWO THIRDS OF ITS TESTS WITH `0045`, AND THAT IS THE
 * MEASURE OF SUCCESS RATHER THAN A GAP.
 *
 * It used to drive a fake `games` table through every branch of a compensating
 * writer: a concurrent edit, a mid-batch failure, an undo that itself failed, a
 * lost response that had actually committed, a row that vanished. Those tests
 * were the right ones for that design — none of those branches is reachable
 * against a real database without two sessions and a lot of luck — and every
 * one of them is now testing code that does not exist. The batch lands in one
 * transaction or not at all.
 *
 * ⛔ WHAT REPLACED THEM IS NOT IN THIS FILE, AND THAT IS THE THING TO KNOW. The
 * behaviour those tests approximated is now proven against a real Postgres and
 * recorded in `docs/superpowers/plans/2026-09-06-schedule-write-rpc.md`: the
 * two-psql race (same season blocks at 3.54s, different seasons at 0.04s) and a
 * mid-batch FK violation leaving all 18 rows unchanged. **Vitest cannot see a
 * lock.** That is exactly how the old compensator passed three rounds of unit
 * tests with a lost-update bug in it, so do not add a fake here and believe it
 * covers serialization.
 *
 * What is left below is what stayed pure and worth checking: the ceiling, the
 * same-columns rule, the payload shape the function is promised, and the
 * mapping from its return.
 */
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

  /**
   * ⛔ LOUD, NOT A REFUSAL. Every caller builds both sides from the same row, so
   * a mismatch is a programmer error — and it used to be an undo that left a
   * column changed. It is now a column written without ever being checked,
   * which is quieter and no less wrong.
   */
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
    // `label: null` is a real value to write and to check. If `in` were
    // replaced by a truthiness test, this pair would read as mismatched.
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

  /**
   * ⚠️ `scheduled_at` IS IN `expect` EVEN WHEN THE PLAN DOES NOT WRITE IT. That
   * is how a concurrent `rescheduleGame` or postpone is caught on the repair
   * path, which otherwise never names the time — drop it and the function has
   * nothing to notice the move by.
   */
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

  /**
   * ⚠️ `applied` IS NOT THE SUCCESS SIGNAL — `reason` IS. A batch can legally
   * apply zero rows (every row already holds what it should), and reading
   * `applied === writes.length` instead would report that as a conflict.
   */
  it("does not treat an applied count below the batch size as a failure", () => {
    expect(
      resultFrom({ applied: 0, refused: null, reason: null }, writes),
    ).toEqual({ ok: true });
  });
});
