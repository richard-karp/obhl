import { describe, it, expect } from "vitest";
import {
  applyGameWrites,
  MAX_GAME_WRITES,
  type GameFields,
  type GameRow,
  type GameWrite,
  type GameWriteDeps,
  type UpdateOutcome,
} from "./gameWrites";

/**
 * A fake `games` table with the same conditional-update semantics PostgREST
 * gives us: an update applies only while every expected column still matches,
 * and reports how many rows it touched.
 *
 * The point of the whole extraction is that the branches below — a concurrent
 * edit, a mid-batch failure, a compensation that itself fails, a lost response —
 * are all reachable here and none of them are reachable against a real database
 * without two sessions and a lot of luck.
 */
function fakeDb(rows: GameRow[]) {
  const table = new Map(rows.map((r) => [r.id, { ...r }]));
  const log: string[] = [];
  /** `${id}#${nth call for that id}` → the outcome to return instead. */
  const faults = new Map<string, UpdateOutcome>();
  /** Rows whose update reports an error but commits anyway — a lost response. */
  const lostResponses = new Set<string>();
  /** How many update calls each row has seen, so a fault can target the undo. */
  const calls = new Map<string, number>();
  /** Runs before a given call — lets a test slip another manager's write in. */
  let interpose: ((id: string, nth: number) => void) | null = null;

  const deps: GameWriteDeps = {
    async read(ids) {
      log.push(`read:${ids.join(",")}`);
      return {
        rows: ids.flatMap((id) => (table.has(id) ? [table.get(id)!] : [])),
      };
    },
    async update(id, values, expect) {
      log.push(`update:${id}`);
      const nth = (calls.get(id) ?? 0) + 1;
      calls.set(id, nth);
      interpose?.(id, nth);
      const row = table.get(id);
      const apply = () => {
        Object.assign(row!, values);
      };
      const matches =
        !!row &&
        row.status === "scheduled" &&
        (Object.keys(expect) as (keyof typeof expect)[]).every(
          (k) => row[k as keyof GameRow] === expect[k],
        );
      if (lostResponses.has(id)) {
        lostResponses.delete(id);
        if (matches) apply();
        return { error: "network went away" };
      }
      const fault = faults.get(`${id}#${nth}`);
      if (fault) return fault;
      if (!matches) return { matched: 0 };
      apply();
      return { matched: 1 };
    },
  };

  return {
    deps,
    log,
    table,
    /** Fail the `nth` update call for `id` (1 = the forward write, 2 = its undo). */
    failCall: (id: string, nth: number, outcome: UpdateOutcome) =>
      faults.set(`${id}#${nth}`, outcome),
    failNext: (id: string, outcome: UpdateOutcome) =>
      faults.set(`${id}#1`, outcome),
    loseResponse: (id: string) => lostResponses.add(id),
    /** Run `fn` just before a numbered update call — another session's write. */
    before: (fn: (id: string, nth: number) => void) => {
      interpose = fn;
    },
    updates: () => log.filter((l) => l.startsWith("update:")),
    row: (id: string) => table.get(id)!,
  };
}

const AT = "2027-01-05T19:00:00-05:00";

const row = (id: string, over: Partial<GameRow> = {}): GameRow => ({
  id,
  status: "scheduled",
  scheduled_at: AT,
  home_team_id: "A",
  away_team_id: "B",
  label: null,
  ...over,
});

/** Re-point a game at a new matchup — the repair and one-off shape. */
const repoint = (
  id: string,
  next: GameFields,
  prev: GameFields,
): GameWrite => ({ id, next, prev, expectScheduledAt: AT });

