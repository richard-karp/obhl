"use server";

import { revalidatePath } from "next/cache";
import { createAdminClient } from "@/utils/supabase/admin";
import {
  requireLeagueManager,
  requireLeagueManagerOf,
} from "@/lib/auth/guards";
import {
  leagueIdIfExists,
  leagueOfSeason,
  leagueOfTeam,
  leagueOfTeamPlayer,
  leaguesOfPlayer,
} from "@/lib/league/of-entity";
import { mayWritePlayer, memberLeagueIds } from "@/lib/auth/membership";
import { isPlayerArchivedIn } from "@/lib/players/archive";
import { logAudit } from "@/lib/audit";
import type { Tables } from "@/lib/db/helpers";

export type RosterActionState = { ok: boolean; message: string } | null;

type Admin = ReturnType<typeof createAdminClient>;
type RosterRow = Tables<"team_players">;
type Position = "F" | "D" | "G";

const POSITIONS: readonly Position[] = ["F", "D", "G"];
const isPosition = (v: string): v is Position =>
  (POSITIONS as readonly string[]).includes(v);

/**
 * A jersey number off a form. `null` is a real answer — no number — and so is a
 * refusal, so the three outcomes are kept apart rather than collapsed into
 * `Number(x) || null`, which turns 0 into "no number" and "abc" into it too.
 */
