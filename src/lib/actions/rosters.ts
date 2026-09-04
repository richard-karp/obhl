"use server";

import { revalidatePath } from "next/cache";
import { createAdminClient } from "@/utils/supabase/admin";
import {
  requireLeagueManager,
  requireLeagueManagerOf,
} from "@/lib/auth/guards";
import {
  leagueOfSeason,
  leagueOfTeam,
  leagueOfTeamPlayer,
} from "@/lib/league/of-entity";
import { logAudit } from "@/lib/audit";

export type RosterActionState = { ok: boolean; message: string } | null;

export async function addRosterPlayer(
  _prev: RosterActionState,
  formData: FormData,
): Promise<RosterActionState> {
  const admin = createAdminClient();

  const season_id = String(formData.get("season_id"));
  const team_id = String(formData.get("team_id"));
  // These forms carry ids, never a league — the league is in the URL of the
  // page that rendered them. Every guard below therefore derives it from the
  // rows being written, which is what makes a hand-made request naming another
  // league's ids fail rather than pass.
  //
  // BOTH ids, because both are written. Guarding the season alone let a foreign
  // `team_id` through, and `is_captain` rides in the same payload.
  const manager = await requireLeagueManagerOf(
    () => leagueOfSeason(season_id, admin),
    () => leagueOfTeam(team_id, admin),
  );
  const existing_id = String(formData.get("player_id") ?? "").trim();
  const first = String(formData.get("first_name") ?? "").trim();
  const last = String(formData.get("last_name") ?? "").trim();
  const jerseyRaw = formData.get("jersey_number");
  const jersey = jerseyRaw ? Number(jerseyRaw) : null;
  const position = String(formData.get("position") ?? "F");
  const is_captain = formData.get("is_captain") === "on";

  let player_id = existing_id;
  let label = "Player";

  if (!player_id) {
    if (!first || !last) {
      return {
        ok: false,
        message: "Pick an existing person, or enter a first and last name.",
      };
    }
    const { data: player, error: pErr } = await admin
      .from("players")
      .insert({ first_name: first, last_name: last })
      .select("id")
      .single();
    if (pErr) return { ok: false, message: pErr.message };
    player_id = player!.id;
    label = `${first} ${last}`;
  }

  // A row for this person may already be here, departed. `unique (season_id,
  // team_id, player_id)` from 0003 is deliberately non-partial (see 0036), so
  // the insert below would be rejected with a bare 23505 — and coming back is
  // not an edge case: the picker offers departed players, because the roster it
  // subtracts is filtered to active rows. Clear the departure on the row that is
  // already there, exactly as `transferPlayer` does for a return to a former
  // team, and for the same reason: a second row for one player and team is what
  // that constraint exists to prevent.
  const { data: prior } = await admin
    .from("team_players")
    .select("id, left_on")
    .eq("season_id", season_id)
    .eq("team_id", team_id)
    .eq("player_id", player_id)
    .maybeSingle();

  if (prior && !prior.left_on) {
    return { ok: false, message: "They are already on this roster." };
  }

  const { data: inserted, error } = prior
    ? await admin
        .from("team_players")
        .update({
          left_on: null,
          jersey_number: jersey,
          position: position as "F" | "D" | "G",
          is_captain,
        })
        .eq("id", prior.id)
        .select("id")
        .single()
    : await admin
        .from("team_players")
        .insert({
          season_id,
          team_id,
          player_id,
          jersey_number: jersey,
          position: position as "F" | "D" | "G",
          is_captain,
        })
        .select("id")
        .single();
  if (error) return { ok: false, message: error.message };

  void logAudit({
    user_id: manager.id,
    action: "add_player",
    entity_type: "team_player",
    entity_id: inserted.id,
    // Whether this was a fresh row or a return. The revert path reads the row
    // rather than this field, but a reader asking why an "added" player already
    // has games behind them needs the answer to be written down.
    new_data: { player_id, team_id, season_id, position, returned: !!prior },
  });

  revalidatePath("/[league]/manage/rosters/[teamId]", "page");
  return {
    ok: true,
    message: prior
      ? `${label} is back on the roster.`
      : `${label} added to the roster.`,
  };
}

