/**
 * The single in-place write path for game rows, and its compensation.
 *
 * ⛔ **AN `UPDATE`, NEVER AN `UPSERT`. THIS IS THE DECISION — read it before
 * changing the shape.**
 *
 * `upsert(rows, { onConflict: "id" })` looks like the safer, more atomic choice
 * — one statement, so a plan cannot land half-applied — and it is the wrong one.
 * PostgREST's upsert **INSERTS when no row matches the id**, and a row can stop
 * matching between the read and the write (a replace, a removal, a discard). The
 * inserted row takes column defaults for everything the payload omits, and
 * `0004_games.sql` defaults `is_draft` to **false**, `status` to `'scheduled'`
 * and both goal columns to 0. So a game deleted a moment ago comes back as a
 * LIVE, unplayed fixture that nobody scheduled, in the public schedule, both
 * calendar feeds and the CSV. Fabricating a row is strictly worse than failing
 * to write one: a partial write is visible and repairable, an invented game is
 * neither.
 *
 * ⚠️ **WHAT THIS DOES NOT GIVE YOU, STATED PLAINLY.** `UPDATE` cannot insert,
 * and that is all it cannot do. It is NOT atomic across rows, and the rest of
 * this module is damage control rather than a transaction:
 *
 *  - **The intermediate states are publicly readable.** For as long as the
 *    writes take, `games` holds a partially-permuted night, and the public
 *    schedule page, both iCal feeds and the CSV all read live — so a team can
 *    visibly play twice on one night until the batch finishes.
 *    `checkOneOffWrite` guarantees that never happens in the *result*; it says
 *    nothing about the middle. Writes therefore go out in parallel chunks, so
 *    the window is a small number of round-trips rather than one per game.
 *  - **A runtime that dies mid-batch leaves writes applied, uncompensated and
 *    unreported.** Nothing here survives the process.
 *
 * Only a database function could close those, and one is deliberately not being
 * added days before a season locks. `MAX_GAME_WRITES` bounds the exposure so it
 * is at least a stated quantity.
 *
 * Pure: it talks to the database through `GameWriteDeps`, so every branch below
 * — the conflict, the mid-sequence failure, the compensation and its own
 * failure — is testable without one.
 */

/** The columns any caller here is allowed to rewrite. */
export type GameFields = {
  home_team_id?: string;
  away_team_id?: string;
  label?: string | null;
  scheduled_at?: string;
};

/** A row as the pre-flight and the post-failure re-read see it. */
export type GameRow = {
  id: string;
  status: string;
  scheduled_at: string | null;
  home_team_id: string;
  away_team_id: string;
  label: string | null;
};

/**
 * One game row to rewrite in place.
 *
 * ⛔ `next` and `prev` must name the SAME columns — `prev` is what the row is
 * required to hold for the write to apply, and what the undo puts back. A `prev`
 * missing a key `next` sets is an undo that leaves that column changed.
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
   * and apply is `gameIds` on the change, enforced by `checkOneOffWrite`; an
   * earlier version of this comment claimed the guarantee for this field, and
   * the old upsert it replaced never had it either.
   */
  expectScheduledAt: string;
};

export type WriteFailure = {
  /**
   * `conflict` — somebody else got there first; nothing was written.
   * `failed` — the database refused; nothing was written.
   * `stuck` — a write landed and could not be undone. Rows are half-changed.
   * `indeterminate` — a write's outcome is unknown. Treated as `stuck`.
   */
  kind: "conflict" | "failed" | "stuck" | "indeterminate";
  message: string;
  /** Game ids left in an unknown or half-applied state. Empty unless stuck. */
  stuck: string[];
  /** What was attempted, for the audit trail. */
  attempted: { id: string; next: GameFields }[];
};

export type WriteResult = { ok: true } | ({ ok: false } & WriteFailure);

export type UpdateOutcome = { matched: number } | { error: string };

export type GameWriteDeps = {
  /** Read these rows. Missing ids simply do not come back. */
  read(ids: string[]): Promise<{ rows: GameRow[] } | { error: string }>;
  /**
   * Conditional update: set `values` on the row with `id`, but ONLY while it
   * still matches every column in `expect` and its status is still `scheduled`.
   * `matched` is the number of rows actually written — anything but 1 is a
   * refusal, never a retry.
   */
  update(
    id: string,
    values: GameFields,
    expect: GameFields & { scheduled_at: string },
  ): Promise<UpdateOutcome>;
};

/**
 * The most rows one call will write.
 *
 * Not a guess at a safe number — the payload is CLIENT-SUPPLIED, and while
 * `checkOneOffWrite` bounds it to real nights of one season, an explicit ceiling
 * is what makes the publicly-visible window above a stated quantity rather than
 * an open one. A whole season is ~144 games; a repair touching more than this
 * has gone wrong somewhere upstream.
 */
