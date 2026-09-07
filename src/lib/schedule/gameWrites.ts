/**
 * The payload and result shapes for the single in-place write path for game
 * rows. The write itself is `apply_game_writes` (`0045`), one transaction.
 *
 * ⛔ **AN `UPDATE`, NEVER AN `UPSERT`. THIS IS STILL THE DECISION**, and it now
 * lives in SQL rather than here. `upsert(rows, { onConflict: "id" })` looks like
 * the safer, more atomic choice and is the wrong one: PostgREST's upsert
 * **INSERTS when no row matches the id**, and a row can stop matching between
 * the read and the write (a replace, a removal, a discard). The inserted row
 * takes column defaults for everything the payload omits, and `0004_games.sql`
 * defaults `is_draft` to **false**, `status` to `'scheduled'` and both goal
 * columns to 0. So a game deleted a moment ago comes back as a LIVE, unplayed
 * fixture nobody scheduled, in the public schedule, both calendar feeds and the
 * CSV. Fabricating a row is strictly worse than failing to write one.
 *
 * ⚠️ **WHAT CHANGED, AND WHAT THIS FILE STOPPED BEING.** It used to carry the
 * damage control that an unserialized multi-row write needs: a pre-flight read,
 * a conditional `UPDATE` per row in parallel chunks, and — when one failed
 * partway — an attempt to undo the ones that had already landed. Three review
 * rounds each found the next bug one layer down (read-then-write with no
 * serialization; a compensator that was itself a lost-update writer; only the
 * first failure in each chunk kept). Each fix was correct, and the hole that
 * remained could not be closed in TypeScript at all: a runtime dying between a
 * write and its compensation leaves the written rows written.
 *
 * `0045` closes it by being one statement inside one transaction, under an
 * advisory lock on the season. So the compensation is gone, and with it the
 * `stuck` and `indeterminate` outcomes — **there can no longer be half-changed
 * rows**, which is the entire point. What is left here is what stayed pure:
 * the payload shape, the ceiling, and the mapping from the function's return to
 * something a caller can put in front of a manager.
 */

/** The columns any caller here is allowed to rewrite. */
export type GameFields = {
  home_team_id?: string;
  away_team_id?: string;
  label?: string | null;
  scheduled_at?: string;
};

/**
 * One game row to rewrite in place.
 *
 * ⛔ `next` and `prev` must name the SAME columns. `prev` is what the row is
 * required to still hold for the write to apply. A `prev` missing a key that
 * `next` sets is a write with an unchecked column — it was also, before `0045`,
 * an undo that left that column changed, which is why the check below is loud.
 */
export type GameWrite = {
  id: string;
  /** Columns to set. */
  next: GameFields;
  /** The same columns, holding what they held when the plan was built. */
  prev: GameFields;
  /**
   * `scheduled_at` as the caller read it, moments ago.
   *
   * ⚠️ THIS IS A READ→WRITE CHECK WITHIN ONE REQUEST, NOT PREVIEW→APPLY
   * PROTECTION. It closes the window between the caller's own read and this
   * write — a `finalizeGame` or `postponeGame` landing in those milliseconds —
   * and nothing longer. What protects a plan from a reschedule between PREVIEW
   * and apply is `gameIds` on the change, enforced by `checkOneOffWrite`.
   */
  expectScheduledAt: string;
};

export type WriteFailure = {
  /**
   * `conflict` — somebody else got there first; nothing was written.
   * `failed` — the database refused; nothing was written.
   *
   * ⛔ THERE IS NO THIRD OUTCOME ANY MORE, AND THAT IS THE POINT OF `0045`.
   * This union used to carry `stuck` and `indeterminate` for batches that
   * landed halfway and could not be undone. A transaction rolls back for free,
   * so those states no longer exist. If you find yourself re-adding one, the
   * write has stopped going through the function.
   */
  kind: "conflict" | "failed";
  message: string;
  /** What was attempted, for the audit trail. */
  attempted: { id: string; next: GameFields }[];
};

export type WriteResult = { ok: true } | ({ ok: false } & WriteFailure);

/** One row of `apply_game_writes`'s return. */
export type ApplyOutcome = {
  applied: number;
  refused: string | null;
  reason: string | null;
};

/**
 * The most rows one call will write.
 *
 * ⚠️ ITS RATIONALE CHANGED WITH `0045`, AND THE OLD ONE WOULD NOW BE A FALSE
 * CLAIM. This used to bound a publicly-visible window of half-permuted nights;
 * there is no such window any more, because the writes land in one transaction.
 * It stays as a sanity bound on a CLIENT-SUPPLIED payload: a whole season is
 * ~144 games, so a batch above this has gone wrong upstream, and the function
 * should not be asked to lock a season for it.
 */
export const MAX_GAME_WRITES = 200;

const KEYS: (keyof GameFields)[] = [
  "home_team_id",
  "away_team_id",
  "label",
  "scheduled_at",
];

const sameKeys = (a: GameFields, b: GameFields) =>
  KEYS.every((k) => k in a === k in b);

/**
 * Everything that can be refused without asking the database.
 *
 * `null` means the batch is worth sending. Kept separate from the call so it
 * stays unit-testable now that there are no injected deps to fake.
 */
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
    // A programmer error, not a runtime condition: both sides are built from
    // the same row by every caller. Loud, because a silent mismatch is a column
    // written without ever being checked.
    if (!sameKeys(w.next, w.prev)) {
      throw new Error(
        `Game write for ${w.id} sets columns it does not check first.`,
      );
    }
  }
  return null;
}

/**
 * The `p_writes` array `0045` expects.
 *
 * `expect` is `prev` plus `scheduled_at` always — that is how a concurrent
 * `rescheduleGame` or postpone is caught on the repair path, where the plan
 * does not otherwise name the time.
 */
export function payloadFor(writes: GameWrite[]) {
  return writes.map((w) => ({
    id: w.id,
    expect: { ...w.prev, scheduled_at: w.expectScheduledAt },
    next: w.next,
  }));
}

/** The function's return, in the words a manager reads. */
export function resultFrom(
  outcome: ApplyOutcome,
  writes: GameWrite[],
): WriteResult {
  if (outcome.reason === null) return { ok: true };
  return {
    ok: false,
    kind: "conflict",
    message:
      "The schedule changed while this was on screen — preview it again. Nothing was written.",
    attempted: writes.map((w) => ({ id: w.id, next: w.next })),
  };
}