export async function removeRosterPlayer(formData: FormData) {
  const admin = createAdminClient();
  const id = String(formData.get("id"));
  const team_id = String(formData.get("team_id"));
  // Resolved BEFORE the delete and reused twice. Afterwards the roster row is
  // gone and `leagueOfTeamPlayer` has nothing to answer from, so an audit entry
  // that resolves its own league lands with a null one — hidden by RLS and by
  // every league-scoped view, which also puts it out of reach of the revert
  // that `old_data` below exists to serve.
  //
  // Eager rather than the lazy `() => …` form, so an unauthenticated POST costs
  // one lookup on its way to /login. `setActiveSeason` already trades the same
  // way for the same reason.
  const league_id = await leagueOfTeamPlayer(id, admin);
  const manager = await requireLeagueManager(league_id);

  // Capture full row before deletion so revert can restore it
  const { data: existing } = await admin
    .from("team_players")
    .select("*")
    .eq("id", id)
    .maybeSingle();

  // A roster row is history after 0036, so removal is only safe when there is
  // no history to lose — and this button reaches the exact destruction that
  // transfers were redesigned to avoid. Delete a row that has games behind it
  // and `v_goalie_stats`' inner join loses the old team's whole goalie record
  // (GP, W/L, GAA, shutouts) while the games stay on the schedule, and
  // `v_skater_stats`' left join loses the jersey and position. Nothing reports
  // an error.
  //
  // So: a player who never dressed was an add to undo — delete it. A player who
  // has dressed is marked departed, exactly as a transfer would mark them.
  // Scoped to THIS season through `games`. `game_rosters` has no `season_id` of
  // its own, so player+team alone counts games from every season this team has
  // ever played — and a player who dressed for them in 2025 but not this year
  // would be marked departed rather than deleted, leaving a row that then blocks
  // re-adding them.
  const played = existing
    ? ((
        await admin
          .from("game_rosters")
          .select("*, games!inner(season_id)", { count: "exact", head: true })
          .eq("player_id", existing.player_id)
          .eq("team_id", existing.team_id)
          .eq("games.season_id", existing.season_id)
      ).count ?? 0) > 0
    : false;

  if (played) {
    await admin
      .from("team_players")
      .update({
        left_on: new Date().toISOString().slice(0, 10),
        // Both are statements about the present that a departure ends. 0038
        // makes RLS agree about the captaincy independently.
        is_captain: false,
        is_default_goalie: false,
      })
      .eq("id", id);
  } else {
    await admin.from("team_players").delete().eq("id", id);
  }

  void logAudit({
    user_id: manager.id,
    action: "remove_player",
    entity_type: "team_player",
    entity_id: id,
    league_id,
    old_data: existing ?? { team_id },
    // Which branch ran. Someone asking why a name is still on a stats page has
    // to be able to tell a departure from a deletion, and the revert path below
    // has to know which one it is undoing.
    new_data: { removal: played ? "departed" : "deleted" },
  });
  revalidatePath("/[league]/manage/rosters/[teamId]", "page");
}

/**
 * Move a player from one team to another, mid-season, without losing what they
 * did for the first one.
 *
 * The old roster row is kept and marked departed rather than deleted, because
 * that row IS the record: `v_goalie_stats` inner-joins it to credit a goalie's
 * games to the team they played them for, and `v_skater_stats` left-joins it
 * for jersey and position. Deleting it erases the old team's goalie record
 * entirely and blanks the skater lines, with no error anywhere.
 *
 * The order below is load-bearing and each step says why.
 */
