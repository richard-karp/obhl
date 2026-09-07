import { createAdminClient } from "@/utils/supabase/admin";
import type { Database } from "@/lib/db/types";
import { logAudit } from "@/lib/audit";
import {
  applyGameWrites,
  type GameWrite,
  type GameWriteDeps,
} from "@/lib/schedule/gameWrites";

type Admin = ReturnType<typeof createAdminClient>;

/** The generated union, so a typo in a caller is a compile error, not a silent no-match. */
type GameStatus = Database["public"]["Enums"]["game_status"];

/* ------------------------------------------------- the one game-write shape */

/**
 * `applyGameWrites` bound to Supabase, plus the audit trail its failures need.
 *
 * The decision, the compensation and every branch of it live in
 * `@/lib/schedule/gameWrites` — pure, and unit-tested there, because none of
 * those branches is reachable against a real database without two sessions and
 * a lot of luck. This is only the I/O and the record-keeping.
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
   * for them "scheduled" is the whole of the contract — see the comment on the
   * condition below, which this parameter replaced rather than relaxed.
   *
   * The manual edit actions pass a wider set on purpose: the user decided that
   * postponed and cancelled games stay editable, since neither carries a
   * result. `final` is never in it, and `editGuards.editable` separately refuses
   * any row holding goals, so "a game somebody has started scoring" is still
   * out of reach by two independent checks.
   */
  statuses: readonly GameStatus[] = ["scheduled"],
  /**
   * Restrict every read and write to one side of the draft/published divide.
   *
   * ⛔ A SEASON HOLDS BOTH AT ONCE. `publishMode` returns "replace" exactly when
   * a draft is staged over a live schedule, and in that state an unscoped read
   * returns the union — which lets a caller pair a published game with a draft
   * one and write both. Each set then separately has a team a game short and
   * another a game long, while a union-to-union balance check reports no change
   * at all. Undefined keeps the old unscoped behaviour for callers that only
   * ever see one set anyway.
   */
  isDraft?: boolean,
): Promise<string | null> {
  const deps: GameWriteDeps = {
    async read(ids) {
      let q = admin
        .from("games")
        .select("id, status, scheduled_at, home_team_id, away_team_id, label")
        .eq("season_id", seasonId)
        .in("id", ids);
      if (isDraft !== undefined) q = q.eq("is_draft", isDraft);
      const { data, error } = await q;
      return error ? { error: error.message } : { rows: data ?? [] };
    },
    async update(id, values, expect) {
      let q = admin
        .from("games")
        .update(values)
        .eq("id", id)
        // A stale id from another season cannot be reached even though these
        // ids came from this season's own read.
        .eq("season_id", seasonId)
        // A game somebody has started scoring is not ours to rewrite.
        // See `statuses` above for who widens this and why.
        .in("status", statuses);
      // ⛔ The write is scoped the same way the read is, so a stale id from the
      // other side of the divide cannot be reached even though the pre-flight
      // already refused it. Two independent refusals, same reason.
      if (isDraft !== undefined) q = q.eq("is_draft", isDraft);
      for (const [col, want] of Object.entries(expect)) {
        // ⛔ `.eq(col, null)` MATCHES NOTHING in PostgREST — SQL's `= NULL` is
        // never true. `label` is null on most games, so an unconditioned `.eq`
        // here would make every forward write match zero rows and turn the
        // whole feature into a permanent "the schedule changed" refusal.
        q = want === null ? q.is(col, null) : q.eq(col, want);
      }
      const { data, error } = await q.select("id");
      return error ? { error: error.message } : { matched: data?.length ?? 0 };
    },
  };

  const result = await applyGameWrites(deps, writes);
  if (result.ok) return null;

  // ⛔ THE HALF-APPLIED BATCH GOES IN THE AUDIT LOG, NOT ONLY IN A TOAST.
  // The stuck ids used to come back as a message on a page the manager can
  // close, and reloading lost them permanently — the only record of which rows
  // need fixing by hand, held in a string. Everything else destructive in this
  // file is audited; this is the one case where the audit is the ONLY way to
  // find out what happened at all.
  //
  // Awaited, and only on a failure: a success is evident from the games
  // themselves, while this record cannot be reconstructed from anything.
  if (result.stuck.length > 0) {
    // ⛔ AND THE PLATFORM LOG TOO. `logAudit` swallows its own errors by design
    // — an audit failure must not turn a successful action into a reported one
    // — which means the audit row is not a guarantee. These ids are the only
    // way to find out which games are half-changed, so they go somewhere that
    // does not depend on the database being reachable.
    console.error(
      `${action}: games left half-changed in season ${seasonId}:`,
      result.stuck.join(", "),
      result.message,
    );
  }
  if (result.stuck.length > 0 || result.kind === "failed") {
    await logAudit({
      user_id: userId,
      action: `${action}_failed`,
      entity_type: "season",
      entity_id: seasonId,
      old_data: { attempted: result.attempted },
      new_data: {
        outcome: result.kind,
        stuck: result.stuck,
        message: result.message,
      },
    });
  }
  return result.message;
}
