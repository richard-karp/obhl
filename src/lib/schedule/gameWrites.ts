// ⛔ The write (`apply_game_writes`, `0045`) is an UPDATE by id, never an upsert: an upsert
// re-inserts a deleted game as a live fixture. RUNBOOK.md, _Schedule edits and exports_.

/** The columns any caller here is allowed to rewrite. */
export type GameFields = {
  home_team_id?: string;
  away_team_id?: string;
  label?: string | null;
  scheduled_at?: string;
};

/** ⛔ `next` and `prev` must name the same columns: `prev` is what the row must still hold,
 *  so a key missing from it is a column written unchecked. */
export type GameWrite = {
  id: string;
  next: GameFields;
  /** The same columns, holding what they held when the plan was built. */
  prev: GameFields;
  /** `scheduled_at` as read moments ago. ⚠️ Guards only this request's read→write window;
   *  preview→apply is `gameIds`, enforced by `checkOneOffWrite`. */
  expectScheduledAt: string;
};

export type WriteFailure = {
  /** `conflict` or `failed`, and nothing was written. ⛔ No third outcome: `0045` is one
   *  transaction, so re-adding one means a write stopped going through it. */
  kind: "conflict" | "failed";
  message: string;
  /** What was attempted, for the audit trail. */
  attempted: { id: string; next: GameFields }[];
};

export type WriteResult = { ok: true } | ({ ok: false } & WriteFailure);

export type ApplyOutcome = {
  applied: number;
  refused: string | null;
  reason: string | null;
};

/** A sanity bound on a client-supplied payload (a season is ~144 games). ⚠️ Not a bound on a
 *  public half-applied window: `0045` has none. */
export const MAX_GAME_WRITES = 200;

const KEYS: (keyof GameFields)[] = [
  "home_team_id",
  "away_team_id",
  "label",
  "scheduled_at",
];

const sameKeys = (a: GameFields, b: GameFields) =>
  KEYS.every((k) => k in a === k in b);

/** Refusals that need no database; `null` means the batch is worth sending. */
export function checkWrites(writes: GameWrite[]): WriteResult | null {
  const attempted = writes.map((w) => ({ id: w.id, next: w.next }));

  if (writes.length > MAX_GAME_WRITES) {
    return {
      ok: false,
      kind: "failed",
      message: `That plan changes ${writes.length} games, which is more than this can apply in one go. Nothing was written.`,
      attempted,
    };
  }
  for (const w of writes) {
    // A programmer error, so loud: a silent mismatch is a column written without a check.
    if (!sameKeys(w.next, w.prev)) {
      throw new Error(
        `Game write for ${w.id} sets columns it does not check first.`,
      );
    }
  }
  // ⛔ The same game twice is a silently discarded write: `update … from` joins each row once
  // and reports `applied = 1`. `0045` refuses it too; this names the game.
  const seen = new Set<string>();
  for (const w of writes) {
    if (seen.has(w.id)) {
      throw new Error(`Game ${w.id} appears twice in one batch of writes.`);
    }
    seen.add(w.id);
  }
  return null;
}

/** `0045`'s `p_writes`. `expect` always adds `scheduled_at`: that is how a concurrent reschedule
 *  or postpone is caught on the repair path, whose plan names no time. */
export function payloadFor(writes: GameWrite[]) {
  return writes.map((w) => ({
    id: w.id,
    expect: { ...w.prev, scheduled_at: w.expectScheduledAt },
    next: w.next,
  }));
}

export function resultFrom(
  outcome: ApplyOutcome,
  writes: GameWrite[],
): WriteResult {
  const attempted = writes.map((w) => ({ id: w.id, next: w.next }));

  if (outcome.reason !== null) {
    return {
      ok: false,
      kind: "conflict",
      message:
        "The schedule changed while this was on screen — preview it again. Nothing was written.",
      attempted,
    };
  }

  // ⛔ `reason === null` is not enough: `applied` counts matched rows, so after the pre-check it
  // must equal the batch size, even for a no-op write. Anything less was reported as success.
  if (outcome.applied !== writes.length) {
    return {
      ok: false,
      kind: "failed",
      // ⚠️ Not "Nothing was written": the transaction committed, so some rows may have changed.
      // It should be unreachable; the message sends someone to look.
      message: `Couldn't save that. The database reported ${outcome.applied} of ${writes.length} games written — check the schedule before trying again.`,
      attempted,
    };
  }

  return { ok: true };
}
