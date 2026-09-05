"use server";

import { revalidatePath } from "next/cache";
import { createAdminClient } from "@/utils/supabase/admin";
import { requireLeagueManager } from "@/lib/auth/guards";
import { logAudit } from "@/lib/audit";
import {
  planMerge,
  type GameRow,
  type MergePlan,
  type RosterRow,
} from "@/lib/players/merge-plan";

export type PlayersActionState = { ok: boolean; message: string } | null;

type Admin = ReturnType<typeof createAdminClient>;
type Refusal = Extract<MergePlan, { ok: false }>;

/** Display names for a handful of ids, for messages a person has to act on. */
async function playerNames(
  admin: Admin,
  ids: string[],
): Promise<Map<string, string>> {
  if (ids.length === 0) return new Map();
  const { data } = await admin
    .from("players")
    .select("id, first_name, last_name")
    .in("id", ids);
  return new Map(
    (data ?? []).map((p) => [p.id, `${p.first_name} ${p.last_name}`.trim()]),
  );
}

/**
 * A refusal, written out for the operator.
 *
 * The refusals are the whole value of the check, and a generic "could not
 * merge" throws that value away: the operator is being told something true
 * about these two records that they did not know, and either acts on it or
 * learns the tool is right. So each one names the game, the teams or the
 * accounts involved, and says what to do instead.
 *
 * Built here rather than in the page because the reason carries ids and the
 * lookups are the database's. `planMerge` stays pure.
 */
async function describeRefusal(admin: Admin, plan: Refusal): Promise<string> {
  switch (plan.reason) {
    case "opposing-teams": {
      const { data: game } = await admin
        .from("games")
        .select(
          "scheduled_at, home_team:teams!games_home_team_id_fkey(name), away_team:teams!games_away_team_id_fkey(name)",
        )
        .eq("id", plan.gameId)
        .maybeSingle();
      const when = game?.scheduled_at
        ? new Date(game.scheduled_at).toLocaleDateString("en-CA")
        : "one game";
      const matchup =
        game?.home_team?.name && game?.away_team?.name
          ? ` (${game.away_team.name} at ${game.home_team.name})`
          : "";
      return (
        `These records were both dressed for the same game on ${when}${matchup}, ` +
        `on opposite teams — so they are two different people. ` +
        `Nothing was merged; mark them as different people instead.`
      );
    }
    case "different-active-teams": {
      const { data: teams } = await admin
        .from("teams")
        .select("name")
        .in("id", plan.teamIds);
      const names = (teams ?? []).map((t) => t.name).join(" and ");
      return (
        `These records are currently on two different teams in the same season` +
        (names ? ` (${names})` : "") +
        `. One player cannot be active on both. Transfer or remove one of them ` +
        `first, then merge.`
      );
    }
    case "both-linked": {
      const { data: profiles } = await admin
        .from("profiles")
        .select("display_name, player_id")
        .in("player_id", plan.playerIds);
      const names = (profiles ?? [])
        .map((p) => p.display_name ?? "an unnamed account")
        .join(" and ");
      return (
        // Counted, not assumed. The refusal fires on more than one, and a
        // three-way cluster can carry three linked records.
        `${plan.playerIds.length} of these records are linked to user accounts` +
        (names ? ` (${names})` : "") +
        `. Merging would leave both accounts controlling one player — and a ` +
        `captain's write access is resolved through that link, so both would ` +
        `hold it. Unlink one account first.`
      );
    }
  }
}

type MergeSet = {
  rosters: RosterRow[];
  games: GameRow[];
  linked: string[];
  /** Every `game_rosters` id in the set, for the audit entry's before-picture. */
  gameRowIds: string[];
};

/**
 * The rows a merge may touch, and the proof that every one of them is this
 * league's.
 *
 * Two jobs, and they are not separable. The review page only ever offers ids it
 * found inside this league — but the page is not what is being trusted here. A
 * hand-made POST names any uuid it likes, and `players` has no `league_id` to
 * check it against, so the league has to be re-derived from the rows the ids
 * actually have. A merge-set member with no row anywhere in this league is
 * refused rather than merged on the strength of the form saying it belongs.
 *
 * Every read filters by `player_id`, never by game or team. Fetching
 * `game_rosters` by `game_id` — the natural way to "get the game's rows" —
 * returns every player who dressed, and `planMerge` would sum those strangers'
 * goals into the survivor and delete their rows without reporting anything.
 */
