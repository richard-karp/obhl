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

  // Only real players are reconciled here; the substitute row (player_id null)
  // is managed by setSubstitutes and must not be touched by a lineup save.
  const { data: current } = await supabase
    .from("game_rosters")
    .select("id, player_id")
    .eq("game_id", game_id)
    .eq("team_id", team_id)
    .eq("is_substitute", false);
  const currentSet = new Set((current ?? []).map((r) => r.player_id));

  const toAdd = [...checked].filter((p) => !currentSet.has(p));
  const toRemove = (current ?? [])
    .filter((r) => r.player_id && !checked.has(r.player_id))
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
 * Add or remove a team's single "Substitute" roster row for a game (captain
 * own-team / scorekeeper / manager). The row has no player_id, so its goals
 * count toward the team score/standings but never roll up to an individual
 * player's season stats (v_skater_stats inner-joins players).
 */
export async function setSubstitutes(formData: FormData) {
  await requireRole("captain", "scorekeeper", "league_manager");
  const supabase = await createClient();
  const game_id = String(formData.get("game_id"));
  const team_id = String(formData.get("team_id"));
  const present = String(formData.get("present")) === "1";

  const { data: existing } = await supabase
    .from("game_rosters")
    .select("id")
    .eq("game_id", game_id)
    .eq("team_id", team_id)
    .eq("is_substitute", true)
    .maybeSingle();

  if (present && !existing) {
    const { error } = await supabase
      .from("game_rosters")
      .insert({ game_id, team_id, player_id: null, is_substitute: true });
    check(error, "Add substitutes");
  } else if (!present && existing) {
    const { error } = await supabase
      .from("game_rosters")
      .delete()
      .eq("id", existing.id);
    check(error, "Remove substitutes");
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

/**
 * Set the goalie of record for one side of a game (scorekeeper / manager). A
 * team can use different goalies game to game, so this is per game; an empty
 * value clears it (the goalie stats then fall back to the dressed position='G'
 * player). Affects goalie stats only, so revalidate the public pages.
 */
export async function setGoalie(formData: FormData) {
  await requireRole("scorekeeper", "league_manager");
  const supabase = await createClient();
  const game_id = String(formData.get("game_id"));
  const side = String(formData.get("side"));
  // "sub" = substitute goalie (no individual record); "" = clear (fallback to
  // dressed G); any uuid = an individual goalie of record.
  const raw = String(formData.get("goalie_id") ?? "");
  const isSub = raw === "sub";
  const goalie_id = isSub || raw === "" ? null : raw;
  if (side !== "home" && side !== "away") return;

  const patch =
    side === "home"
      ? { home_goalie_id: goalie_id, home_goalie_is_sub: isSub }
      : { away_goalie_id: goalie_id, away_goalie_is_sub: isSub };
  const { error } = await supabase.from("games").update(patch).eq("id", game_id);
  check(error, "Set goalie");
  revalidateAfterScore(game_id, true);
}

/**
 * Adjust the count of empty-net goals scored against one team in a game
 * (scorekeeper / manager). These goals still count in the score/standings, but
 * are excluded from that team's goalie's GA/GAA.
 */
export async function bumpEmptyNet(formData: FormData) {
  await requireRole("scorekeeper", "league_manager");
  const supabase = await createClient();
  const game_id = String(formData.get("game_id"));
  const side = String(formData.get("side"));
  const delta = Number(formData.get("delta")) >= 0 ? 1 : -1;
  if (side !== "home" && side !== "away") return;

  const { data: g } = await supabase
    .from("games")
    .select("home_empty_net_against, away_empty_net_against")
    .eq("id", game_id)
    .single();
  const cur =
    side === "home"
      ? (g?.home_empty_net_against ?? 0)
      : (g?.away_empty_net_against ?? 0);
  const next = Math.max(0, cur + delta);
  const patch =
    side === "home"
      ? { home_empty_net_against: next }
      : { away_empty_net_against: next };
  const { error } = await supabase.from("games").update(patch).eq("id", game_id);
  check(error, "Update empty-net goals");
  revalidateAfterScore(game_id, true);
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
