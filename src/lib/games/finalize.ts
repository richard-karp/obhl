import { createClient } from "@/utils/supabase/server";
import type { DbClient } from "@/lib/db/helpers";
import { computeThreeStars } from "@/lib/utils/three-stars";
import { logAudit } from "@/lib/audit";
import { check, revalidateAfterScore } from "./shared";

/**
 * Not in `lib/actions`, where every export is an endpoint. Caller MUST verify `actorId` against the
 * session and the league first: a redirecting guard in here would be swallowed by `revertAuditEntries`.
 */
export async function finalizeGameById(
  gameId: string,
  /** ⚠️ `null` for the nightly sweep: never attribute a system close to a scorekeeper. */
  actorId: string | null,
  /**
   * ⛔ The nightly sweep must pass the admin client, for all four statements (`RUNBOOK.md` →
   * Closing the night): as `anon` the UPDATE matches nothing and the empty roster read writes 0-0.
   */
  client?: DbClient,
) {
  const supabase = client ?? (await createClient());

  const { data: game } = await supabase
    .from("games")
    .select("id, home_team_id, away_team_id")
    .eq("id", gameId)
    .single();
  // ⛔ Throw, never return: a silent return reads as a completed finalize, and the cron would count
  // it closed. A refused read reports no error either.
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

  // ⚠️ Nothing reads `three_stars`, and it is still written on purpose: stopping would leave only
  // older games with stars, so the card could not simply come back. Removing the writer is undecided.
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
    // ⛔ `.select("id")` proves the write: an RLS-refused UPDATE matches no rows with `error: null`
    // (`RUNBOOK.md` → Access control → Traps).
    .select("id");
  check(error, "Finalize game");
  // ⛔ This throw stays in front of `logAudit`, which writes on the admin client regardless:
  // auditing first files a `finalize_game` entry for a game that was never finalized.
  if (!updated?.length) {
    throw new Error(
      `Finalize game failed: no rows updated for ${gameId}. The statement was ` +
        "refused (an RLS-refused UPDATE reports no error) or the game is gone.",
    );
  }

  // ⛔ Awaited, not `void`ed: Vercel may freeze a route handler once it responds, and this entry is
  // the only record the system closed the game. Safe: `logAudit` swallows its own errors.
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