async function loadMergeSet(
  admin: Admin,
  leagueId: string,
  mergeSet: string[],
): Promise<{ error: string } | MergeSet> {
  const [{ data: tp }, { data: gr }] = await Promise.all([
    admin
      .from("team_players")
      .select(
        "id, player_id, season_id, team_id, jersey_number, is_captain, left_on, seasons!inner(league_id)",
      )
      .in("player_id", mergeSet),
    admin
      .from("game_rosters")
      .select("id, game_id, team_id, player_id, goals, assists, pim")
      .in("player_id", mergeSet),
  ]);

  const rosterRows = tp ?? [];
  const gameRows = gr ?? [];

  // Games carry their league through their season, one more hop than roster
  // rows do. A player with game rows in another league is out of reach here
  // even if their roster rows all look local.
  const gameIds = [...new Set(gameRows.map((r) => r.game_id))];
  const gameLeagues = new Map<string, string>();
  if (gameIds.length) {
    const { data: games } = await admin
      .from("games")
      .select("id, season:seasons!inner(league_id)")
      .in("id", gameIds);
    for (const g of games ?? []) gameLeagues.set(g.id, g.season.league_id);
  }

  const foreign =
    rosterRows.some((r) => r.seasons.league_id !== leagueId) ||
    [...gameLeagues.values()].some((id) => id !== leagueId);
  if (foreign) {
    return {
      error:
        "One of those records also plays in another league. Merging identities " +
        "across leagues is not something a single league's manager can do.",
    };
  }

  const placed = new Set([
    ...rosterRows.map((r) => r.player_id),
    ...gameRows.flatMap((r) => (r.player_id ? [r.player_id] : [])),
  ]);
  const unplaced = mergeSet.filter((id) => !placed.has(id));
  if (unplaced.length) {
    return {
      error:
        "One of those records has no roster row or game in this league, so it " +
        "cannot be merged from here.",
    };
  }

  // A record that is linked to a user account. `profiles.player_id` has no
  // unique index, so this is a list, not a lookup.
  const { data: profiles } = await admin
    .from("profiles")
    .select("player_id")
    .in("player_id", mergeSet);
  const linked = [
    ...new Set(
      (profiles ?? []).flatMap((p) => (p.player_id ? [p.player_id] : [])),
    ),
  ];

  return {
    rosters: rosterRows.map(
      (r): RosterRow => ({
        id: r.id,
        playerId: r.player_id,
        seasonId: r.season_id,
        teamId: r.team_id,
        jerseyNumber: r.jersey_number,
        isCaptain: r.is_captain,
        leftOn: r.left_on,
      }),
    ),
    games: gameRows.flatMap((r): GameRow[] =>
      // A substitute row has no player_id (0016) and cannot be in the set the
      // `.in()` filter returned, but the column is nullable and `GameRow`'s is
      // not — so this narrows rather than asserts.
      r.player_id
        ? [
            {
              id: r.id,
              gameId: r.game_id,
              teamId: r.team_id,
              playerId: r.player_id,
              goals: r.goals,
              assists: r.assists,
              pim: r.pim,
            },
          ]
        : [],
    ),
    linked,
    gameRowIds: gameRows.map((r) => r.id),
  };
}

/**
 * Fold several same-name `players` records into one.
 *
 * **Not revertible.** Stat rows are summed and the absorbed records are deleted,
 * so `revertAuditEntries` skips `merge_players` — there is nothing to restore
 * the split from. That is why the refusals in `planMerge` run first and why the
 * page warns before the button.
 *
 * Scope is one league, structurally rather than by rule. The candidates come
 * only from players reachable through `team_players -> seasons -> league_id` for
 * THIS league, and `loadMergeSet` re-derives that from the rows rather than the
 * form. A cross-league merge is not a disabled button; it is unreachable.
 */
