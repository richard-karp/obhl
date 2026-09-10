import { createClient } from "@/utils/supabase/server";
import type { DbClient } from "@/lib/db/helpers";
import { computeThreeStars } from "@/lib/utils/three-stars";
import { logAudit } from "@/lib/audit";
import { check, revalidateAfterScore } from "./shared";

/**
 * Finalizing and reopening a game — the DB work, shared by the scoresheet's
 * form actions and by reverting an audit entry.
 *
 * **Deliberately not in `lib/actions`.** Every export of a `"use server"` file
 * is a callable endpoint, so while these lived in `actions/games.ts` they were
 * two unguarded ones — `"Internal helper"` in a doc comment is not a boundary.
 * They took the actor as a parameter and `logAudit` writes on the admin client,
 * past RLS, so anyone able to reach them could file a finalize against any
 * league that had a readable game, attributed to any staff member they named.
 * (`check()` did not stop it: an RLS-refused UPDATE matches no rows and returns
 * no error, so a refused caller sailed through to the audit write.)
 *
 * A plain module cannot be reached from a browser at all, which is the fix. The
 * remaining contract is on the two callers, and both meet it: guard first, then
 * pass the id of the session you verified.
 *
 * The guard stays with the callers rather than moving in here on purpose —
 * `revertAuditEntries` calls these inside a per-entry try/catch, and a guard
 * that redirects would have its `NEXT_REDIRECT` swallowed as an entry-level
 * error and the redirect would never happen.
 */

/** Caller MUST have verified `actorId` against the session and the league. */
export async function finalizeGameById(
  gameId: string,
  /**
   * Who finalized it, or `null` for the nightly sweep.
   *
   * ⚠️ NULL IS A REAL VALUE HERE, not a missing one. `audit_log.user_id` is
   * nullable (`0021`) and the audit page renders a null actor, so a system close
   * is recorded honestly rather than attributed to whichever scorekeeper touched
   * the game last — which would be a lie in the one table that exists to say who
   * did what.
   */
  actorId: string | null,
  /**
   * The client every statement below runs on. Defaults to the caller's session.
   *
   * ⛔ THE NIGHTLY SWEEP MUST PASS THE ADMIN CLIENT, AND THIS PARAMETER EXISTS
   * BECAUSE OMITTING IT IS SILENT. A cron request carries no auth cookie, so
   * `createClient()` runs as `anon` — and then:
   *
   *  - the UPDATE below matches ZERO rows and returns NO error, because the
   *    `games` write policies are `to authenticated`. That is the trap this
   *    file's own docblock and `ACCESS_CONTROL_HANDOFF.md` both name: an
   *    RLS-refused UPDATE is not an error, so `check()` sails through.
   *  - `logAudit` writes on the ADMIN client regardless, so a `finalize_game`
   *    entry lands in the league's audit log for a game that was never
   *    finalized.
   *  - worse, the `game_rosters` read is gated by `public read final
   *    game_rosters` (`0008`), which exposes rows only for FINAL games — so an
   *    in-progress game reads back as zero rosters and the score would be
   *    written 0-0, destroying the very scores the sweep exists to preserve.
   *
   * All four statements have to run on the same privileged client; fixing only
   * the UPDATE turns a no-op into data loss.
   */
  client?: DbClient,
) {
  const supabase = client ?? (await createClient());

  const { data: game } = await supabase
    .from("games")
    .select("id, home_team_id, away_team_id")
    .eq("id", gameId)
    .single();
  // ⛔ THROW, DO NOT RETURN. A silent return is indistinguishable from a
  // completed finalize to every caller — `/api/cron/close-night` would count it
  // among the games it closed. The sweep selected this id moments earlier, so a
  // game that cannot now be read is an anomaly (a refused read reports no error
  // either), and the caller needs to hear about it.
  if (!game) {
    throw new Error(`Finalize game failed: ${gameId} could not be read.`);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: rostersRaw } = await (supabase as any)
    .from("game_rosters")
    .select(
      "team_id, goals, assists, pim, is_substitute, player_id, " +
        "players:players!game_rosters_player_id_fkey(first_name, last_name)",
    )
    .eq("game_id", gameId);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const rosters: any[] = rostersRaw ?? [];

  const sum = (teamId: string) =>
    rosters
      .filter((r) => r.team_id === teamId)
      .reduce((s: number, r) => s + (r.goals ?? 0), 0);

  const threeStars = computeThreeStars(
    rosters
      .filter((r) => !r.is_substitute && r.player_id)
      .map((r) => ({
        player_id: r.player_id,
        first_name: r.players?.first_name ?? "",
        last_name: r.players?.last_name ?? "",
        goals: r.goals ?? 0,
        assists: r.assists ?? 0,
        pim: r.pim ?? 0,
      })),
  );

  const { data: updated, error } = await supabase
    .from("games")
    .update({
      status: "final",
      home_goals: sum(game.home_team_id),
      away_goals: sum(game.away_team_id),
      result_type: "regulation",
      finalized_at: new Date().toISOString(),
      finalized_by: actorId,
      three_stars: threeStars as unknown as import("@/lib/db/types").Json,
    })
    .eq("id", gameId)
    // ⛔ `.select("id")` SO THE WRITE CAN BE PROVEN, NOT ASSUMED. An RLS-refused
    // UPDATE is not an error — it matches no rows and returns `error: null`, so
    // `check()` below cannot see it. Without the returned rows this function
    // succeeds silently on a write that did nothing, which is exactly how the
    // nightly sweep ran as `anon` for a week while reporting games closed.
    .select("id");
  check(error, "Finalize game");
  // ⛔ AND THIS THROW MUST STAY IN FRONT OF `logAudit`. The audit write runs on
  // the ADMIN client regardless of which client did the update, so returning
  // here — or auditing first — files a `finalize_game` entry for a game that was
  // never finalized: a false record in the one table whose job is saying what
  // happened. Throwing lets the caller count it as failed; `/api/cron/close-night`
  // reports that in its body, which is the only signal anyone gets at 2am.
  if (!updated?.length) {
    throw new Error(
      `Finalize game failed: no rows updated for ${gameId}. The statement was ` +
        "refused (an RLS-refused UPDATE reports no error) or the game is gone.",
    );
  }

  // ⛔ AWAITED, NOT `void`ed — because the nightly sweep calls this from a route
  // handler. On Vercel a function can be frozen the moment its response is sent,
  // so a fire-and-forget write after that point may simply never flush, and this
  // entry is the ONLY record that the system closed the game. `saveRules` awaits
  // its entry for the same class of reason: the entry is the only copy of
  // something. Watched in local dev: the entry landed ~200ms AFTER the route had
  // already returned, which is exactly the window that does not exist in
  // production.
  //
  // ⚠️ Safe to await: `logAudit` swallows its own errors, so this cannot fail a
  // finalize that already succeeded.
  await logAudit({
    user_id: actorId,
    action: "finalize_game",
    entity_type: "game",
    entity_id: gameId,
    new_data: {
      home_goals: sum(game.home_team_id),
      away_goals: sum(game.away_team_id),
    },
  });

  revalidateAfterScore(gameId, true);
}

/** Caller MUST have verified `actorId` against the session and the league. */
export async function reopenGameById(gameId: string, actorId: string) {
  const supabase = await createClient();
  const { error } = await supabase
    .from("games")
    .update({ status: "in_progress", finalized_at: null, finalized_by: null })
    .eq("id", gameId);
  check(error, "Reopen game");
  void logAudit({
    user_id: actorId,
    action: "reopen_game",
    entity_type: "game",
    entity_id: gameId,
  });
  revalidateAfterScore(gameId, true);
}
