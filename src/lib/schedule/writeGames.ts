import { createAdminClient } from "@/utils/supabase/admin";
import type { Database } from "@/lib/db/types";
import { logAudit } from "@/lib/audit";
import {
  checkWrites,
  payloadFor,
  resultFrom,
  type ApplyOutcome,
  type GameWrite,
} from "@/lib/schedule/gameWrites";

type Admin = ReturnType<typeof createAdminClient>;

/** The generated union, so a typo in a caller is a compile error, not a silent no-match. */
type GameStatus = Database["public"]["Enums"]["game_status"];

/* ------------------------------------------------- the one game-write shape */

/**
 * The single write path for game rows: `apply_game_writes` (`0045`), plus the
 * audit trail its failures need.
 *
 * ⛔ ONE CALL, ONE TRANSACTION, AND THE CALLER CANNOT SEE A PARTIAL RESULT.
 * This used to be a pre-flight read, a conditional `UPDATE` per row in parallel
 * chunks, and a compensator that undid the ones that had landed when a later
 * one failed. All of that is gone — not simplified, gone — because the function
 * serializes on the season with an advisory lock and rolls back for free. The
 * consequence worth knowing: **there is no longer any such thing as a
 * half-applied batch**, so nothing downstream needs to describe one.
 */
export async function writeGames(
  admin: Admin,
  seasonId: string,
  userId: string,
  action: string,
  writes: GameWrite[],
  /**
   * Which statuses a row may hold and still be rewritten.
   *
   * ⛔ THE DEFAULT IS THE OLD BEHAVIOUR AND MUST STAY THAT WAY. Generate,
   * repair and the one-off planner all rewrite fixtures nobody has touched, and
   * for them "scheduled" is the whole of the contract. Passed straight through
   * to the function as `p_statuses`.
   */
  statuses: readonly GameStatus[] = ["scheduled"],
  /**
   * Restrict the write to one side of the draft/published divide.
   *
   * ⛔ A SEASON HOLDS BOTH AT ONCE. `publishMode` returns "replace" exactly when
   * a draft is staged over a live schedule, and in that state an unscoped write
   * lets a caller pair a published game with a draft one — each set then
   * separately has a team a game short and another a game long, while a
   * union-to-union balance check reports no change at all. `undefined` keeps the
   * unscoped behaviour for callers that only ever see one set anyway, and
   * becomes `p_is_draft => null` in SQL.
   */
  isDraft?: boolean,
): Promise<string | null> {
  if (writes.length === 0) return null;

  const early = checkWrites(writes);
  if (early && !early.ok) {
    await auditFailure(
      userId,
      action,
      seasonId,
      early.kind,
      early.message,
      writes,
    );
    return early.message;
  }

  const { data, error } = await admin.rpc("apply_game_writes", {
    p_season: seasonId,
    p_writes: payloadFor(writes),
    p_statuses: [...statuses],
    // ⚠️ `undefined` OMITS THE ARGUMENT, which is what the unscoped case wants:
    // the function defaults `p_is_draft` to null and treats null as "both
    // sides". Passing an explicit null instead is a type error — the generated
    // Args type has it as optional `boolean`, not nullable — so the shape of
    // the generated types is what enforces this, not a convention.
    p_is_draft: isDraft,
  });

  if (error) {
    // ⛔ A THROWN OR REFUSED CALL WROTE NOTHING. That is a guarantee now, not a
    // hope: the function's single `UPDATE` either commits whole or rolls back,
    // and a transport failure cannot leave rows behind for the same reason.
    // Before `0045` this branch had to re-read every row to find out.
    const message = `Couldn't save that. ${error.message} Nothing was written.`;
    await auditFailure(userId, action, seasonId, "failed", message, writes);
    return message;
  }

  // ⚠️ `returns table` comes back as an ARRAY of one row. An empty array would
  // mean the function returned no row at all, which it has no path to do —
  // treated as a refusal rather than as success, because reading `[0]` off an
  // empty array and finding `undefined` must not become "ok".
  //
  // ⛔ THE CAST IS LOAD-BEARING, NOT STYLISTIC. `supabase gen types` declares
  // `reason` and `refused` as non-nullable `string`, which is simply wrong —
  // both are null on every successful call. Without the cast the null checks
  // below read as dead code to the compiler. Do not "tidy" it away; fix the
  // generator's output first if you want it gone.
  const outcome = (data as ApplyOutcome[] | null)?.[0];
  if (!outcome) {
    const message =
      "Couldn't save that — the database returned nothing. Nothing was written.";
    await auditFailure(userId, action, seasonId, "failed", message, writes);
    return message;
  }

  const result = resultFrom(outcome, writes);
  if (result.ok) return null;
  await auditFailure(
    userId,
    action,
    seasonId,
    result.kind,
    result.message,
    writes,
    outcome.refused,
  );
  return result.message;
}

/**
 * The failure record.
 *
 * ⚠️ THIS USED TO BE THE ONLY WAY TO FIND OUT WHICH ROWS WERE HALF-CHANGED, and
 * it is not that any more — there are no half-changed rows. It stays because a
 * refused batch is still worth a trail: which plan was attempted, against which
 * season, and — new with `0045` — WHICH ROW refused it, which the old path
 * could not report at all.
 */
async function auditFailure(
  userId: string,
  action: string,
  seasonId: string,
  kind: string,
  message: string,
  writes: GameWrite[],
  refused: string | null = null,
) {
  await logAudit({
    user_id: userId,
    action: `${action}_failed`,
    entity_type: "season",
    entity_id: seasonId,
    old_data: { attempted: writes.map((w) => ({ id: w.id, next: w.next })) },
    new_data: { outcome: kind, refused, message },
  });
}