export async function mergePlayers(
  _prev: PlayersActionState,
  formData: FormData,
): Promise<PlayersActionState> {
  const leagueId = String(formData.get("league_id") ?? "");
  if (!leagueId) return { ok: false, message: "No league selected." };
  const manager = await requireLeagueManager(leagueId);

  const keepId = String(formData.get("keep_id") ?? "");
  const absorbIds = [
    ...new Set(
      formData
        .getAll("merge_id")
        .map(String)
        .filter((id) => id && id !== keepId),
    ),
  ];
  if (!keepId || absorbIds.length === 0) {
    return { ok: false, message: "Choose a record to keep and at least one to merge into it." };
  }

  const admin = createAdminClient();
  const mergeSet = [keepId, ...absorbIds];
  const loaded = await loadMergeSet(admin, leagueId, mergeSet);
  if ("error" in loaded) return { ok: false, message: loaded.error };

  const plan = planMerge(keepId, loaded.rosters, loaded.games, loaded.linked);
  if (!plan.ok) return { ok: false, message: await describeRefusal(admin, plan) };

  const names = await playerNames(admin, mergeSet);

  const before = {
    keep_id: keepId,
    absorbed: absorbIds,
    absorbed_names: absorbIds.map((id) => names.get(id) ?? id),
    roster_rows: loaded.rosters.map((r) => r.id),
    game_rows: loaded.gameRowIds,
  };

  /**
   * A merge that stopped partway, written down.
   *
   * Every failure from here on happens after at least one write has landed, and
   * there is no transaction to unwind them — supabase-js has none. So a partial
   * merge is a real outcome rather than a theoretical one, and the log is the
   * only place anyone can find out how far it got: `before` holds every roster
   * and game row id the plan was built from, which is what reconstructing the
   * split by hand needs.
   *
   * Awaited rather than voided, like `logStaffChange` in people.ts and for the
   * same reason — the runtime can freeze the function after the response and
   * leave a voided promise unfinished, and this is the entry least worth
   * losing. `logAudit` swallows its own errors, so it cannot turn a failed merge
   * into a thrown one.
   */
  const partial = async (
    step: string,
    detail: string,
  ): Promise<PlayersActionState> => {
    await logAudit({
      user_id: manager.id,
      action: "merge_players_partial",
      entity_type: "player",
      entity_id: keepId,
      league_id: leagueId,
      old_data: before,
      new_data: { failed_at: step, error: detail },
    });
    return {
      ok: false,
      message:
        `${detail} The merge stopped partway and the records are now in a ` +
        `half-merged state — the audit log records what it was working from. ` +
        `Do not retry until someone has looked.`,
    };
  };

  // Roster rows: the losers go before the survivors are repointed, or
  // `unique (season_id, team_id, player_id)` from 0003 rejects the update.
  if (plan.rosterDelete.length) {
    const { error } = await admin
      .from("team_players")
      .delete()
      .in("id", plan.rosterDelete);
    if (error) return partial("roster-delete", `Could not remove the absorbed roster rows: ${error.message}`);
  }
  if (plan.rosterKeep.length) {
    const { error } = await admin
      .from("team_players")
      .update({ player_id: keepId })
      .in("id", plan.rosterKeep);
    if (error) return partial("roster-repoint", `Could not move the roster rows: ${error.message}`);
  }

  // Same ordering for the same reason, per game: `unique (game_id, player_id)`
  // (0004_games.sql:42) rejects the survivor's repoint while a duplicate row is
  // still there.
  for (const g of plan.games) {
    if (g.deleteIds.length) {
      const { error } = await admin.from("game_rosters").delete().in("id", g.deleteIds);
      if (error) return partial("game-rows", `Could not merge game ${g.gameId}: ${error.message}`);
    }
    const { error } = await admin
      .from("game_rosters")
      .update({
        player_id: keepId,
        goals: g.goals,
        assists: g.assists,
        pim: g.pim,
      })
      .eq("id", g.survivorId);
    if (error) return partial("game-rows", `Could not merge game ${g.gameId}: ${error.message}`);
  }

  // Everything else that names a player by id. Each is a plain repoint: none of
  // these has a unique constraint the merge can collide with — `team_goalie_days`
  // is unique on (team, season, day) and the goalie-of-record columns are plain
  // references.
  const repointed = await Promise.all([
    admin.from("team_goalie_days").update({ player_id: keepId }).in("player_id", absorbIds),
    admin.from("games").update({ home_goalie_id: keepId }).in("home_goalie_id", absorbIds),
    admin.from("games").update({ away_goalie_id: keepId }).in("away_goalie_id", absorbIds),
    admin.from("profiles").update({ player_id: keepId }).in("player_id", absorbIds),
  ]);
  const repointErr = repointed.find((r) => r.error)?.error;
  if (repointErr) {
    return partial("repoint", `Could not repoint the absorbed records: ${repointErr.message}`);
  }

  // ⛔ LAST, and moving it up is not the harmless tidying it looks like.
  //
  // `game_rosters.player_id` is `on delete cascade` (0004_games.sql:38), so
  // deleting an absorbed `players` row before its game rows have been repointed
  // destroys that player's entire stat history — every game they dressed for,
  // gone, with no error and no partial failure to notice. `team_goalie_days`
  // cascades the same way; the goalie-of-record columns are `set null`, which is
  // quieter still.
  const { error: pErr } = await admin.from("players").delete().in("id", absorbIds);
  if (pErr) return partial("players-delete", `Could not delete the absorbed records: ${pErr.message}`);

  // Dismissals that named an absorbed record are gone with it (both player
  // columns cascade), which is right: the judgement was about two records, and
  // one of them no longer exists.

  await logAudit({
    user_id: manager.id,
    action: "merge_players",
    entity_type: "player",
    entity_id: keepId,
    // `players` has no league, and the absorbed rows are deleted above, so
    // nothing here can resolve one afterwards. Passed explicitly, or the entry
    // is filed under a null league and then hidden by RLS and every view.
    league_id: leagueId,
    old_data: before,
    new_data: {
      keep_id: keepId,
      keep_name: names.get(keepId) ?? keepId,
      roster_rows_kept: plan.rosterKeep.length,
      roster_rows_deleted: plan.rosterDelete.length,
      games_merged: plan.games.length,
    },
  });

  revalidatePath("/[league]/people/duplicates", "page");
  revalidatePath("/[league]/teams/[slug]", "page");
  revalidatePath("/[league]/teams/[slug]", "page");
  revalidatePath("/[league]", "layout");

  const kept = names.get(keepId) ?? "the record";
  return {
    ok: true,
    message: `Merged ${absorbIds.length} record${absorbIds.length === 1 ? "" : "s"} into ${kept}.`,
  };
}

