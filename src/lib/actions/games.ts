"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/utils/supabase/server";
import { createAdminClient } from "@/utils/supabase/admin";
import { requireLeagueRole, type AppRoleList } from "@/lib/auth/guards";
import { leagueOfGame } from "@/lib/league/of-entity";
import { leagueOffset } from "@/lib/format";
import { logAudit } from "@/lib/audit";
import { check, revalidateAfterScore } from "@/lib/games/shared";
import { finalizeGameById, reopenGameById } from "@/lib/games/finalize";

// Scoring writes go through the USER's session client, so RLS enforces who can
// do what (captain: own-team lineup; scorekeeper: stats; manager: all).

const STAT_COLS = new Set(["goals", "assists", "pim"]);

type UserClient = Awaited<ReturnType<typeof createClient>>;

/**
 * Role AND membership of the league this game belongs to.
 *
 * These forms carry a game id and nothing else — the league is in the URL of
 * the scoresheet, not in the payload — so the guard derives it. The RLS
 * policies (0032) carry the same membership test, which is what covers the
 * writes here that go through the user's own client; this is the half that
 * covers the reads, the admin-client write in `generateGameRecap`, and the
 * refusal happening before any work is done.
 */
async function requireGameRole(gameId: string, ...roles: AppRoleList) {
  return requireLeagueRole(
    () => leagueOfGame(gameId, createAdminClient()),
    ...roles,
  );
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
    .update({
      home_goals: sum(game.home_team_id),
      away_goals: sum(game.away_team_id),
    })
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
  const supabase = await createClient();
  const game_id = String(formData.get("game_id"));
  await requireGameRole(game_id, "captain", "scorekeeper", "league_manager");
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
    const { error } = await supabase
      .from("game_rosters")
      .delete()
      .in("id", toRemove);
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
  const supabase = await createClient();
  const game_id = String(formData.get("game_id"));
  await requireGameRole(game_id, "captain", "scorekeeper", "league_manager");
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
  const supabase = await createClient();
  const id = String(formData.get("id"));
  const game_id = String(formData.get("game_id"));
  await requireGameRole(game_id, "scorekeeper", "league_manager");
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
  const supabase = await createClient();
  const game_id = String(formData.get("game_id"));
  const user = await requireGameRole(
    game_id,
    "scorekeeper",
    "league_manager",
    "captain",
  );
  const side = String(formData.get("side"));
  if (side !== "home" && side !== "away") return;

  // Captains may only set the goalie for their own team's side.
  if (user.role === "captain") {
    const { data: game } = await supabase
      .from("games")
      .select("home_team_id, away_team_id, finalized_at, season_id")
      .eq("id", game_id)
      .maybeSingle();
    if (!game || game.finalized_at) return;
    const { data: prof } = await supabase
      .from("profiles")
      .select("player_id")
      .eq("id", user.id)
      .maybeSingle();
    if (!prof?.player_id) return;
    const { data: tp } = await supabase
      .from("team_players")
      .select("team_id")
      .eq("player_id", prof.player_id)
      .eq("is_captain", true)
      .eq("season_id", game.season_id)
      .maybeSingle();
    const captainTeamId = tp?.team_id;
    const sideTeamId = side === "home" ? game.home_team_id : game.away_team_id;
    if (captainTeamId !== sideTeamId) return;
  }

  // "sub" = substitute goalie (no individual record); "" = clear (fallback to
  // dressed G); any uuid = an individual goalie of record.
  const raw = String(formData.get("goalie_id") ?? "");
  const isSub = raw === "sub";
  const goalie_id = isSub || raw === "" ? null : raw;

  const patch =
    side === "home"
      ? { home_goalie_id: goalie_id, home_goalie_is_sub: isSub }
      : { away_goalie_id: goalie_id, away_goalie_is_sub: isSub };
  const { error } = await supabase
    .from("games")
    .update(patch)
    .eq("id", game_id);
  check(error, "Set goalie");
  revalidateAfterScore(game_id, true);
}

