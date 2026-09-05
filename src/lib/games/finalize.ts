import { createClient } from "@/utils/supabase/server";
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
export async function finalizeGameById(gameId: string, actorId: string) {
  const supabase = await createClient();

  const { data: game } = await supabase
    .from("games")
    .select("id, home_team_id, away_team_id")
    .eq("id", gameId)
    .single();
  if (!game) return;

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

  const { error } = await supabase
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
    .eq("id", gameId);
  check(error, "Finalize game");

  void logAudit({
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