export async function transferPlayer(
  _prev: RosterActionState,
  formData: FormData,
): Promise<RosterActionState> {
  const admin = createAdminClient();
  const id = String(formData.get("id") ?? "");
  const to_team_id = String(formData.get("to_team_id") ?? "");
  if (!id || !to_team_id) return { ok: false, message: "Pick a team to transfer to." };

  // The row first, and the season and old team come FROM it, not from the form.
  // A form that names its own `from_team_id` is a form that can lie about which
  // row it is moving. One indexed read before the guard is the same trade
  // `removeRosterPlayer` makes, and for the same reason.
  const { data: existing } = await admin
    .from("team_players")
    .select("*")
    .eq("id", id)
    .maybeSingle();
  if (!existing) return { ok: false, message: "That roster row no longer exists." };
  const { season_id, team_id: from_team_id, player_id } = existing;
  if (from_team_id === to_team_id) {
    return { ok: false, message: "They are already on that team." };
  }
  if (existing.left_on) {
    return { ok: false, message: "That player has already left this team." };
  }

  // All three ids, because all three are written or read against. Guarding the
  // season alone lets a foreign `to_team_id` through, and `requireLeagueManagerOf`
  // additionally refuses when the three do not agree on ONE league — which is
  // what stops a manager of two leagues binding one league's team into the
  // other's season.
  const manager = await requireLeagueManagerOf(
    () => leagueOfSeason(season_id, admin),
    () => leagueOfTeam(from_team_id, admin),
    () => leagueOfTeam(to_team_id, admin),
  );

  // Resolved BEFORE any write. An audit entry that resolves its own league
  // afterwards can land with a null one, which RLS and every league-scoped view
  // then hide — correct and invisible.
  const league_id = await leagueOfSeason(season_id, admin);

  // Present-but-empty and absent mean different things. The form prefills the
  // number they wear now, so clearing it is the operator saying "no number on
  // the new team" — while a form that carries no field at all has expressed no
  // opinion and keeps what they had.
  const jerseyRaw = formData.get("jersey_number");
  const wanted =
    jerseyRaw === null
      ? existing.jersey_number
      : String(jerseyRaw).trim() === ""
        ? null
        : Number(jerseyRaw);

  // The destination has to be playing this season. `requireLeagueManagerOf`
  // proves all three ids agree on one league, which is not the same question —
  // a team can belong to the league and not be enrolled — and the page only
  // offers enrolled teams, so nothing else would stop a hand-made POST creating
  // a roster row for a team that is not in the season.
  const { data: enrolled } = await admin
    .from("season_teams")
    .select("team_id")
    .eq("season_id", season_id)
    .eq("team_id", to_team_id)
    .maybeSingle();
  if (!enrolled) {
    return { ok: false, message: "That team is not enrolled in this season." };
  }

  // Checked before anything is written, and reported rather than worked around.
  // The bulk importer silently writes null on a clash, which is right for a
  // hundred rows nobody is watching and wrong for one deliberate move: a number
  // is how a scorekeeper identifies a player, and quietly removing it turns
  // into a scoresheet nobody can fill in.
  if (wanted != null) {
    const { data: clash } = await admin
      .from("team_players")
      .select("player_id, players!team_players_player_id_fkey(first_name, last_name)")
      .eq("season_id", season_id)
      .eq("team_id", to_team_id)
      .eq("jersey_number", wanted)
      .is("left_on", null)
      .neq("player_id", player_id)
      .maybeSingle();
    if (clash) {
      const who = clash.players
        ? `${clash.players.first_name} ${clash.players.last_name}`
        : "another player";
      return {
        ok: false,
        message: `#${wanted} is already worn by ${who} on that team. Choose a different number.`,
      };
    }
  }

  // 1. Depart the old row FIRST. `team_players_one_active_team` (0036) is a
  //    unique index on (season_id, player_id) where left_on is null, so the
  //    insert below is rejected while this row is still active.
  //
  //    is_captain and is_default_goalie go with it: both are claims about the
  //    present that the move ends, and a captain who kept the flag kept write
  //    access to their former team's scoresheet for the rest of the season.
  //    0038 makes RLS agree independently.
  const left_on = new Date().toISOString().slice(0, 10);
  const { error: dErr } = await admin
    .from("team_players")
    .update({ left_on, is_captain: false, is_default_goalie: false })
    .eq("id", id);
  if (dErr) return { ok: false, message: `Could not release the player: ${dErr.message}` };

  // 2. The old team's default-goalie days for this player. Unlike the roster
  //    row these say nothing about the past — they are a standing instruction
  //    about who starts on Tuesdays.
  await admin
    .from("team_goalie_days")
    .delete()
    .eq("season_id", season_id)
    .eq("team_id", from_team_id)
    .eq("player_id", player_id);

  // 3. Lineups already set for games the old team has NOT played.
  //
  //    Captains set lineups in advance, so game_rosters rows exist before a game
  //    is played. Left alone, a transferred player stays dressed for the old
  //    team in games they will not play — and that becomes a real GP and a real
  //    stat line the moment the game is finalized.
  //
  //    Final games are untouched. That history is the whole point of the design.
  const { data: upcoming } = await admin
    .from("games")
    .select("id")
    .eq("season_id", season_id)
    .neq("status", "final")
    .or(`home_team_id.eq.${from_team_id},away_team_id.eq.${from_team_id}`);
  let undressed: string[] = [];
  if (upcoming?.length) {
    const { data: removed } = await admin
      .from("game_rosters")
      .delete()
      .eq("player_id", player_id)
      .eq("team_id", from_team_id)
      .in("game_id", upcoming.map((g) => g.id))
      .select("game_id");
    undressed = (removed ?? []).map((r) => r.game_id);
  }

  // 4. Join the new team — or come back to a former one. `unique (season_id,
  //    team_id, player_id)` from 0003 is deliberately NOT partial (see 0036),
  //    so a return cannot insert a second row for that team: the row already
  //    there has its departure cleared instead.
  const { data: former } = await admin
    .from("team_players")
    .select("id")
    .eq("season_id", season_id)
    .eq("team_id", to_team_id)
    .eq("player_id", player_id)
    .maybeSingle();

  const joinErr = former
    ? (
        await admin
          .from("team_players")
          .update({ left_on: null, jersey_number: wanted, position: existing.position })
          .eq("id", former.id)
      ).error
    : (
        await admin.from("team_players").insert({
          season_id,
          team_id: to_team_id,
          player_id,
          jersey_number: wanted,
          // Carried over: a defenceman does not change position by changing team.
          position: existing.position,
        })
      ).error;

  if (joinErr) {
    // Steps 1–3 have already landed: the player is released, their goalie days
    // are gone and their upcoming lineups are deleted. There is no transaction
    // here — supabase-js has none — so a half-finished transfer is a real
    // outcome, and the only way anyone finds out what reached the database is
    // this entry. `logAudit` swallows its own errors, so it cannot turn a failed
    // transfer into a thrown one.
    await logAudit({
      user_id: manager.id,
      action: "transfer_player_partial",
      entity_type: "team_player",
      entity_id: id,
      league_id,
      old_data: { ...existing, undressed_games: undressed },
      new_data: { to_team_id, failed_at: "join", error: joinErr.message },
    });
    return {
      ok: false,
      message:
        `Released from the old team, but joining the new one failed: ${joinErr.message}. ` +
        `The player is on no team and their upcoming lineups for the old team were ` +
        `removed — the audit log has the details.`,
    };
  }

  void logAudit({
    user_id: manager.id,
    action: "transfer_player",
    entity_type: "team_player",
    entity_id: id,
    league_id,
    old_data: {
      ...existing,
      // The lineups this move cancelled. Nothing else records that they existed,
      // and "why is he not dressed for Thursday" needs an answer.
      undressed_games: undressed,
    },
    new_data: { to_team_id, jersey_number: wanted, left_on },
  });

  // A transfer changes two rosters plus the public team and stats pages, so it
  // needs more revalidation than an add, not the same. Without this the player
  // shows on BOTH rosters until something unrelated invalidates the cache —
  // which looks exactly like the bug this feature exists to prevent.
  revalidatePath("/[league]/manage/rosters/[teamId]", "page");
  revalidatePath("/[league]/teams/[slug]", "page");
  revalidatePath("/[league]/stats", "page");
  revalidatePath("/[league]", "layout");

  return { ok: true, message: "Player transferred." };
}