/**
 * Adjust the count of empty-net goals scored against one team in a game
 * (scorekeeper / manager). These goals still count in the score/standings, but
 * are excluded from that team's goalie's GA/GAA.
 */
export async function bumpEmptyNet(formData: FormData) {
  const supabase = await createClient();
  const game_id = String(formData.get("game_id"));
  await requireGameRole(game_id, "scorekeeper", "league_manager");
  const side = String(formData.get("side"));
  const delta = Number(formData.get("delta")) >= 0 ? 1 : -1;
  if (side !== "home" && side !== "away") return;

  const { error } = await supabase.rpc("bump_game_empty_net", {
    p_game: game_id,
    p_side: side,
    p_delta: delta,
  });
  check(error, "Update empty-net goals");
  revalidateAfterScore(game_id, true);
}

/** Finalize: set the official score from goal counters, lock the game, propagate. */
export async function finalizeGame(formData: FormData) {
  const game_id = String(formData.get("game_id"));
  const user = await requireGameRole(game_id, "scorekeeper", "league_manager");
  await finalizeGameById(game_id, user.id);
}

/**
 * Reopen a completed game back to in-progress (scorekeeper / manager). The game
 * stays editable either way; this just clears the "final" status, e.g. to keep
 * working on it before re-completing.
 */
export async function reopenGame(formData: FormData) {
  const game_id = String(formData.get("game_id"));
  const user = await requireGameRole(game_id, "scorekeeper", "league_manager");
  await reopenGameById(game_id, user.id);
}

/**
 * Generate an AI game recap using Claude and store it in games.ai_recap.
 * Requires ANTHROPIC_API_KEY env var. Manager-only.
 */
export async function generateGameRecap(formData: FormData) {
  const game_id = String(formData.get("game_id"));
  // The recap is saved on the ADMIN client, so RLS does not stand behind this
  // one — the guard is the whole of it.
  const user = await requireGameRole(game_id, "league_manager");

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY is not configured.");

  const supabase = await createClient();
  const admin = createAdminClient();

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: gameRaw } = await (supabase as any)
    .from("games")
    .select(
      "id, scheduled_at, home_goals, away_goals, home_team_id, away_team_id, " +
        "home_team:teams!games_home_team_id_fkey(name), " +
        "away_team:teams!games_away_team_id_fkey(name)",
    )
    .eq("id", game_id)
    .eq("status", "final")
    .maybeSingle();
  if (!gameRaw) throw new Error("Game not found or not final.");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const g = gameRaw as any;

  const { data: rosters } = await supabase
    .from("game_rosters")
    .select("team_id, player_id, goals, assists, pim, is_substitute")
    .eq("game_id", game_id);

  const playerIds = (rosters ?? [])
    .filter((r) => r.player_id && !r.is_substitute)
    .map((r) => r.player_id!);

  const { data: players } = playerIds.length
    ? await supabase
        .from("players")
        .select("id, first_name, last_name")
        .in("id", playerIds)
    : { data: [] };

  const nameOf = new Map(
    (players ?? []).map((p) => [p.id, `${p.first_name} ${p.last_name}`]),
  );

  const lines = (rosters ?? [])
    .filter((r) => r.player_id && !r.is_substitute)
    .map((r) => {
      const teamName =
        r.team_id === g.home_team_id ? g.home_team.name : g.away_team.name;
      return `${nameOf.get(r.player_id!) ?? "Unknown"} (${teamName}): ${r.goals}G ${r.assists}A ${r.pim}PIM`;
    });

  const prompt = [
    `Write a short, energetic 2-3 sentence game recap for a recreational adult hockey league.`,
    `Game: ${g.away_team?.name} at ${g.home_team?.name}`,
    `Final score: ${g.away_team?.name} ${g.away_goals} – ${g.home_team?.name} ${g.home_goals}`,
    lines.length ? `Player stats:\n${lines.join("\n")}` : "",
    `Keep it fun and casual. No filler phrases like "In a thrilling matchup".`,
  ]
    .filter(Boolean)
    .join("\n");

  const { default: Anthropic } = await import("@anthropic-ai/sdk");
  const client = new Anthropic({ apiKey });
  const msg = await client.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 300,
    messages: [{ role: "user", content: prompt }],
  });

  const recap =
    msg.content.length > 0 && msg.content[0].type === "text"
      ? msg.content[0].text.trim()
      : "";
  if (!recap) throw new Error("AI returned empty recap.");

  const { error } = await admin
    .from("games")
    .update({ ai_recap: recap })
    .eq("id", game_id);
  if (error) throw new Error(`Save recap failed: ${error.message}`);

  void logAudit({
    user_id: user.id,
    action: "generate_recap",
    entity_type: "game",
    entity_id: game_id,
  });

  revalidateAfterScore(game_id, true);
  revalidatePath("/[league]", "page");
}

