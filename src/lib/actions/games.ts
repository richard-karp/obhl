"use server";

import { redirect } from "next/navigation";
import { createClient } from "@/utils/supabase/server";
import { createAdminClient } from "@/utils/supabase/admin";
import { requireLeagueRole, type AppRoleList } from "@/lib/auth/guards";
import { leagueOfGame } from "@/lib/league/of-entity";
import {
  isOnLeagueDate,
  leagueDateKey,
  leagueOffset,
  leagueToday,
} from "@/lib/format";
import { check, revalidateAfterScore } from "@/lib/games/shared";
import { scoresheetProblems, type SideCheck } from "@/lib/games/incomplete";
import { finalizeGameById, reopenGameById } from "@/lib/games/finalize";
// Type-only, so erased: no runtime edge into another "use server" module.
import type { EditResult } from "@/lib/actions/schedule-edits";

// Scoring writes go through the USER's session client, so RLS enforces who can
// do what (captain: own-team lineup; scorekeeper: stats; manager: all).

const STAT_COLS = new Set(["goals", "assists", "pim"]);

type UserClient = Awaited<ReturnType<typeof createClient>>;

// Role and membership, from the game's league: these forms carry only a game id. RLS (0032)
// repeats the check on writes; this one also covers the reads.
async function requireGameRole(gameId: string, ...roles: AppRoleList) {
  return requireLeagueRole(
    () => leagueOfGame(gameId, createAdminClient()),
    ...roles,
  );
}

/** Recompute a final game's score from its counters; returns whether the game is final. */
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

/** Reconciles the diff, so players who stay dressed keep their goal/assist/PIM counters. */
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

  // ⛔ Both reads fail closed: an unread goalie set turns a lineup save into deleting the
  // goalie's roster row and their stats.
  const { data: game, error: gameError } = await supabase
    .from("games")
    .select("season_id")
    .eq("id", game_id)
    .maybeSingle();
  check(gameError, "Update lineup");
  if (!game) throw new Error("Update lineup failed: game not found");

  const { data: keepers, error: keepersError } = await supabase
    .from("team_players")
    .select("player_id")
    .eq("season_id", game.season_id)
    .eq("team_id", team_id)
    .eq("position", "G")
    // ⚠️ A departed goalie is not a current one: the score page filters `left_on` too, or a
    // transferred goalie can never leave the lineup.
    .is("left_on", null);
  check(keepersError, "Update lineup");
  const goalieIds = new Set((keepers ?? []).map((k) => k.player_id));

  // ⛔ Goalies are never removed here: the checkboxes are skaters only, so a save would delete
  // the row of a goalie `games.home_goalie_id` still names.
  const toAdd = [...checked].filter((p) => !currentSet.has(p));
  const toRemove = (current ?? [])
    .filter(
      (r) =>
        r.player_id && !checked.has(r.player_id) && !goalieIds.has(r.player_id),
    )
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

// One "Substitute" row per team per game: no player_id, so its goals count for the team but
// never reach a player's season stats (v_skater_stats inner-joins players).
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

/** An atomic RPC, so concurrent taps cannot lose an increment; the first change starts the game. */
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

// Per game, since a team's goalie changes game to game. Empty clears it, and goalie stats fall
// back to the dressed position='G' player.
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

  // ⛔ Choosing a goalie dresses them: the lineup checkboxes are skaters only, so this is the only
  // write that gives a goalie of record a roster row to carry their stats.
  const { data: g, error: gError } = await supabase
    .from("games")
    .select("home_team_id, away_team_id, season_id")
    .eq("id", game_id)
    .maybeSingle();
  check(gError, "Set goalie");
  const goalieTeamId = side === "home" ? g?.home_team_id : g?.away_team_id;

  // ⛔ Never auto-undress the previous goalie: a pulled starter and a mis-tap are identical
  // all-zero rows, so a delete erases a real appearance. The mis-tap needs a UI control.

  if (goalie_id && goalieTeamId) {
    // Idempotent via `ignoreDuplicates`. ⚠️ The error is checked: a refused insert (42501) or a
    // bad `onConflict` (42P10) otherwise leaves a named goalie silently undressed.
    const { error: dressError } = await supabase.from("game_rosters").upsert(
      {
        game_id,
        team_id: goalieTeamId,
        player_id: goalie_id,
        is_substitute: false,
      },
      { onConflict: "game_id,player_id", ignoreDuplicates: true },
    );
    check(dressError, "Set goalie");
  }
  revalidateAfterScore(game_id, true);
}