export async function toggleCaptain(formData: FormData) {
  const admin = createAdminClient();
  const id = String(formData.get("id"));
  const manager = await requireLeagueManager(() => leagueOfTeamPlayer(id, admin));
  const make = formData.get("make") === "1";
  await admin.from("team_players").update({ is_captain: make }).eq("id", id);
  void logAudit({
    user_id: manager.id,
    action: "toggle_captain",
    entity_type: "team_player",
    entity_id: id,
    new_data: { is_captain: make },
  });
  revalidatePath("/[league]/manage/rosters/[teamId]", "page");
}

export async function setDefaultGoalie(formData: FormData) {
  const admin = createAdminClient();
  const id = String(formData.get("id")); // team_players.id
  const team_id = String(formData.get("team_id"));
  const season_id = String(formData.get("season_id"));
  const make = formData.get("make") === "1";
  // All three, unconditionally. The `id` update only runs when setting, so
  // guarding it only then looks precise — but `logAudit` below uses the id
  // whatever `make` is, and it writes on the admin client, past RLS. Guarding
  // the table writes alone therefore left an unset able to file an entry
  // against another league's roster row, into that league's audit log.
  const manager = await requireLeagueManagerOf(
    () => leagueOfSeason(season_id, admin),
    () => leagueOfTeam(team_id, admin),
    () => leagueOfTeamPlayer(id, admin),
  );

  // Clear any existing default on this team/season first, then set the new one.
  await admin
    .from("team_players")
    .update({ is_default_goalie: false })
    .eq("team_id", team_id)
    .eq("season_id", season_id);
  if (make) {
    await admin.from("team_players").update({ is_default_goalie: true }).eq("id", id);
  }
  void logAudit({
    user_id: manager.id,
    action: "set_default_goalie",
    entity_type: "team_player",
    entity_id: id,
    new_data: { is_default_goalie: make },
  });
  revalidatePath("/[league]/manage/rosters/[teamId]", "page");
}