// --- Game-day status changes (scorekeeper / manager): cancel, postpone, etc. ---

async function setStatus(
  game_id: string,
  status: "scheduled" | "cancelled" | "postponed",
) {
  const supabase = await createClient();
  const { error } = await supabase
    .from("games")
    .update({ status })
    .eq("id", game_id);
  check(error, "Update game status");
  revalidateAfterScore(game_id, true);
}

/** Mark a game cancelled (drops out of upcoming + standings; no result). */
export async function cancelGame(formData: FormData) {
  const game_id = String(formData.get("game_id"));
  await requireGameRole(game_id, "scorekeeper", "league_manager");
  await setStatus(game_id, "cancelled");
}

/**
 * Mark a game postponed, clearing its date.
 *
 * A postponed game is not being played when it was scheduled, so leaving
 * `scheduled_at` in place made the schedule page, the calendar feeds and the CSV
 * all state something untrue. The old date moves to `postponed_from`, which
 * keeps the night discoverable by the one-off planner and gives `restoreGame`
 * somewhere to go back to. It is an RPC because PostgREST cannot express a
 * column-to-column move.
 */
export async function postponeGame(formData: FormData) {
  const game_id = String(formData.get("game_id"));
  await requireGameRole(game_id, "scorekeeper", "league_manager");
  const supabase = await createClient();
  const { error } = await supabase.rpc("postpone_game", { p_game: game_id });
  check(error, "Postpone game");
  revalidateAfterScore(game_id, true);
}

/**
 * Restore a cancelled/postponed game back to scheduled.
 *
 * A cancelled game kept its date and only flips status; a postponed one gets its
 * date back from `postponed_from`.
 */
export async function restoreGame(formData: FormData) {
  const game_id = String(formData.get("game_id"));
  await requireGameRole(game_id, "scorekeeper", "league_manager");
  const supabase = await createClient();
  const { error } = await supabase.rpc("restore_game", { p_game: game_id });
  check(error, "Restore game");
  revalidateAfterScore(game_id, true);
}

/** Move a game to a new date/time (and mark it scheduled). */
export async function rescheduleGame(formData: FormData) {
  const supabase = await createClient();
  const game_id = String(formData.get("game_id"));
  await requireGameRole(game_id, "scorekeeper", "league_manager");
  const dt = String(formData.get("scheduled_at") ?? "").trim();
  if (!dt) return;
  // datetime-local "YYYY-MM-DDTHH:MM" interpreted in the league zone (DST-aware).
  const { error } = await supabase
    .from("games")
    .update({
      scheduled_at: `${dt}:00${leagueOffset(dt)}`,
      status: "scheduled",
      // A game given a new date isn't postponed any more; leaving this set would
      // keep parking it on the night it was postponed from.
      postponed_from: null,
    })
    .eq("id", game_id);
  check(error, "Reschedule game");
  revalidateAfterScore(game_id, true);
}
