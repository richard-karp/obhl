"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/utils/supabase/server";
import { requireRole } from "@/lib/auth/guards";
import { leagueOffset } from "@/lib/format";

// Scoring writes go through the USER's session client, so RLS enforces who can
// do what (captain: own-team lineup; scorekeeper: stats; manager: all).

const PUBLIC_PATHS = ["/", "/standings", "/stats", "/schedule"];
const STAT_COLS = new Set(["goals", "assists", "pim"]);

type UserClient = Awaited<ReturnType<typeof createClient>>;

/** Surface a DB/RLS error instead of silently "succeeding" with nothing saved. */
function check(error: { message: string } | null, what: string) {
  if (error) throw new Error(`${what} failed: ${error.message}`);
}

function revalidateAfterScore(gameId: string, alsoPublic = false) {
  revalidatePath(`/score/${gameId}`);
  revalidatePath("/score");
  if (alsoPublic) for (const p of PUBLIC_PATHS) revalidatePath(p);
}

/**
 * Keep a COMPLETED game's official score in sync after an edit. For a non-final
 * game this is a no-op; for a final one it recomputes home/away_goals from the
 * counters so the standings stay correct. Returns whether the game is final
 * (so callers know to revalidate the public pages).
 */
async function syncFinalScore(
  supabase: UserClient,
  gameId: string,
): Promise<boolean> {
  const { data: game } = await supabase
    .from("games")
    .select("home_team_id, away_team_id, finalized_at")
    .eq("id", gameId)
    .maybeSingle();
  if (!game?.finalized_at) return false;

  const { data: rosters } = await supabase
    .from("game_rosters")
    .select("team_id, goals")
    .eq("game_id", gameId);
  const sum = (teamId: string) =>
    (rosters ?? [])
      .filter((r) => r.team_id === teamId)
      .reduce((s, r) => s + (r.goals ?? 0), 0);

  const { error } = await supabase
    .from("games")
    .update({ home_goals: sum(game.home_team_id), away_goals: sum(game.away_team_id) })
    .eq("id", gameId);
  check(error, "Sync score");
  return true;
}

/**
 * Set a team's dressed lineup from the checkbox grid (captain own-team /
 * scorekeeper / manager). Reconciles the diff so players who stay dressed keep
 * their goal/assist/PIM counters.
 */
export async function setLineup(formData: FormData) {
  await requireRole("captain", "scorekeeper", "league_manager");
  const supabase = await createClient();
  const game_id = String(formData.get("game_id"));
  const team_id = String(formData.get("team_id"));
  const checked = new Set(formData.getAll("player_ids").map(String));

  const { data: current } = await supabase
    .from("game_rosters")
    .select("id, player_id")
    .eq("game_id", game_id)
    .eq("team_id", team_id);
  const currentSet = new Set((current ?? []).map((r) => r.player_id));

  const toAdd = [...checked].filter((p) => !currentSet.has(p));
  const toRemove = (current ?? [])
    .filter((r) => !checked.has(r.player_id))
    .map((r) => r.id);

  if (toAdd.length) {
    const { error } = await supabase
      .from("game_rosters")
      .insert(toAdd.map((player_id) => ({ game_id, team_id, player_id })));
    check(error, "Update lineup");
  }
  if (toRemove.length) {
    const { error } = await supabase.from("game_rosters").delete().in("id", toRemove);
    check(error, "Update lineup");
  }
  const wasFinal = await syncFinalScore(supabase, game_id);
  revalidateAfterScore(game_id, wasFinal);
}

/**
 * Increment/decrement a dressed player's goals/assists/pim by 1 (scorekeeper /
 * manager). Atomic via an RPC (`greatest(0, col + delta)`) so concurrent taps
 * can't lose an increment. First change bumps the game to in_progress.
 */