describe("applyGameWrites", () => {
  it("writes nothing and succeeds on an empty batch", async () => {
    const db = fakeDb([]);
    expect(await applyGameWrites(db.deps, [])).toEqual({ ok: true });
    expect(db.log).toEqual([]);
  });

  it("applies every write when nothing is in the way", async () => {
    const db = fakeDb([row("g1"), row("g2", { home_team_id: "C" })]);
    const res = await applyGameWrites(db.deps, [
      repoint("g1", { home_team_id: "X" }, { home_team_id: "A" }),
      repoint("g2", { home_team_id: "Y" }, { home_team_id: "C" }),
    ]);
    expect(res.ok).toBe(true);
    expect(db.row("g1").home_team_id).toBe("X");
    expect(db.row("g2").home_team_id).toBe("Y");
  });

  /** ⛔ A programmer error, and loud: an undo that leaves a column changed. */
  it("throws when next and prev name different columns", async () => {
    const db = fakeDb([row("g1")]);
    await expect(
      applyGameWrites(db.deps, [
        repoint(
          "g1",
          { home_team_id: "X", label: "Final" },
          { home_team_id: "A" },
        ),
      ]),
    ).rejects.toThrow(/does not restore/);
  });

  it("refuses a batch bigger than the stated ceiling, writing nothing", async () => {
    const rows = Array.from({ length: MAX_GAME_WRITES + 1 }, (_, i) =>
      row(`g${i}`),
    );
    const db = fakeDb(rows);
    const res = await applyGameWrites(
      db.deps,
      rows.map((r) =>
        repoint(r.id, { home_team_id: "X" }, { home_team_id: "A" }),
      ),
    );
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.message).toMatch(/more than this can apply/);
    expect(db.log).toEqual([]); // not even the pre-flight read
  });

  describe("the pre-flight", () => {
    it("refuses when a row has been scored since the plan was built", async () => {
      const db = fakeDb([row("g1", { status: "final" })]);
      const res = await applyGameWrites(db.deps, [
        repoint("g1", { home_team_id: "X" }, { home_team_id: "A" }),
      ]);
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.kind).toBe("conflict");
      expect(db.log.some((l) => l.startsWith("update"))).toBe(false);
    });

    it("refuses when a row has been re-timed since the plan was built", async () => {
      const db = fakeDb([
        row("g1", { scheduled_at: "2027-02-02T19:00:00-05:00" }),
      ]);
      const res = await applyGameWrites(db.deps, [
        repoint("g1", { home_team_id: "X" }, { home_team_id: "A" }),
      ]);
      expect(res.ok).toBe(false);
      expect(db.log.some((l) => l.startsWith("update"))).toBe(false);
    });

    /** Another manager's apply landed first: their matchup is on the row. */
    it("refuses when a row no longer holds what the plan expected", async () => {
      const db = fakeDb([row("g1", { home_team_id: "SOMEONE-ELSE" })]);
      const res = await applyGameWrites(db.deps, [
        repoint("g1", { home_team_id: "X" }, { home_team_id: "A" }),
      ]);
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.kind).toBe("conflict");
      expect(db.log.some((l) => l.startsWith("update"))).toBe(false);
    });

    it("refuses when a row is gone entirely, rather than re-creating it", async () => {
      const db = fakeDb([]);
      const res = await applyGameWrites(db.deps, [
        repoint("g1", { home_team_id: "X" }, { home_team_id: "A" }),
      ]);
      expect(res.ok).toBe(false);
      expect(db.log.some((l) => l.startsWith("update"))).toBe(false);
    });
  });

  describe("compensation", () => {
    it("puts earlier writes back when a later one fails", async () => {
      const db = fakeDb([row("g1"), row("g2"), row("g3")]);
      db.failNext("g3", { error: "boom" });
      const res = await applyGameWrites(db.deps, [
        repoint("g1", { home_team_id: "X" }, { home_team_id: "A" }),
        repoint("g2", { home_team_id: "Y" }, { home_team_id: "A" }),
        repoint("g3", { home_team_id: "Z" }, { home_team_id: "A" }),
      ]);
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.kind).toBe("failed");
        expect(res.stuck).toEqual([]);
      }
      // Whole or not at all: the first two are back where they started.
      expect(db.row("g1").home_team_id).toBe("A");
      expect(db.row("g2").home_team_id).toBe("A");
      expect(db.row("g3").home_team_id).toBe("A");
    });

    it("reports a refused undo as stuck rather than as success", async () => {
      const db = fakeDb([row("g1"), row("g2")]);
      db.failNext("g2", { error: "boom" });
      // g1's UNDO — its second update call — is refused. That is the double
      // fault the header concedes, and it has to come back named rather than
      // swallowed into a cheerful "nothing was written".
      db.failCall("g1", 2, { matched: 0 });
      const res = await applyGameWrites(db.deps, [
        repoint("g1", { home_team_id: "X" }, { home_team_id: "A" }),
        repoint("g2", { home_team_id: "Y" }, { home_team_id: "A" }),
      ]);
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.kind).toBe("stuck");
        expect(res.stuck).toEqual(["g1"]);
        expect(res.message).toMatch(/checking by hand/);
      }
      // And it is telling the truth: g1 really is still changed.
      expect(db.row("g1").home_team_id).toBe("X");
    });

    /**
     * ⛔ THE COMPENSATOR MUST NOT BE A LOST-UPDATE WRITER. Its WHERE has to name
     * the columns THIS function wrote, or it cannot tell "still as I left it"
     * from "somebody else's completed apply sits here now" — and it reverts
     * them. Conditioned the old way (id + season + status + scheduled_at only)
     * this undo would have overwritten the intervening write.
     */
    /**
     * ⛔ THE COMPENSATOR MUST NOT BE A LOST-UPDATE WRITER. Its WHERE has to name
     * the columns THIS function wrote, or it cannot tell "still as I left it"
     * from "somebody else's completed apply sits here now" — and it reverts
     * them. Conditioned the old way (id + season + status + scheduled_at only)
     * the undo below matched happily and overwrote the intervening write.
     */
    it("refuses to undo a row somebody else has since re-pointed", async () => {
      const db = fakeDb([row("g1"), row("g2")]);
      db.failNext("g2", { error: "boom" });
      // Another manager's apply lands on g1 between our write and our undo.
      db.before((id, nth) => {
        if (id === "g1" && nth === 2) db.row("g1").home_team_id = "THEIRS";
      });
      const res = await applyGameWrites(db.deps, [
        repoint("g1", { home_team_id: "X" }, { home_team_id: "A" }),
        repoint("g2", { home_team_id: "Y" }, { home_team_id: "A" }),
      ]);
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.kind).toBe("stuck");
        expect(res.stuck).toEqual(["g1"]);
      }
      // The point: their write survives, and we say we could not clean up.
      expect(db.row("g1").home_team_id).toBe("THEIRS");
    });

    it("undoes newest first", async () => {
      const db = fakeDb([row("g1"), row("g2"), row("g3")]);
      db.failNext("g3", { error: "boom" });
      await applyGameWrites(db.deps, [
        repoint("g1", { home_team_id: "X" }, { home_team_id: "A" }),
        repoint("g2", { home_team_id: "Y" }, { home_team_id: "A" }),
        repoint("g3", { home_team_id: "Z" }, { home_team_id: "A" }),
      ]);
      const all = db.updates();
      const undos = all.slice(all.indexOf("update:g3") + 1);
      expect(undos).toEqual(["update:g2", "update:g1"]);
    });
  });

  /**
   * ⛔ A LOST RESPONSE IS NOT A FAILED WRITE. postgrest-js retries GET/HEAD/
   * OPTIONS only and turns a rejected fetch into `{ error }`, so a PATCH that
   * committed and lost its response looks exactly like one that never left.
   * Reporting "nothing was written" about a row that HAS changed is the
   * whole-or-nothing violation this branch closes — on a single fault.
   */
  describe("a lost response", () => {
    it("re-reads, finds the write landed, and undoes it", async () => {
      const db = fakeDb([row("g1"), row("g2")]);
      db.loseResponse("g2");
      const res = await applyGameWrites(db.deps, [
        repoint("g1", { home_team_id: "X" }, { home_team_id: "A" }),
        repoint("g2", { home_team_id: "Y" }, { home_team_id: "A" }),
      ]);
      expect(res.ok).toBe(false);
      // Both rows are back: g2's committed write was found by the re-read and
      // undone rather than reported as "never happened".
      expect(db.row("g1").home_team_id).toBe("A");
      expect(db.row("g2").home_team_id).toBe("A");
    });

    it("reports indeterminate when the re-read cannot settle it", async () => {
      const db = fakeDb([row("g1")]);
      // The connection is gone: the write's response is lost AND the re-read
      // that would settle whether it landed cannot get through either.
      let wrote = false;
      const deps: GameWriteDeps = {
        read: async (ids) =>
          wrote ? { error: "still down" } : db.deps.read(ids),
        update: async () => {
          wrote = true;
          return { error: "network went away" };
        },
      };
      const res = await applyGameWrites(deps, [
        repoint("g1", { home_team_id: "X" }, { home_team_id: "A" }),
      ]);
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.kind).toBe("indeterminate");
        expect(res.stuck).toEqual(["g1"]);
        expect(res.message).toMatch(/checking by hand/);
      }
    });
  });

  it("carries the attempted payload for the audit trail", async () => {
    const db = fakeDb([row("g1", { status: "final" })]);
    const res = await applyGameWrites(db.deps, [
      repoint("g1", { home_team_id: "X" }, { home_team_id: "A" }),
    ]);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.attempted).toEqual([
        { id: "g1", next: { home_team_id: "X" } },
      ]);
    }
  });

  /** The night move: the written column IS the condition. */
  it("moves a night's times and undoes them on a later failure", async () => {
    const to = "2027-01-12T19:00:00-05:00";
    const db = fakeDb([row("g1"), row("g2")]);
    db.failNext("g2", { error: "boom" });
    const res = await applyGameWrites(db.deps, [
      {
        id: "g1",
        next: { scheduled_at: to },
        prev: { scheduled_at: AT },
        expectScheduledAt: AT,
      },
      {
        id: "g2",
        next: { scheduled_at: to },
        prev: { scheduled_at: AT },
        expectScheduledAt: AT,
      },
    ]);
    expect(res.ok).toBe(false);
    expect(db.row("g1").scheduled_at).toBe(AT);
    expect(db.row("g2").scheduled_at).toBe(AT);
  });
});