function parseJersey(raw: FormDataEntryValue | null): number | null | "invalid" {
  if (raw === null) return null;
  const s = String(raw).trim();
  if (s === "") return null;
  const n = Number(s);
  if (!Number.isInteger(n) || n < 0 || n > 99) return "invalid";
  return n;
}

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
  // Resolved again rather than asserted from the guard: the archive check and
  // the audit entry below both need a real league, and a null one fails open in
  // the first and invisible in the second.
  const league_id = await leagueOfSeason(season_id, admin);
  if (!league_id) return { ok: false, message: "That season no longer exists." };

  // ⛔ THE TEAM HAS TO BE PLAYING THIS SEASON — the same check
  // `movePlayerToTeam` makes, and for the same reason: the guard above proves
  // the ids agree on one league, which is a different question, because a team
  // can belong to the league and not be enrolled. Without it this action was
  // the one write path that would create a `team_players` row for a team the
  // season does not have. The season switcher made that reachable by clicking
  // (it keeps the `teamId` in the path), and the page now shows an empty state
  // instead — but a page that omits a form is a list, not a restriction.
  const { data: seasonTeam } = await admin
    .from("season_teams")
    .select("team_id")
    .eq("season_id", season_id)
    .eq("team_id", team_id)
    .maybeSingle();
  if (!seasonTeam) {
    return { ok: false, message: "That team is not enrolled in this season." };
  }

  const existing_id = String(formData.get("player_id") ?? "").trim();
  const first = String(formData.get("first_name") ?? "").trim();
  const last = String(formData.get("last_name") ?? "").trim();
  const jersey = parseJersey(formData.get("jersey_number"));
  if (jersey === "invalid") {
    return { ok: false, message: "A jersey number has to be a whole number from 0 to 99." };
  }
  const positionRaw = String(formData.get("position") ?? "F");
  if (!isPosition(positionRaw)) {
    return { ok: false, message: "Pick a position: F, D or G." };
  }
  const position = positionRaw;
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
  } else {
    const { data: person } = await admin
      .from("players")
      .select("first_name, last_name")
      .eq("id", player_id)
      .maybeSingle();
    if (!person) return { ok: false, message: "That person no longer exists." };
    label = `${person.first_name} ${person.last_name}`;

    // ⛔ Checked on the SERVER, not left to the picker. The picker filters
    // archived people out of its list, but a list is not a restriction: the
    // form carries a player id, and a hand-made POST names whichever one it
    // likes. Restoring is a click away in the picker, so say that rather than
    // just refusing.
    if (await isPlayerArchivedIn(player_id, league_id, admin)) {
      return {
        ok: false,
        message:
          `${label} was archived out of this league. Turn on “Show archived” in the ` +
          `picker and restore them, then add them.`,
      };
    }
  }

  // ⛔ ALREADY PLAYING FOR SOMEONE ELSE THIS SEASON — checked BEFORE the
  // returning-player branch below, and routed through the one move path.
  //
  // Adding a person who is already on another team is the same event as
  // transferring them, and it has to leave the old team's record intact for the
  // same reason (0036: `v_goalie_stats` inner-joins the roster row). Two things
  // would otherwise go wrong here and neither reports an error: an insert is
  // rejected by `team_players_one_active_team` with a bare 23505, and clearing
  // a departed row on THIS team while they are active elsewhere would violate
  // the same index. `movePlayerToTeam` handles both, and it is the only
  // implementation of the move there is.
  // `limit(1)` rather than `maybeSingle()`, which treats two rows as an error
  // and hands back null data — a player who held two active rows would then
  // look like a player with none, and this would add a THIRD.
  //
  // ⚠️ THAT STATE IS UNREACHABLE, and the index says so:
  // `team_players_one_active_team` is UNIQUE on `(season_id, player_id) WHERE
  // left_on IS NULL`, so one season cannot hold two active rows for one person.
  // This is belt-and-braces over a database guarantee, which is also why there
  // is NO `.order()` here: there is never more than one row to order, and an
  // earlier attempt to add one ordered by a `created_at` this table does not
  // have — PostgREST rejected the query, `data` came back null, and the whole
  // move-on-add path silently stopped moving anyone.
  const { data: activeRows } = await admin
    .from("team_players")
    .select("*")
    .eq("season_id", season_id)
    .eq("player_id", player_id)
    .neq("team_id", team_id)
    .is("left_on", null)
    .limit(1);
  const activeElsewhere = activeRows?.[0] ?? null;

  if (activeElsewhere) {
    // ⛔ The guard at the top of this action covers the season and the
    // DESTINATION team. This move also writes the SOURCE team's row, which
    // `transferPlayer` names in its own three-way guard. The season constrains
    // it — a season only enrols its own league's teams — so this should never
    // fire, which is exactly what makes it cheap to assert instead of assume.
    if ((await leagueOfTeam(activeElsewhere.team_id, admin)) !== league_id) {
      return { ok: false, message: "That player's current team is in another league." };
    }
    return movePlayerToTeam({
      admin,
      manager_id: manager.id,
      league_id,
      existing: activeElsewhere,
      to_team_id: team_id,
      jersey_number: jersey,
      // The add form's choice, not the old row's: the operator filled it in on
      // this page and a transfer's carry-over would silently overrule them.
      position,
      is_captain,
      via: "add",
      label,
    });
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
          position,
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
          position,
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
 * ⛔ THIS IS THE ONLY IMPLEMENTATION OF THAT MOVE, AND IT MUST STAY THE ONLY
 * ONE. Two callers reach it: the Transfer control, and `addRosterPlayer` when
 * the person it names is already active on another team this season. The naive
 * second version — delete the old row, insert a new one — is what 0036 exists
 * to prevent, and it reports no error while it does it. A second copy of this
 * function is a second chance to write that version, and nothing would fail
 * until someone opened a team page months later and found a goalie missing.
 *
 * Everything here runs AFTER the caller's guards, on the admin client: it
 * assumes the caller has already proved that the manager works this league and
 * that every id names it. It does not re-derive the league, and it must not be
 * exported.
 *
 * The order below is load-bearing and each step says why.
 */
async function movePlayerToTeam(opts: {
  admin: Admin;
  manager_id: string;
  league_id: string;
  /** The player's CURRENT roster row — active, and the one being left. */
  existing: RosterRow;
  to_team_id: string;
  /** Already resolved: `null` means "no number on the new team". */
  jersey_number: number | null;
  /** The position on the new team. A transfer carries the old one over. */
  position: Position;
  is_captain: boolean;
  /** Which control asked for the move. Recorded, and shapes the message. */
  via: "transfer" | "add";
  /** The player's display name, when the caller already has it. */
  label?: string;
}): Promise<RosterActionState> {
  const {
    admin,
    manager_id,
    league_id,
    existing,
    to_team_id,
    jersey_number: wanted,
    position,
    is_captain,
    via,
    label,
  } = opts;
  const { id, season_id, team_id: from_team_id, player_id } = existing;

  // The destination has to be playing this season. The caller's guard proves
  // every id agrees on one league, which is not the same question — a team can
  // belong to the league and not be enrolled — and the page only offers
  // enrolled teams, so nothing else would stop a hand-made POST creating a
  // roster row for a team that is not in the season.
  const { data: enrolled } = await admin
    .from("season_teams")
    .select("team_id, teams!season_teams_team_id_fkey(name)")
    .eq("season_id", season_id)
    .eq("team_id", to_team_id)
    .maybeSingle();
  if (!enrolled) {
    return { ok: false, message: "That team is not enrolled in this season." };
  }
  const toName = enrolled.teams?.name ?? "the new team";

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
  //
  //    ⚠️ `is_captain` is written EXPLICITLY on both branches, and on the update
  //    branch that is a change from what `transferPlayer` used to do. The row
  //    being un-departed carries whatever flags it held when the player left,
  //    and a row departed by a path predating the clear in step 1 can still hold
  //    `is_captain`. Left unset, returning to a former team silently restored
  //    the captaincy — and with it, through `is_captain_of` (0038), RLS write
  //    access to that team's scoresheet.
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
          .update({
            left_on: null,
            jersey_number: wanted,
            position,
            is_captain,
          })
          .eq("id", former.id)
      ).error
    : (
        await admin.from("team_players").insert({
          season_id,
          team_id: to_team_id,
          player_id,
          jersey_number: wanted,
          position,
          is_captain,
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
      user_id: manager_id,
      action: "transfer_player_partial",
      entity_type: "team_player",
      entity_id: id,
      league_id,
      old_data: { ...existing, undressed_games: undressed },
      new_data: { to_team_id, via, failed_at: "join", error: joinErr.message },
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
    user_id: manager_id,
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
    // `via` separates the two doors onto one action. Both are a transfer, and
    // the log should not claim otherwise, but "I only meant to add them" is a
    // real question a reader will bring to this entry.
    new_data: { to_team_id, jersey_number: wanted, left_on, via, name: label ?? null },
  });

  // A transfer changes two rosters plus the public team and stats pages, so it
  // needs more revalidation than an add, not the same. Without this the player
  // shows on BOTH rosters until something unrelated invalidates the cache —
  // which looks exactly like the bug this feature exists to prevent.
  revalidatePath("/[league]/manage/rosters/[teamId]", "page");
  revalidatePath("/[league]/teams/[slug]", "page");
  revalidatePath("/[league]/stats", "page");
  revalidatePath("/[league]", "layout");

  return {
    ok: true,
    message:
      via === "add"
        ? `${label ?? "That player"} was already on another team this season, so they were ` +
          `moved to ${toName}. Their record with the old team is kept.`
        : "Player transferred.",
  };
}

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
  const { season_id, team_id: from_team_id } = existing;
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
  if (!league_id) return { ok: false, message: "That season no longer exists." };

  // Present-but-empty and absent mean different things. The form prefills the
  // number they wear now, so clearing it is the operator saying "no number on
  // the new team" — while a form that carries no field at all has expressed no
  // opinion and keeps what they had.
  const jerseyRaw = formData.get("jersey_number");
  const wanted =
    jerseyRaw === null ? existing.jersey_number : parseJersey(jerseyRaw);
  if (wanted === "invalid") {
    return { ok: false, message: "A jersey number has to be a whole number from 0 to 99." };
  }

  return movePlayerToTeam({
    admin,
    manager_id: manager.id,
    league_id,
    existing,
    to_team_id,
    jersey_number: wanted,
    // Carried over: a defenceman does not change position by changing team.
    position: existing.position,
    // A move ends the captaincy it does not carry — the same statement step 1
    // makes about the row being left.
    is_captain: false,
    via: "transfer",
  });
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

/**
 * Jersey number and position, on ONE roster row.
 *
 * Scoped to `team_players` on purpose: both columns are facts about this
 * player on this team in this season, not about the person. Nothing here
 * reaches `players`, and nothing here reaches history — `game_rosters` records
 * who dressed, and carries no number of its own, so a corrected number does not
 * rewrite a scoresheet that has already been filled in.
 */
export async function updateRosterPlayer(
  _prev: RosterActionState,
  formData: FormData,
): Promise<RosterActionState> {
  const admin = createAdminClient();
  const id = String(formData.get("id") ?? "");
  if (!id) return { ok: false, message: "Nothing to update." };

  // The row first, and the season and team come FROM it. A form that names its
  // own season is a form that can lie about which league it belongs to. Same
  // trade as `removeRosterPlayer` and `transferPlayer`: one indexed read before
  // the guard.
  const { data: existing } = await admin
    .from("team_players")
    .select("*")
    .eq("id", id)
    .maybeSingle();
  if (!existing) return { ok: false, message: "That roster row no longer exists." };

  const manager = await requireLeagueManagerOf(
    () => leagueOfSeason(existing.season_id, admin),
    () => leagueOfTeam(existing.team_id, admin),
  );

  const jersey = parseJersey(formData.get("jersey_number"));
  if (jersey === "invalid") {
    return { ok: false, message: "A jersey number has to be a whole number from 0 to 99." };
  }
  const positionRaw = String(formData.get("position") ?? existing.position);
  if (!isPosition(positionRaw)) {
    return { ok: false, message: "Pick a position: F, D or G." };
  }
  const position = positionRaw;

  // Named rather than left to a bare 23505 from `team_players_active_jersey`
  // (0036), for the reason `movePlayerToTeam` gives: a number is how a
  // scorekeeper identifies a player, and "duplicate key value violates unique
  // constraint" is not something to hand an operator.
  if (jersey != null && jersey !== existing.jersey_number) {
    const { data: clash } = await admin
      .from("team_players")
      .select("players!team_players_player_id_fkey(first_name, last_name)")
      .eq("season_id", existing.season_id)
      .eq("team_id", existing.team_id)
      .eq("jersey_number", jersey)
      .is("left_on", null)
      .neq("id", id)
      .maybeSingle();
    if (clash) {
      const who = clash.players
        ? `${clash.players.first_name} ${clash.players.last_name}`
        : "another player";
      return {
        ok: false,
        message: `#${jersey} is already worn by ${who} on this team. Choose a different number.`,
      };
    }
  }

  // Moving OFF goal takes the goalie machinery with it. `is_default_goalie` and
  // the `team_goalie_days` rows are both standing instructions about who starts,
  // and the Goalie Schedule control only lists rostered goalies — so a row left
  // behind here points at somebody who is no longer in its own dropdown, and
  // renders as "— use default" while still overriding the default.
  const leavingGoal = existing.position === "G" && position !== "G";

  const { error } = await admin
    .from("team_players")
    .update({
      jersey_number: jersey,
      position,
      ...(leavingGoal ? { is_default_goalie: false } : {}),
    })
    .eq("id", id);
  if (error) return { ok: false, message: error.message };

  if (leavingGoal) {
    await admin
      .from("team_goalie_days")
      .delete()
      .eq("season_id", existing.season_id)
      .eq("team_id", existing.team_id)
      .eq("player_id", existing.player_id);
  }

  const { data: person } = await admin
    .from("players")
    .select("first_name, last_name")
    .eq("id", existing.player_id)
    .maybeSingle();
  const name = person ? `${person.first_name} ${person.last_name}` : null;

  void logAudit({
    user_id: manager.id,
    action: "update_roster_player",
    entity_type: "team_player",
    entity_id: id,
    old_data: {
      jersey_number: existing.jersey_number,
      position: existing.position,
      is_default_goalie: existing.is_default_goalie,
    },
    new_data: { jersey_number: jersey, position, name },
  });

  // The number and position show on the public team page and in the stats
  // tables, not only on this page.
  revalidatePath("/[league]/manage/rosters/[teamId]", "page");
  revalidatePath("/[league]/teams/[slug]", "page");
  revalidatePath("/[league]/stats", "page");
  return { ok: true, message: `Updated ${name ?? "the player"}.` };
}

/**
 * Correct a person's NAME — the global `players` row.
 *
 * ⚠️ THIS IS NOT A LEAGUE-SCOPED WRITE, AND THE UI SAYS SO. `players` has no
 * `league_id` (0002_core.sql:43): one human is one row, shared by every league
 * they play in, which is what lets a person carry their identity between
 * leagues. So a correction here lands on their name in every one of those
 * leagues' standings, stats and scoresheets at once.
 *
 * Which is why it is gated by containment (`mayWritePlayer`) rather than by
 * membership of the league the form was submitted from. Renaming somebody in a
 * league you do not work is not a smaller version of renaming them in one you
 * do — it is the same single write, reaching further than the person making it
 * can see.
 */
export async function updatePlayerName(
  _prev: RosterActionState,
  formData: FormData,
): Promise<RosterActionState> {
  const admin = createAdminClient();
  const id = String(formData.get("id") ?? "");
  const first = String(formData.get("first_name") ?? "").trim();
  const last = String(formData.get("last_name") ?? "").trim();
  if (!id) return { ok: false, message: "Nothing to rename." };
  if (!first || !last) {
    return { ok: false, message: "A first and last name are both required." };
  }

  // The player comes from the ROSTER ROW, not from the form. A form carrying a
  // `player_id` of its own is a form that can name anybody in the instance and
  // have this action rename them under this league's guard.
  const { data: row } = await admin
    .from("team_players")
    .select("season_id, team_id, player_id")
    .eq("id", id)
    .maybeSingle();
  if (!row) return { ok: false, message: "That roster row no longer exists." };

  const manager = await requireLeagueManagerOf(
    () => leagueOfSeason(row.season_id, admin),
    () => leagueOfTeam(row.team_id, admin),
  );
  const league_id = await leagueOfSeason(row.season_id, admin);
  if (!league_id) return { ok: false, message: "That season no longer exists." };

  const { data: before } = await admin
    .from("players")
    .select("first_name, last_name")
    .eq("id", row.player_id)
    .maybeSingle();
  if (!before) return { ok: false, message: "That person no longer exists." };
  const wasName = `${before.first_name} ${before.last_name}`;

  if (!(await mayWritePlayer(manager.id, row.player_id))) {
    // ⛔ REFUSED OUT LOUD, NAMING THE LEAGUES AND THE ROUTE. This refusal is the
    // accepted cost of a global `players` row, not a bug — but a manager who is
    // simply told "no" will assume the feature is broken and try again. Say
    // which leagues put the player out of reach, say why one row means one
    // name, and name the League Office, which CAN make the change: its members
    // reach every league (0034), and `memberLeagueIds` answers for them with
    // every league, so containment passes there by construction.
    const theirs = await leaguesOfPlayer(row.player_id, admin);
    const mine = new Set(await memberLeagueIds(manager.id));
    const outside = theirs.filter((l) => !mine.has(l));
    const { data: leagues } = outside.length
      ? await admin.from("leagues").select("name").in("id", outside)
      : { data: [] as { name: string }[] };
    const names = (leagues ?? []).map((l) => l.name).join(", ");
    return {
      ok: false,
      message:
        `${wasName} also plays in ${names || "a league you do not manage"}. A player's ` +
        `name is one record shared by every league they play in, so renaming them here ` +
        `would rename them there too — and that is not yours to change. Ask the League ` +
        `Office to make the correction.`,
    };
  }

  const { error } = await admin
    .from("players")
    .update({ first_name: first, last_name: last })
    .eq("id", row.player_id);
  if (error) return { ok: false, message: error.message };

  void logAudit({
    user_id: manager.id,
    action: "update_player_name",
    // `leagueOfEntity` returns null for "player" BY DECISION — a player belongs
    // to no single league — so the league is passed here, or the entry lands
    // correct and invisible behind RLS and every league-scoped view.
    entity_type: "player",
    entity_id: row.player_id,
    league_id,
    old_data: { first_name: before.first_name, last_name: before.last_name },
    new_data: { first_name: first, last_name: last, name: `${first} ${last}` },
  });

  // The dynamic segments are deliberate. A rename reaches every league this
  // person plays in, and `revalidatePath` with a route pattern plus a type
  // invalidates every URL matching it — so this clears the other leagues' pages
  // too, which naming one league's concrete paths would not.
  revalidatePath("/[league]/manage/rosters/[teamId]", "page");
  revalidatePath("/[league]/teams/[slug]", "page");
  revalidatePath("/[league]/stats", "page");
  revalidatePath("/[league]/players/[playerId]", "page");
  revalidatePath("/[league]", "layout");
  return { ok: true, message: `Renamed ${wasName} to ${first} ${last}.` };
}

/**
 * Remove a person from ONE LEAGUE's pickers (0040).
 *
 * ⛔ NOT A DELETE, AND NOT GLOBAL. It writes one `player_league_archive` row.
 * The person keeps their `players` row, every roster row they ever had, every
 * game they dressed for and every stat those produced; their player page still
 * renders and both stats views still credit them. And every OTHER league that
 * this person plays in is untouched — its picker still offers them, because the
 * archive row names this league and only this league. A global
 * `players.archived_at` would have hidden them from leagues that never asked.
 *
 * Plain arguments rather than FormData: the picker calls this straight from the
 * client in a transition, so there is no form to serialise. The league id is
 * therefore attacker-controlled like any other, and `leagueIdIfExists` plus
 * `requireLeagueManager` is what makes that safe — an id naming no league
 * resolves to null and the guard refuses.
 */
export async function archivePlayer(
  playerId: string,
  leagueId: string,
): Promise<RosterActionState> {
  const admin = createAdminClient();
  const manager = await requireLeagueManager(() => leagueIdIfExists(leagueId, admin));

  const { data: person } = await admin
    .from("players")
    .select("first_name, last_name")
    .eq("id", playerId)
    .maybeSingle();
  if (!person) return { ok: false, message: "That person no longer exists." };
  const name = `${person.first_name} ${person.last_name}`;

  // ⛔ THE INVARIANT THAT KEEPS ARCHIVING COHERENT: nobody is archived out of a
  // league while they are still on one of its rosters. Without it an archived
  // person keeps appearing in the roster table, with a Transfer button that
  // would put them straight onto another of this league's teams — an "archived"
  // player moving between teams, which is the state the whole feature is meant
  // to make unreachable. Refused with the team named, so the operator knows
  // what to do rather than being told no.
  //
  // Every season of this league, not just the current one: a person on next
  // season's roster is just as much a member of the league.
  const activeRosterTeams = async () => {
    const { data } = await admin
      .from("team_players")
      .select("teams!team_players_team_id_fkey(name), seasons!inner(league_id)")
      .eq("player_id", playerId)
      .is("left_on", null)
      .eq("seasons.league_id", leagueId);
    return [
      ...new Set((data ?? []).flatMap((a) => (a.teams?.name ? [a.teams.name] : []))),
    ];
  };
  const stillRostered = (teams: string[]) => ({
    ok: false as const,
    message:
      `${name} is still on ${teams.join(", ") || "a roster"} in this league. Remove them ` +
      `from the roster first — archiving hides someone from this league's pickers, it ` +
      `does not take them off a team.`,
  });

  const before = await activeRosterTeams();
  if (before.length) return stillRostered(before);

  // Upsert, not insert: archiving someone already archived is a no-op the
  // operator should not see an error for. Two managers clicking at once is the
  // realistic case, and 23505 is not the answer to it.
  const { error } = await admin
    .from("player_league_archive")
    .upsert(
      { player_id: playerId, league_id: leagueId, archived_by: manager.id },
      { onConflict: "player_id,league_id" },
    );
  if (error) return { ok: false, message: error.message };

  // ⚠️ ASKED AGAIN AFTER THE WRITE, because the check above is a read and
  // `addRosterPlayer` is a second writer. Interleaved — two managers, or one
  // with two tabs — `addRosterPlayer` reads the archive and finds nothing while
  // this action reads the roster and finds nothing, and both then succeed: an
  // archived person sitting on a roster, which is the state 0040's header calls
  // an invariant and does not enforce in the schema.
  //
  // Re-reading closes the order where the add lands DURING this call. It does
  // not close the reverse one, where this call finishes before the add's insert
  // — that window belongs to `addRosterPlayer`, whose own archive check has the
  // same shape, and closing it properly needs a trigger reading team_players.
  // So this narrows the race rather than removing it, and 0040's comment now
  // says that instead of claiming the rule always holds.
  //
  // The archive row goes whether or not this call created it: a person on a
  // roster must not be archived, so removing it is the right repair in both
  // cases rather than a rollback of our own insert.
  const after = await activeRosterTeams();
  if (after.length) {
    await admin
      .from("player_league_archive")
      .delete()
      .eq("player_id", playerId)
      .eq("league_id", leagueId);
    return stillRostered(after);
  }

  void logAudit({
    user_id: manager.id,
    action: "archive_player",
    entity_type: "player",
    entity_id: playerId,
    // Passed, for the same reason `updatePlayerName` passes it: "player"
    // resolves to no league on its own.
    league_id: leagueId,
    new_data: { name },
  });

  revalidatePath("/[league]/manage/rosters/[teamId]", "page");
  revalidatePath("/[league]/manage/people", "page");
  return { ok: true, message: `${name} was archived from this league.` };
}

/** Undo an archive, for this league only. The mirror of `archivePlayer`. */
export async function restorePlayer(
  playerId: string,
  leagueId: string,
): Promise<RosterActionState> {
  const admin = createAdminClient();
  const manager = await requireLeagueManager(() => leagueIdIfExists(leagueId, admin));

  const { data: person } = await admin
    .from("players")
    .select("first_name, last_name")
    .eq("id", playerId)
    .maybeSingle();
  const name = person ? `${person.first_name} ${person.last_name}` : "That player";

  // Scoped to the one league. A delete missing the `league_id` filter would
  // restore this person into every league that ever archived them.
  const { error } = await admin
    .from("player_league_archive")
    .delete()
    .eq("player_id", playerId)
    .eq("league_id", leagueId);
  if (error) return { ok: false, message: error.message };

  void logAudit({
    user_id: manager.id,
    action: "restore_player",
    entity_type: "player",
    entity_id: playerId,
    league_id: leagueId,
    new_data: { name },
  });

  revalidatePath("/[league]/manage/rosters/[teamId]", "page");
  revalidatePath("/[league]/manage/people", "page");
  return { ok: true, message: `${name} is available in this league again.` };
}