export const MAX_GAME_WRITES = 200;

const KEYS: (keyof GameFields)[] = [
  "home_team_id",
  "away_team_id",
  "label",
  "scheduled_at",
];

/** How many rows go out at once — see the parallelism note in the header. */
const CHUNK = 25;

/**
 * How many ids one read asks for.
 *
 * ⚠️ PostgREST takes an id list as `in.(…)` in the QUERY STRING, and a UUID
 * costs ~39 bytes there. At `MAX_GAME_WRITES` that is ~7.8KB of request line,
 * which is close enough to the 8KB default in nginx, Node and most proxies that
 * a big repair would start failing on the pre-flight with something unhelpful.
 * Chunked here rather than in the Supabase adapter so the behaviour is testable.
 */
const READ_CHUNK = 50;

/** `deps.read` over any number of ids, in request-sized batches. */
async function readRows(
  deps: GameWriteDeps,
  ids: string[],
): Promise<{ rows: GameRow[] } | { error: string }> {
  const rows: GameRow[] = [];
  for (let i = 0; i < ids.length; i += READ_CHUNK) {
    const page = await deps.read(ids.slice(i, i + READ_CHUNK));
    if ("error" in page) return page;
    rows.push(...page.rows);
  }
  return { rows };
}

const sameKeys = (a: GameFields, b: GameFields) => {
  const ka = KEYS.filter((k) => k in a);
  const kb = KEYS.filter((k) => k in b);
  return ka.length === kb.length && ka.every((k) => kb.includes(k));
};

/** Does a row still hold every column this write expects? */
const holds = (row: GameRow, fields: GameFields) =>
  KEYS.every((k) => !(k in fields) || row[k] === fields[k]);

/**
 * What the row should hold once `w` has been written — the undo's condition.
 *
 * ⛔ The undo conditions on the columns THIS FUNCTION WROTE, not merely on the
 * ones the forward write conditioned on. Those are the same thing only for a
 * caller whose written column IS its condition (the night move, which writes
 * `scheduled_at`). For the repair and the one-off, `next` carries the team ids
 * and the label while `scheduled_at` is unchanged — so an undo conditioned the
 * old way had a WHERE byte-identical to the forward write's, could not see that
 * another manager's apply had re-pointed the row in between, and reverted it.
 * A compensator that is itself a lost-update writer is worse than the drift it
 * was added to prevent: it silently undoes a COMPLETED apply.
 */
const written = (w: GameWrite): GameFields & { scheduled_at: string } => ({
  ...w.next,
  scheduled_at: w.next.scheduled_at ?? w.expectScheduledAt,
});

/** What the row must hold for the forward write to apply. */
const expected = (w: GameWrite): GameFields & { scheduled_at: string } => ({
  ...w.prev,
  scheduled_at: w.expectScheduledAt,
});

