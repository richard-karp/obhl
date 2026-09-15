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

/** The single write path for game rows, plus the audit its failures need. ⛔ One call, one
 *  transaction: no half-applied batch exists. RUNBOOK.md, _Schedule edits and exports_. */
export async function writeGames(
  admin: Admin,
  seasonId: string,
  userId: string,
  action: string,
  writes: GameWrite[],
  /** Statuses a row may hold and still be rewritten. ⛔ The default must stay `["scheduled"]`:
   *  generate, repair and the one-off planner rely on it. */
  statuses: readonly GameStatus[] = ["scheduled"],
  /** ⛔ A season can hold drafts and published games at once: unscoped, a write can pair one of
   *  each while a union-wide balance check sees no change. `undefined` means both sides. */
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
    // ⚠️ `undefined` omits the argument, which the function reads as "both sides"; an explicit
    // null is a type error, so the generated types enforce it.
    p_is_draft: isDraft,
  });

  if (error) {
    // ⛔ A thrown or refused call wrote nothing: the single UPDATE commits whole or rolls back.
    const message = `Couldn't save that. ${error.message} Nothing was written.`;
    await auditFailure(userId, action, seasonId, "failed", message, writes);
    return message;
  }

  // ⚠️ `returns table` is an array of one row; an empty one is a refusal, never "ok".
  // ⛔ Keep the cast: the generated types wrongly mark `reason` and `refused` non-nullable.
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

/** A refused batch's trail: the plan attempted, the season, and which row refused it. */
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