/** Empty-net goals count in the score but not against that team's goalie's GA/GAA. */
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

// ⛔ The half-entered-sheet refusal lives here, not in the page: a tab open since before the lineup
// changed defeats a page warning. Keep it out of `finalizeGameById`, which the close-night cron uses.
export async function finalizeGame(formData: FormData) {
  const game_id = String(formData.get("game_id"));
  const user = await requireGameRole(game_id, "scorekeeper", "league_manager");
  const confirmed = String(formData.get("confirm") ?? "") === "1";

  // ⚠️ `redirect()` throws, so it must not sit inside a try — see
  // `node_modules/next/dist/docs/01-app/02-guides/redirecting.md`.
  if (!confirmed) {
    const incomplete = await scoresheetGaps(game_id, user.role);
    if (incomplete) redirect(incomplete);
  }

  await finalizeGameById(game_id, user.id);

  // ⛔ Redirect to drop `?incomplete=1`: left on the URL, Reopen brings back a pre-armed
  // `confirm=1` and the next finalize skips a gate nobody was shown.
  if (confirmed) {
    const slug = await leagueSlugOfGame(game_id);
    if (slug) redirect(`/${slug}/games/${game_id}/score`);
  }
}

/** The slug the scoresheet lives under, or null if it cannot be read. */
async function leagueSlugOfGame(gameId: string): Promise<string | null> {
  const supabase = await createClient();
  const { data } = await supabase
    .from("games")
    .select("season:seasons!inner(league:leagues!inner(slug))")
    .eq("id", gameId)
    .maybeSingle();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (data as any)?.season?.league?.slug ?? null;
}

// The redirect for an incomplete sheet, or null. ⚠️ The slug is read, never taken from the form,
// so an edited submission cannot steer where this lands.
async function scoresheetGaps(
  gameId: string,
  /** The caller's role, which decides whether the scoresheet is reachable. */
  role: string | null,
): Promise<string | null> {
  const supabase = await createClient();
  const { data: game } = await supabase
    .from("games")
    .select(
      `season_id, scheduled_at, home_team_id, away_team_id,
       home_goalie_id, away_goalie_id, home_goalie_is_sub, away_goalie_is_sub,
       season:seasons!inner(league:leagues!inner(slug)),
       home_team:teams!games_home_team_id_fkey(name),
       away_team:teams!games_away_team_id_fkey(name)`,
    )
    .eq("id", gameId)
    .maybeSingle();
  // ⛔ Fails open: this is a warning, not a permission (`requireGameRole` is the guard), and an
  // unreadable game must not take the scoresheet away.
  if (!game) return null;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const g = game as any;

  // ⛔ Mirrors `score/page.tsx`: a scorekeeper off the league date finalizes unwarned, since a refusal
  // bounces them to `/tonight` with the game unwritten (`RUNBOOK.md` → Access control → Scorekeeper day rule).
  if (
    role === "scorekeeper" &&
    !isOnLeagueDate(g.scheduled_at, leagueToday())
  ) {
    return null;
  }

  const [{ data: rosters, error: rostersError }, { data: tp, error: tpError }] =
    await Promise.all([
      supabase
        .from("game_rosters")
        .select("team_id, player_id")
        .eq("game_id", gameId),
      supabase
        .from("team_players")
        .select("player_id, team_id, position")
        .eq("season_id", g.season_id)
        .eq("position", "G"),
    ]);
  // ⛔ Fails open too: a failed read means "could not find out", not "nothing dressed".
  if (rostersError || tpError) return null;

  const goalieKeys = new Set(
    (tp ?? []).map((r) => `${r.player_id}|${r.team_id}`),
  );

  const side = (which: "home" | "away"): SideCheck => {
    const teamId = g[`${which}_team_id`] as string;
    const mine = (rosters ?? []).filter((r) => r.team_id === teamId);
    return {
      teamName: g[`${which}_team`]?.name ?? which,
      dressedCount: mine.length,
      goalieId: g[`${which}_goalie_id`] ?? null,
      goalieIsSub: !!g[`${which}_goalie_is_sub`],
      dressedGoalieIds: mine
        .map((r) => r.player_id)
        .filter(
          (id): id is string => !!id && goalieKeys.has(`${id}|${teamId}`),
        ),
    };
  };

  const problems = scoresheetProblems([side("away"), side("home")]);
  if (problems.length === 0) return null;

  const slug = g.season?.league?.slug;
  // Without a slug there is no page to send them back to; completing the game
  // is a better outcome than a dead redirect.
  return slug ? `/${slug}/games/${gameId}/score?incomplete=1` : null;
}