export async function setGoalieDay(formData: FormData) {
  const admin = createAdminClient();
  const team_id = String(formData.get("team_id"));
  const season_id = String(formData.get("season_id"));
  // Both ids are written, so both are checked — and against the SAME league.
  // Two independent membership checks would pass for a person who manages both
  // leagues while still writing one league's team into the other's season.
  const manager = await requireLeagueManagerOf(
    () => leagueOfSeason(season_id, admin),
    () => leagueOfTeam(team_id, admin),
  );
  const day_of_week = Number(formData.get("day_of_week"));
  const player_id = String(formData.get("player_id") ?? "").trim();

  if (player_id) {
    await admin
      .from("team_goalie_days")
      .upsert({ team_id, season_id, day_of_week, player_id }, { onConflict: "team_id,season_id,day_of_week" });
  } else {
    await admin
      .from("team_goalie_days")
      .delete()
      .eq("team_id", team_id)
      .eq("season_id", season_id)
      .eq("day_of_week", day_of_week);
  }
  void logAudit({
    user_id: manager.id,
    action: "set_goalie_day",
    entity_type: "team",
    entity_id: team_id,
    new_data: { day_of_week, player_id: player_id || null },
  });
  revalidatePath("/[league]/manage/rosters/[teamId]", "page");
}

export async function updatePlayerStatus(formData: FormData) {
  const admin = createAdminClient();
  const id = String(formData.get("id"));
  const manager = await requireLeagueManager(() => leagueOfTeamPlayer(id, admin));
  const field = String(formData.get("field"));

  // Capture current value before update so revert can restore it
  const { data: currentRow } = await admin
    .from("team_players")
    .select("is_rookie, is_suspended, injury_notes")
    .eq("id", id)
    .maybeSingle();

  if (field === "injury_notes") {
    const raw = String(formData.get("value") ?? "").trim();
    await admin.from("team_players").update({ injury_notes: raw || null }).eq("id", id);
  } else if (field === "is_rookie") {
    const val = formData.get("value") === "1";
    await admin.from("team_players").update({ is_rookie: val }).eq("id", id);
  } else if (field === "is_suspended") {
    const val = formData.get("value") === "1";
    await admin.from("team_players").update({ is_suspended: val }).eq("id", id);
  } else {
    return;
  }

  let oldVal: unknown;
  if (currentRow) {
    if (field === "injury_notes") oldVal = currentRow.injury_notes;
    else if (field === "is_rookie") oldVal = currentRow.is_rookie;
    else if (field === "is_suspended") oldVal = currentRow.is_suspended;
  }

  void logAudit({
    user_id: manager.id,
    action: "update_player_status",
    entity_type: "team_player",
    entity_id: id,
    old_data: oldVal !== undefined ? { [field]: oldVal } : null,
    new_data: { field, value: formData.get("value") },
  });
  revalidatePath("/[league]/manage/rosters/[teamId]", "page");
}