export async function applyGameWrites(
  deps: GameWriteDeps,
  writes: GameWrite[],
): Promise<WriteResult> {
  if (writes.length === 0) return { ok: true };

  const attempted = writes.map((w) => ({ id: w.id, next: w.next }));
  const fail = (
    kind: WriteFailure["kind"],
    message: string,
    stuck: string[] = [],
  ): WriteResult => ({ ok: false, kind, message, stuck, attempted });

  if (writes.length > MAX_GAME_WRITES) {
    return fail(
      "failed",
      `That plan changes ${writes.length} games, which is more than this can apply in one go. Nothing was written.`,
    );
  }
  for (const w of writes) {
    // A programmer error, not a runtime condition: both sides are built from
    // the same row by every caller. Loud, because a silent mismatch is an undo
    // that leaves a column changed.
    if (!sameKeys(w.next, w.prev)) {
      throw new Error(
        `Game write for ${w.id} sets columns its undo does not restore.`,
      );
    }
  }

  // 1. Pre-flight, so a concurrent edit is caught before ANY row is written
  //    rather than halfway through. It keeps compensation a rare path — it is
  //    NOT the guard: it is a read, the writes come after it, and only the
  //    conditional UPDATE below closes that window.
  const before = await readRows(
    deps,
    writes.map((w) => w.id),
  );
  if ("error" in before) return fail("failed", before.error);
  const seen = new Map(before.rows.map((r) => [r.id, r] as const));
  for (const w of writes) {
    const row = seen.get(w.id);
    if (
      !row ||
      row.status !== "scheduled" ||
      row.scheduled_at !== w.expectScheduledAt ||
      !holds(row, w.prev)
    ) {
      return fail(
        "conflict",
        "The schedule changed while this was on screen — preview it again. Nothing was written.",
      );
    }
  }

  // 2. Write, in parallel chunks, remembering what to undo.
  //
  // ⛔ EVERY NON-MATCH IN THE CHUNK IS KEPT, NOT JUST THE FIRST. This loop used
  // to record one failure per batch and drop outcomes 2..25 on the floor —
  // never re-read, never compensated, never reported. The parallelism above is
  // exactly what made that likely rather than exotic: one network blip across
  // 25 concurrent PATCHes hits several of them, which is the ORDINARY shape of
  // the fault. Two lost-but-committed responses in one chunk returned "Nothing
  // was written." with a game permanently changed; a genuine conflict at index
  // 0 alongside a committed lost response returned `conflict` with an empty
  // `stuck`, which the caller does not even audit.
  const applied: GameWrite[] = [];
  const failures: { w: GameWrite; outcome: UpdateOutcome }[] = [];

  for (let i = 0; i < writes.length && failures.length === 0; i += CHUNK) {
    const chunk = writes.slice(i, i + CHUNK);
    // ⛔ `allSettled`, not `all`. postgrest-js RETHROWS an `AbortError` rather
    // than returning it as `{ error }`, and `Promise.all` would let it escape
    // this function entirely — leaving the other 24 in-flight PATCHes to commit
    // with no compensation, no audit and no message.
    const settled = await Promise.allSettled(
      chunk.map((w) => deps.update(w.id, w.next, expected(w))),
    );
    settled.forEach((s, j) => {
      const w = chunk[j];
      const outcome: UpdateOutcome =
        s.status === "fulfilled" ? s.value : { error: String(s.reason) };
      if ("matched" in outcome && outcome.matched === 1) applied.push(w);
      else failures.push({ w, outcome });
    });
  }
  if (failures.length === 0) return { ok: true };

  // 3. Which of the failures actually landed?
  //
  // ⛔ A LOST RESPONSE IS NOT A FAILED WRITE. postgrest-js retries GET, HEAD and
  // OPTIONS only, and a rejected fetch comes back as `{ error }` rather than
  // throwing — so a PATCH that COMMITTED and whose response was lost is
  // indistinguishable here from one that never left. Rolling back and reporting
  // "nothing was written" would be a lie about a row that has in fact changed.
  // Re-read every one of them before deciding.
  //
  // A `matched` that is not 1 needs no re-read: PostgREST counts the rows it
  // wrote, so zero means the WHERE did not match and nothing happened.
  const errored = failures.filter((f) => "error" in f.outcome);
  const indeterminate = new Set<string>();
  if (errored.length > 0) {
    const after = await readRows(
      deps,
      errored.map((f) => f.w.id),
    );
    if ("error" in after) {
      // Cannot tell for any of them. All of these rows are now suspect.
      for (const f of errored) indeterminate.add(f.w.id);
    } else {
      const now = new Map(after.rows.map((r) => [r.id, r] as const));
      for (const f of errored) {
        const row = now.get(f.w.id);
        if (!row)
          indeterminate.add(f.w.id); // vanished; nothing to put back
        else if (holds(row, f.w.next))
          applied.push(f.w); // it landed after all
        else if (!holds(row, f.w.prev)) indeterminate.add(f.w.id); // neither state
      }
    }
  }

  // 4. Compensate, newest first. Each undo is conditional on what this function
  //    wrote (see `written`), so it refuses rather than clobbering a later edit
  //    by somebody else — and a refused undo is STUCK, not success.
  const stuck: string[] = [...indeterminate];
  for (const done of [...applied].reverse()) {
    // ⚠️ Unreachable by construction, and kept as a floor rather than as a
    // branch that fires: the classification above is an if/else chain over one
    // entry per id, so a write lands in `applied` or in `indeterminate` and
    // never both. No test covers it for that reason — a mutation removing it
    // survives the suite, which is the honest signal that it is dead. It stays
    // because the alternative, if the two ever did overlap, is writing to a row
    // whose state we just admitted we cannot establish.
    if (indeterminate.has(done.id)) continue;
    const undo = await deps.update(done.id, done.prev, written(done));
    if ("error" in undo || undo.matched !== 1) stuck.push(done.id);
  }

  if (stuck.length > 0) {
    return fail(
      indeterminate.size > 0 ? "indeterminate" : "stuck",
      `Couldn't finish, and couldn't fully undo it. These games are half-changed and need checking by hand: ${stuck.join(", ")}.`,
      stuck,
    );
  }
  // Everything is back where it started. Say WHY it stopped: a refusal the
  // manager can act on by re-previewing, or a database failure they cannot.
  const firstError = errored[0]?.outcome as { error: string } | undefined;
  return firstError
    ? fail(
        "failed",
        `Couldn't save that. ${firstError.error} Nothing was written.`,
      )
    : fail(
        "conflict",
        "The schedule changed while this was on screen — preview it again. Nothing was written.",
      );
}