export async function reopenGame(formData: FormData) {
  const game_id = String(formData.get("game_id"));
  const user = await requireGameRole(game_id, "scorekeeper", "league_manager");
  await reopenGameById(game_id, user.id);
}

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

// ⛔ The four below are manager-only: a scorekeeper scores games but never decides whether or
// when one is played. Hide their buttons too, or the refusal reads as a broken app.

/** Mark a game cancelled (drops out of upcoming + standings; no result). */
export async function cancelGame(formData: FormData) {
  const game_id = String(formData.get("game_id"));
  await requireGameRole(game_id, "league_manager");
  await setStatus(game_id, "cancelled");
}

// Moves `scheduled_at` into `postponed_from` (`RUNBOOK.md` → Schedule edits and exports →
// Postponing); an RPC, since PostgREST cannot move one column into another.
export async function postponeGame(formData: FormData) {
  const game_id = String(formData.get("game_id"));
  await requireGameRole(game_id, "league_manager");
  const supabase = await createClient();
  const { error } = await supabase.rpc("postpone_game", { p_game: game_id });
  check(error, "Postpone game");
  revalidateAfterScore(game_id, true);
}

/** A cancelled game only flips status; a postponed one gets its date back from `postponed_from`. */
export async function restoreGame(formData: FormData) {
  const game_id = String(formData.get("game_id"));
  await requireGameRole(game_id, "league_manager");
  const supabase = await createClient();
  const { error } = await supabase.rpc("restore_game", { p_game: game_id });
  check(error, "Restore game");
  revalidateAfterScore(game_id, true);
}

// ⛔ Same night only, or a night loses a game (a cross-night move is `exchangeSlots`). Refusals are
// returned, not thrown: a throw reaches `app/error.tsx` and hides the message.
export async function rescheduleGame(
  _prev: EditResult | null,
  formData: FormData,
): Promise<EditResult> {
  const supabase = await createClient();
  const game_id = String(formData.get("game_id"));
  await requireGameRole(game_id, "league_manager");
  const dt = String(formData.get("scheduled_at") ?? "").trim();
  if (!dt) return { ok: false, message: "Pick a date and time first." };

  const { data: current, error: readError } = await supabase
    .from("games")
    .select("status, scheduled_at")
    .eq("id", game_id)
    .maybeSingle();
  // ⛔ Fails closed: this read decides whether the same-night rule applies, so an error or an RLS
  // refusal must not become permission.
  if (readError || !current) {
    return {
      ok: false,
      message: "Could not read that game, so it was not moved.",
    };
  }
  // ⛔ A final game has been played: moving it re-enters its result as a fixture.
  if (current.status === "final") {
    return {
      ok: false,
      message:
        "That game has been played, so it cannot be moved. Reopen it first if the result is wrong.",
    };
  }
  // ⛔ Name the exemption: only a postponed game, already off its night, may change night. Testing
  // `=== "scheduled"` instead lets a cancelled game overfill another night.
  if (
    current.status !== "postponed" &&
    current.scheduled_at &&
    leagueDateKey(`${dt}:00${leagueOffset(dt)}`) !==
      leagueDateKey(current.scheduled_at)
  ) {
    return {
      ok: false,
      message:
        "A game can only be moved to another time on the same night. " +
        "To move it to a different night, trade nights with another game.",
    };
  }
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
  if (error) return { ok: false, message: "That game was not moved." };
  revalidateAfterScore(game_id, true);
  return { ok: true };
}
