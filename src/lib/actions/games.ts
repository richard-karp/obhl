"use server";

import { revalidatePath } from "next/cache";
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
import { logAudit } from "@/lib/audit";
import { check, revalidateAfterScore } from "@/lib/games/shared";
import { scoresheetProblems, type SideCheck } from "@/lib/games/incomplete";
import { finalizeGameById, reopenGameById } from "@/lib/games/finalize";
// Type-only: `schedule-edits.ts` is a "use server" module, but a type import is
// erased, so this adds no runtime edge between the two action files. Sharing the
// shape matters more — the score page and the schedule panel report a refusal
// the same way, and a manager sees one behaviour, not two.
import type { EditResult } from "@/lib/actions/schedule-edits";

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

  // ⛔ GOALIES ARE NEVER REMOVED HERE, because they are never submitted here.
  // The scoresheet's lineup checkboxes are SKATERS ONLY — who is in net is the
  // goalie section's decision — so without this every lineup save would delete
  // the goalie's roster row while `games.home_goalie_id` still named them, and
  // their stats line would vanish from the box score. The two changes only work
  // as a pair.
  // ⛔ BOTH READS FAIL CLOSED. An earlier version discarded these errors and
  // fell back to an empty goalie set — which does not mean "no goalies", it
  // means "I could not find out", and the difference is a DELETED roster row
  // carrying that goalie's stats. Failing open here loses data on exactly the
  // path where something is already wrong.
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
    // ⚠️ A DEPARTED goalie is not a current one. The score page's own roster read
    // filters `left_on` and this must agree, or a transferred goalie stays
    // un-removable from the lineup forever.
    .is("left_on", null);
  check(keepersError, "Update lineup");
  const goalieIds = new Set((keepers ?? []).map((k) => k.player_id));

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

  // ⛔ CHOOSING A GOALIE DRESSES THEM, AND UNCHOOSING ONE UNDRESSES THEM.
  // Since the lineup checkboxes became skaters-only, this is the ONLY thing that
  // can put a goalie on the roster or take them off it — there is no checkbox to
  // fall back on. Both halves are needed: without the insert a goalie of record
  // has no row to carry their stats; without the delete, tapping #1 by mistake
  // and then #31 leaves #1 dressed forever, a phantom GP in `v_skater_stats` and
  // an arbitrary winner in `v_goalie_stats`'s fallback branch (`0015`).
  const { data: g, error: gError } = await supabase
    .from("games")
    .select("home_team_id, away_team_id, season_id")
    .eq("id", game_id)
    .maybeSingle();
  check(gError, "Set goalie");
  const goalieTeamId = side === "home" ? g?.home_team_id : g?.away_team_id;

  // ⚠️ FAILS CLOSED. Without a season we cannot tell which players are goalies,
  // and "I could not find out" must not become "delete nothing that looks like a
  // goalie" OR "delete everything" — so the undress is skipped entirely and the
  // roster is left as it was.
  // ⛔ NOTHING IS AUTO-UNDRESSED HERE, AND THAT IS A DECISION, NOT AN OMISSION.
  //
  // A review round asked for it: with goalies out of the lineup checkboxes,
  // tapping #1 by mistake and then #31 leaves #1 dressed forever, a phantom GP
  // in `v_skater_stats`. The obvious fix — delete the previous goalie's row when
  // it carries no stats — was written, and it is WRONG, because a goalie who
  // actually played almost always has goals/assists/pim all zero. A pulled
  // starter and a mis-tap are byte-identical rows.
  //
  // So that fix silently deleted the GP of a goalie who was pulled: #1 starts,
  // #31 finishes, the scorekeeper sets the record to #31, and #1's row vanishes.
  // Losing a real appearance to tidy a possible mis-tap is the worse trade, and
  // no query can tell the two apart.
  //
  // ⚠️ THE MIS-TAP IS THEREFORE STILL LIVE and needs a UI answer rather than an
  // inferred one — an explicit "not dressed" control in the goalie section, or
  // returning goalies to the checkboxes. Recorded here so the next reader knows
  // it was weighed, not missed.

  if (goalie_id && goalieTeamId) {
    // Idempotent: `ignoreDuplicates` leaves an existing row and its stats alone.
    // ⚠️ THE ERROR IS CHECKED. An RLS-refused INSERT *does* error (42501), and so
    // does an `on_conflict` that names no constraint (42P10) — swallowing either
    // leaves a named goalie with no dressed row and no goalie line in the box
    // score, silently.
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

/**
 * Finalize: set the official score from goal counters, lock the game, propagate.
 *
 * ⛔ IT REFUSES A HALF-ENTERED SHEET ONCE, AND THE REFUSAL IS HERE RATHER THAN
 * IN THE BUTTON'S LABEL. Production's first three games, measured 2026-09-12:
 * one team with no dressed players and four of six sides with no goalie of
 * record, all three games completed without a word. The page can explain what
 * is missing, but only the action can decline to write it — a page-side warning
 * is defeated by a tab left open since before the lineup changed.
 *
 * ⚠️ THE NIGHTLY SWEEP IS DELIBERATELY UNAFFECTED. `/api/cron/close-night`
 * calls `finalizeGameById` directly, and games nobody finished are exactly what
 * it exists to close — a gate there would refuse every one of them.
 */
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

  // ⛔ AND TAKE `?incomplete=1` BACK OFF THE URL. It is a parameter about one
  // submission, but it survives the redirect-free success path and the page
  // re-renders under it — so pressing Reopen afterwards puts the game back
  // into a state with problems while the URL still says "already warned", and
  // the button comes back pre-armed with `confirm=1`. The next finalize would
  // then skip a gate nobody had been shown. Clearing it here is what keeps
  // "confirm is only sent once the action has refused" true.
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

/**
 * Where to send someone whose sheet is missing something, or null when it is
 * complete — or when they could not read the answer if we sent it.
 *
 * ⚠️ The league slug is READ, not taken from the form. `requireGameRole`
 * resolves a league *id* (`leagueOfGame`) and hands back a user, so the slug
 * needs its own lookup — and a hidden input would let an edited submission
 * steer where this lands. It rides along in the select below, so it costs
 * nothing extra.
 */
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
  // ⛔ FAIL OPEN, NOT CLOSED. This is a warning, not a permission —
  // `requireGameRole` above is the guard. A read that comes back empty means we
  // cannot tell whether anything is missing, and blocking a finalize on that
  // would take the scoresheet away over a transient.
  if (!game) return null;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const g = game as any;

  // ⛔ NEVER REFUSE TOWARDS A PAGE THE CALLER CANNOT OPEN, AND THIS IS NOT
  // HYPOTHETICAL — IT IS WEEKLY. The last slot starts at 9:40pm, so a
  // scorekeeper is routinely still on the sheet after midnight, and
  // `score/page.tsx` bounces a scorekeeper off a game that is not today,
  // straight to `/tonight`. Redirecting them there would mean: the game is not
  // written, the banner explaining why is never rendered, and they land on an
  // empty page — the exact "indistinguishable from a broken app" symptom that
  // guard's own comment says already cost a round of misdiagnosis.
  //
  // ⚠️ SO THEY FINALIZE WITHOUT THE WARNING, DELIBERATELY. A warning that
  // cannot be displayed must not quietly become a refusal: losing the game is
  // worse than losing the message. `finalizeGame` has no day limit of its own
  // (the rule is page-level only — see `ACCESS_CONTROL_HANDOFF.md`), so this
  // restores exactly the behaviour that existed before the gate.
  //
  // ⚠️ The predicate MIRRORS `score/page.tsx`'s and must keep mirroring it. If
  // that guard changes, a refusal here starts pointing at a door again.
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
  // ⛔ THESE FAIL OPEN TOO, AND THEY DID NOT. A discarded error here is not
  // "nothing is dressed", it is "we could not find out" — and the difference
  // is a refusal on every side of every game whenever a read blips. The `games`
  // read above already says why; these two were getting the opposite treatment
  // silently.
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

/* ---------------------------------------------------- schedule state, not scoring

 ⛔ THE FOUR BELOW ARE MANAGER-ONLY, AND THEY USED TO ADMIT SCOREKEEPERS.
 Changed 2026-09-07 on the user's instruction: "scorekeepers should not have
 that power, they can only score games."

 The line is scoring versus SCHEDULE STATE. A scorekeeper still runs a
 scoresheet end to end — lineups, substitutes, stats, goalies, empty net,
 finalize, reopen. What they no longer do is decide whether a game happens, or
 when. Those are the manager's, and two of them (postpone, reschedule) move a
 game off its night, which is exactly what the balance invariant in
 `schedule-edits.ts` exists to govern.

 ⚠️ The buttons must disappear too. A guard that refuses a control the user can
 still see reads as a broken app, not a permission — see the score page.
*/

/** Mark a game cancelled (drops out of upcoming + standings; no result). */
export async function cancelGame(formData: FormData) {
  const game_id = String(formData.get("game_id"));
  await requireGameRole(game_id, "league_manager");
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
  await requireGameRole(game_id, "league_manager");
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
  await requireGameRole(game_id, "league_manager");
  const supabase = await createClient();
  const { error } = await supabase.rpc("restore_game", { p_game: game_id });
  check(error, "Restore game");
  revalidateAfterScore(game_id, true);
}

/**
 * Move a game to a new date/time (and mark it scheduled).
 *
 * ⛔ SAME NIGHT ONLY, ONCE A GAME IS `scheduled`. Moving a scheduled game to a
 * different night takes a game off one night and gives it to another, which
 * breaks the games-per-night count the user declared non-negotiable. That move
 * is `exchangeSlots` in `schedule-edits.ts`, where it trades with a game on the
 * target night and both counts survive.
 *
 * ⚠️ A POSTPONED GAME IS EXEMPT, AND HAS TO BE. Postponing takes the game off
 * its night already — `balance.ts` stops counting it — so there is nothing left
 * to trade with. Without this carve-out postponement would be a one-way trip:
 * a rink closes, and the game could never be put back. Restoring it to any
 * night is recovery, not an edit that unbalances anything.
 *
 * ⛔ POSTPONED IS THE ONLY EXEMPTION, AND THE PREDICATE MUST SAY SO. This was
 * first written as `status === "scheduled" && …`, which exempted every other
 * status too. A manager could cancel a game and reschedule it onto any night:
 * the update sets `status: "scheduled"`, so that night silently ended up
 * holding one game more than it was built with, and `balance.ts` never saw the
 * cancelled row to object. Name the exemption, do not infer it.
 *
 * ⛔ A FINAL GAME IS NOT RESCHEDULABLE AT ALL. It has been played. Moving one
 * would also flip it back to `scheduled` with its goals still attached, which
 * is a played result re-entering the schedule as a fixture.
 *
 * Refusals are RETURNED, not thrown. This is a normal outcome of a normal form
 * — the page even prints the rule above the button — and a throw here reaches
 * `app/error.tsx`, replacing the whole page with "Something went wrong" and
 * showing the manager none of the sentences below.
 */
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
  // ⛔ FAIL CLOSED. This read decides whether a same-night restriction applies,
  // so treating a failed or RLS-refused read as "no restriction" turns an error
  // into permission — the guard's own absence becomes the way past it.
  if (readError || !current) {
    return {
      ok: false,
      message: "Could not read that game, so it was not moved.",
    };
  }
  if (current.status === "final") {
    return {
      ok: false,
      message:
        "That game has been played, so it cannot be moved. Reopen it first if the result is wrong.",
    };
  }
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