/**
 * Record that two same-name records are two different people.
 *
 * Without this a dismissed cluster reappears on every visit forever and the
 * tool becomes noise the operator learns to skip past — which costs more than
 * the duplicates it was meant to catch.
 */
export async function dismissDuplicatePair(
  _prev: PlayersActionState,
  formData: FormData,
): Promise<PlayersActionState> {
  const leagueId = String(formData.get("league_id") ?? "");
  if (!leagueId) return { ok: false, message: "No league selected." };
  const manager = await requireLeagueManager(leagueId);

  const a = String(formData.get("player_a") ?? "");
  const b = String(formData.get("player_b") ?? "");
  if (!a || !b || a === b) return { ok: false, message: "Pick two different records." };

  const admin = createAdminClient();
  // The same containment check the merge runs, for the same reason: this writes
  // rows naming two players under a league, and nothing else here would stop a
  // hand-made POST filing another league's players under this one.
  const loaded = await loadMergeSet(admin, leagueId, [a, b]);
  if ("error" in loaded) return { ok: false, message: loaded.error };

  // Ordered to match 0035's `check (player_a < player_b)`, so one judgement is
  // one row whichever record the page listed first.
  const [playerA, playerB] = a < b ? [a, b] : [b, a];
  const { error } = await admin.from("player_distinct_pairs").insert({
    league_id: leagueId,
    player_a: playerA,
    player_b: playerB,
    created_by: manager.id,
  });
  // A pair already dismissed is the same outcome the caller wanted, not a
  // failure — two managers reaching the same judgement is normal.
  if (error && error.code !== "23505") {
    return { ok: false, message: `Could not save that: ${error.message}` };
  }

  revalidatePath("/[league]/people/duplicates", "page");
  return { ok: true, message: "Marked as two different people." };
}

/**
 * Undo a dismissal, so the cluster comes back.
 *
 * The page cannot be honest without this. A dismissal is one click and looks
 * like every other button, but it hides a possible duplicate permanently and
 * the operator has no way to find out it happened — the cluster simply stops
 * appearing. "Show dismissed" plus this action is what makes it recoverable
 * outside of SQL.
 */
export async function restoreDuplicatePair(
  _prev: PlayersActionState,
  formData: FormData,
): Promise<PlayersActionState> {
  const leagueId = String(formData.get("league_id") ?? "");
  if (!leagueId) return { ok: false, message: "No league selected." };
  await requireLeagueManager(leagueId);

  const id = String(formData.get("pair_id") ?? "");
  if (!id) return { ok: false, message: "No dismissal selected." };

  const admin = createAdminClient();
  // Scoped to the league the form came from, so an id belonging to another
  // league's dismissals cannot be deleted from this page.
  const { error } = await admin
    .from("player_distinct_pairs")
    .delete()
    .eq("id", id)
    .eq("league_id", leagueId);
  if (error) return { ok: false, message: `Could not undo that: ${error.message}` };

  revalidatePath("/[league]/people/duplicates", "page");
  return { ok: true, message: "Dismissal undone — the pair is a candidate again." };
}