export async function bumpStat(formData: FormData) {
  await requireRole("scorekeeper", "league_manager");
  const supabase = await createClient();
  const id = String(formData.get("id"));
  const game_id = String(formData.get("game_id"));
  const col = String(formData.get("col"));
  const delta = Number(formData.get("delta")) >= 0 ? 1 : -1;
  if (!id || !STAT_COLS.has(col)) return;

  const { error } = await supabase.rpc("bump_game_roster_stat", {
    p_id: id,
    p_col: col,
    p_delta: delta,
  });
  check(error, "Update stat");

  await supabase
    .from("games")
    .update({ status: "in_progress" })
    .eq("id", game_id)
    .eq("status", "scheduled");
  const wasFinal = await syncFinalScore(supabase, game_id);
  revalidateAfterScore(game_id, wasFinal);
}

/** Finalize: set the official score from goal counters, lock the game, propagate. */
export async function finalizeGame(formData: FormData) {
  const user = await requireRole("scorekeeper", "league_manager");
  const supabase = await createClient();
  const game_id = String(formData.get("game_id"));

  const { data: game } = await supabase
    .from("games")
    .select("id, home_team_id, away_team_id")
    .eq("id", game_id)
    .single();
  if (!game) return;

  const { data: rosters } = await supabase
    .from("game_rosters")
    .select("team_id, goals")
    .eq("game_id", game_id);
  const sum = (teamId: string) =>
    (rosters ?? [])
      .filter((r) => r.team_id === teamId)
      .reduce((s, r) => s + (r.goals ?? 0), 0);

  const { error } = await supabase
    .from("games")
    .update({
      status: "final",
      home_goals: sum(game.home_team_id),
      away_goals: sum(game.away_team_id),
      result_type: "regulation",
      finalized_at: new Date().toISOString(),
      finalized_by: user.id,
    })
    .eq("id", game_id);
  check(error, "Finalize game");

  revalidateAfterScore(game_id, true);
}

/**
 * Reopen a completed game back to in-progress (scorekeeper / manager). The game
 * stays editable either way; this just clears the "final" status, e.g. to keep
 * working on it before re-completing.
 */
export async function reopenGame(formData: FormData) {
  await requireRole("scorekeeper", "league_manager");
  const supabase = await createClient();
  const game_id = String(formData.get("game_id"));
  const { error } = await supabase
    .from("games")
    .update({ status: "in_progress", finalized_at: null, finalized_by: null })
    .eq("id", game_id);
  check(error, "Reopen game");
  revalidateAfterScore(game_id, true);
}

// --- Game-day status changes (scorekeeper / manager): cancel, postpone, etc. ---

async function setStatus(
  game_id: string,
  status: "scheduled" | "cancelled" | "postponed",
) {
  const supabase = await createClient();
  const { error } = await supabase.from("games").update({ status }).eq("id", game_id);
  check(error, "Update game status");
  revalidateAfterScore(game_id, true);
}

/** Mark a game cancelled (drops out of upcoming + standings; no result). */
export async function cancelGame(formData: FormData) {
  await requireRole("scorekeeper", "league_manager");
  await setStatus(String(formData.get("game_id")), "cancelled");
}

/** Mark a game postponed (date TBD until rescheduled). */
export async function postponeGame(formData: FormData) {
  await requireRole("scorekeeper", "league_manager");
  await setStatus(String(formData.get("game_id")), "postponed");
}

/** Restore a cancelled/postponed game back to scheduled. */
export async function restoreGame(formData: FormData) {
  await requireRole("scorekeeper", "league_manager");
  await setStatus(String(formData.get("game_id")), "scheduled");
}

/** Move a game to a new date/time (and mark it scheduled). */
export async function rescheduleGame(formData: FormData) {
  await requireRole("scorekeeper", "league_manager");
  const supabase = await createClient();
  const game_id = String(formData.get("game_id"));
  const dt = String(formData.get("scheduled_at") ?? "").trim();
  if (!dt) return;
  // datetime-local "YYYY-MM-DDTHH:MM" interpreted in the league zone (DST-aware).
  const { error } = await supabase
    .from("games")
    .update({ scheduled_at: `${dt}:00${leagueOffset(dt)}`, status: "scheduled" })
    .eq("id", game_id);
  check(error, "Reschedule game");
  revalidateAfterScore(game_id, true);
}
