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

// A jersey number off a form: `null` (no number) and `"invalid"` stay apart, unlike
// `Number(x) || null`, which turns 0 and "abc" into no number.
function parseJersey(
  raw: FormDataEntryValue | null,
): number | null | "invalid" {
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
  // These forms carry ids, never a league, so the guard derives it from every id written: guarding
  // the season alone let a foreign `team_id` through.
  const manager = await requireLeagueManagerOf(
    () => leagueOfSeason(season_id, admin),
    () => leagueOfTeam(team_id, admin),
  );
  // Resolved again, not assumed from the guard: a null league fails open in the archive check and
  // hides the audit entry.
  const league_id = await leagueOfSeason(season_id, admin);
  if (!league_id)
    return { ok: false, message: "That season no longer exists." };

  // ⛔ The team must be enrolled this season: same-league ids do not prove it, and a page omitting
  // the form is not a restriction.
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
    return {
      ok: false,
      message: "A jersey number has to be a whole number from 0 to 99.",
    };
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

    // ⛔ Checked here, not only by the picker: a hand-made POST names any player id. Say how to
    // restore rather than just refusing.
    if (await isPlayerArchivedIn(player_id, league_id, admin)) {
      return {
        ok: false,
        message:
          `${label} was archived out of this league. Turn on “Show archived” in the ` +
          `picker and restore them, then add them.`,
      };
    }
  }

  // ⛔ Active on another team this season means a transfer: `movePlayerToTeam` is the one move path.
  // `limit(1)` and no `.order()`: the index allows one active row, and `team_players` has no `created_at`.
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
    // ⛔ The guard covered the season and destination; this move also writes the source team's
    // row, so assert it is this league's rather than assume it.
    if ((await leagueOfTeam(activeElsewhere.team_id, admin)) !== league_id) {
      return {
        ok: false,
        message: "That player's current team is in another league.",
      };
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

  // A departed row for this player and team may exist: `unique (season_id, team_id, player_id)` is
  // non-partial (0036), so clear its departure rather than insert a second row.
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
          // ⛔ Written, not inherited: a revived row keeps whatever night it held when it
          // departed, and the add form asks for none.
          night_of_week: null,
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
    // Fresh row or return: the revert reads the row, but a reader of this entry needs the answer.
    new_data: { player_id, team_id, season_id, position, returned: !!prior },
  });

  revalidatePath("/[league]/teams/[slug]", "page");
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
  // Resolved before the delete: afterwards `leagueOfTeamPlayer` finds nothing, and a null-league
  // entry is hidden, out of reach of the revert (`RUNBOOK.md` → Access control → Traps).
  const league_id = await leagueOfTeamPlayer(id, admin);
  const manager = await requireLeagueManager(league_id);

  // Capture full row before deletion so revert can restore it
  const { data: existing } = await admin
    .from("team_players")
    .select("*")
    .eq("id", id)
    .maybeSingle();

  // A row with games behind it is history (0036): mark it departed, or `v_goalie_stats` loses the
  // team's goalie record. Scoped to this season through `games`, which carries `season_id`.
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
        // ⛔ Both end with a departure: a kept captaincy keeps RLS write access (0038), and a kept
        // night silently restores a re-added goalie as that night's starter.
        is_captain: false,
        night_of_week: null,
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
    // Which branch ran: a reader and the revert must tell a departure from a deletion.
    new_data: { removal: played ? "departed" : "deleted" },
  });
  revalidatePath("/[league]/teams/[slug]", "page");
}

// ⛔ The only implementation of a move, and never exported: it trusts the caller's guards, and a
// second copy invites the delete-and-insert that erases the old team's record (0036).
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

  // The destination must be enrolled this season: same-league ids do not prove it, and the page's
  // list is not a restriction.
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

  // A clash is refused before any write, never nulled as the importer does: a number is how a
  // scorekeeper identifies a player.
  if (wanted != null) {
    const { data: clash } = await admin
      .from("team_players")
      .select(
        "player_id, players!team_players_player_id_fkey(first_name, last_name)",
      )
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

  // 1. Depart the old row first: `team_players_one_active_team` (0036) rejects the insert below
  //    while it is active. Captaincy (RLS write access, 0038) and night end with it.
  const left_on = new Date().toISOString().slice(0, 10);
  const { error: dErr } = await admin
    .from("team_players")
    .update({ left_on, is_captain: false, night_of_week: null })
    .eq("id", id);
  if (dErr)
    return {
      ok: false,
      message: `Could not release the player: ${dErr.message}`,
    };

  // 2. Undress them from the old team's unplayed games: a pre-set lineup becomes a real GP when
  //    the game is finalized. Final games stay untouched.
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
      .in(
        "game_id",
        upcoming.map((g) => g.id),
      )
      .select("game_id");
    undressed = (removed ?? []).map((r) => r.game_id);
  }

  // 3. Join, or clear the departure on a former row (the unique key is non-partial). ⚠️ `is_captain`
  //    is written on both branches: a stale flag on a revived row restores RLS write access (0038).
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
            // Same reason as `is_captain`: a revived row's stale night would come back.
            night_of_week: null,
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
    // Steps 1–2 have landed with no transaction to undo them, so this entry is the only record of a
    // half-finished transfer.
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
    // `via` separates the two doors onto one action, for the reader asking "I only meant to add them".
    new_data: {
      to_team_id,
      jersey_number: wanted,
      left_on,
      via,
      name: label ?? null,
    },
  });

  // Two rosters and the public pages change: without all three, the player shows on both rosters
  // until something else invalidates the cache.
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
  if (!id || !to_team_id)
    return { ok: false, message: "Pick a team to transfer to." };

  // The row first: season and old team come from it, never the form, which could lie about which
  // row it moves.
  const { data: existing } = await admin
    .from("team_players")
    .select("*")
    .eq("id", id)
    .maybeSingle();
  if (!existing)
    return { ok: false, message: "That roster row no longer exists." };
  const { season_id, team_id: from_team_id } = existing;
  if (from_team_id === to_team_id) {
    return { ok: false, message: "They are already on that team." };
  }
  if (existing.left_on) {
    return { ok: false, message: "That player has already left this team." };
  }

  // All three ids: guarding the season alone lets a foreign `to_team_id` through, and the three must
  // agree on one league.
  const manager = await requireLeagueManagerOf(
    () => leagueOfSeason(season_id, admin),
    () => leagueOfTeam(from_team_id, admin),
    () => leagueOfTeam(to_team_id, admin),
  );

  // Resolved before any write: an entry resolving its own league afterwards can land null and hidden.
  const league_id = await leagueOfSeason(season_id, admin);
  if (!league_id)
    return { ok: false, message: "That season no longer exists." };

  // Empty means "no number on the new team"; an absent field keeps the current one.
  const jerseyRaw = formData.get("jersey_number");
  const wanted =
    jerseyRaw === null ? existing.jersey_number : parseJersey(jerseyRaw);
  if (wanted === "invalid") {
    return {
      ok: false,
      message: "A jersey number has to be a whole number from 0 to 99.",
    };
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

// ⚠️ Returns a state, so a refused UPDATE is reported rather than shown as success.
export async function toggleCaptain(
  _prev: RosterActionState,
  formData: FormData,
): Promise<RosterActionState> {
  const admin = createAdminClient();
  const id = String(formData.get("id"));
  const manager = await requireLeagueManager(() =>
    leagueOfTeamPlayer(id, admin),
  );
  const make = formData.get("make") === "1";
  const { error } = await admin
    .from("team_players")
    .update({ is_captain: make })
    .eq("id", id);
  if (error) {
    return {
      ok: false,
      message: `Couldn't change the captain. ${error.message}`,
    };
  }
  void logAudit({
    user_id: manager.id,
    action: "toggle_captain",
    entity_type: "team_player",
    entity_id: id,
    new_data: { is_captain: make },
  });
  revalidatePath("/[league]/teams/[slug]", "page");
  return { ok: true, message: make ? "Made captain." : "No longer captain." };
}

// ⚠️ No goalie-specific write path: a night is an ordinary roster field (`updateRosterPlayer`), and
// `src/lib/goalie/suggest.ts` picks the goalie from it.

// ⚠️ Returns a state: its UPDATEs' errors are reported, not discarded.
export async function updatePlayerStatus(
  _prev: RosterActionState,
  formData: FormData,
): Promise<RosterActionState> {
  const admin = createAdminClient();
  const id = String(formData.get("id"));
  const manager = await requireLeagueManager(() =>
    leagueOfTeamPlayer(id, admin),
  );
  const field = String(formData.get("field"));

  // Capture current value before update so revert can restore it
  const { data: currentRow } = await admin
    .from("team_players")
    .select("is_rookie, is_suspended, injury_notes")
    .eq("id", id)
    .maybeSingle();

  let writeError: string | null = null;
  if (field === "injury_notes") {
    const raw = String(formData.get("value") ?? "").trim();
    writeError =
      (
        await admin
          .from("team_players")
          .update({ injury_notes: raw || null })
          .eq("id", id)
      ).error?.message ?? null;
  } else if (field === "is_rookie") {
    const val = formData.get("value") === "1";
    writeError =
      (await admin.from("team_players").update({ is_rookie: val }).eq("id", id))
        .error?.message ?? null;
  } else if (field === "is_suspended") {
    const val = formData.get("value") === "1";
    writeError =
      (
        await admin
          .from("team_players")
          .update({ is_suspended: val })
          .eq("id", id)
      ).error?.message ?? null;
  } else {
    // ⚠️ An unknown field is a caller bug: say so rather than write nothing silently.
    return { ok: false, message: `Not a status field: ${field}.` };
  }
  if (writeError) {
    return { ok: false, message: `Couldn't save that. ${writeError}` };
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
  revalidatePath("/[league]/teams/[slug]", "page");
  return { ok: true, message: "Updated." };
}

// Jersey, position and night on one roster row: never `players`, and never `game_rosters`, so a
// corrected number does not rewrite a filled-in scoresheet.
export async function updateRosterPlayer(
  _prev: RosterActionState,
  formData: FormData,
): Promise<RosterActionState> {
  const admin = createAdminClient();
  const id = String(formData.get("id") ?? "");
  if (!id) return { ok: false, message: "Nothing to update." };

  // The row first, and the season and team come from it: a form naming its own season can lie.
  const { data: existing } = await admin
    .from("team_players")
    .select("*")
    .eq("id", id)
    .maybeSingle();
  if (!existing)
    return { ok: false, message: "That roster row no longer exists." };

  const manager = await requireLeagueManagerOf(
    () => leagueOfSeason(existing.season_id, admin),
    () => leagueOfTeam(existing.team_id, admin),
  );

  const jersey = parseJersey(formData.get("jersey_number"));
  if (jersey === "invalid") {
    return {
      ok: false,
      message: "A jersey number has to be a whole number from 0 to 99.",
    };
  }
  const positionRaw = String(formData.get("position") ?? existing.position);
  if (!isPosition(positionRaw)) {
    return { ok: false, message: "Pick a position: F, D or G." };
  }
  const position = positionRaw;

  // ⚠️ Absent and empty differ: an absent field (a one-night league renders no control) keeps the
  // stored night; empty clears it. Collapsing them wipes every night when a season drops to one.
  const rawNight = formData.get("night_of_week");
  let night: number | null | undefined = undefined;
  if (rawNight !== null) {
    const trimmed = String(rawNight).trim();
    if (trimmed === "") night = null;
    else {
      const n = Number(trimmed);
      if (!Number.isInteger(n) || n < 0 || n > 6) {
        return { ok: false, message: "Pick a night of the week, or none." };
      }
      night = n;
    }
  }

  // Named rather than a bare 23505 from `team_players_active_jersey` (0036): see `movePlayerToTeam`.
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

  // ⛔ Moving off goal clears nothing: `night_of_week` is when a player turns out, not what they
  // play. Only leaving the team clears it.
  const { error } = await admin
    .from("team_players")
    .update({
      jersey_number: jersey,
      position,
      ...(night === undefined ? {} : { night_of_week: night }),
    })
    .eq("id", id);
  if (error) return { ok: false, message: error.message };

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
      night_of_week: existing.night_of_week,
    },
    new_data: {
      jersey_number: jersey,
      position,
      name,
      ...(night === undefined ? {} : { night_of_week: night }),
    },
  });

  // The number and position show on the public team page and in the stats
  // tables, not only on this page.
  revalidatePath("/[league]/teams/[slug]", "page");
  revalidatePath("/[league]/stats", "page");
  return { ok: true, message: `Updated ${name ?? "the player"}.` };
}

// ⚠️ Not a league-scoped write: `players` has no `league_id`, so a rename reaches every league the
// person plays in, which is why `mayWritePlayer` checks containment, not membership.
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

  // The player comes from the roster row, never the form, which could name anyone in the instance.
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
  if (!league_id)
    return { ok: false, message: "That season no longer exists." };

  const { data: before } = await admin
    .from("players")
    .select("first_name, last_name")
    .eq("id", row.player_id)
    .maybeSingle();
  if (!before) return { ok: false, message: "That person no longer exists." };
  const wasName = `${before.first_name} ${before.last_name}`;

  if (!(await mayWritePlayer(manager.id, row.player_id))) {
    // ⛔ Refused out loud, naming the leagues and the League Office, which reaches every league
    // (0034): a bare "no" reads as a broken feature.
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
    // `leagueOfEntity` returns null for "player" by decision, so the league is passed or the entry
    // is hidden (`RUNBOOK.md` → Access control → Traps).
    entity_type: "player",
    entity_id: row.player_id,
    league_id,
    old_data: { first_name: before.first_name, last_name: before.last_name },
    new_data: { first_name: first, last_name: last, name: `${first} ${last}` },
  });

  // Route patterns, deliberately: a rename reaches every league, and a pattern invalidates them all.
  revalidatePath("/[league]/teams/[slug]", "page");
  revalidatePath("/[league]/stats", "page");
  revalidatePath("/[league]/players/[playerId]", "page");
  revalidatePath("/[league]", "layout");
  return { ok: true, message: `Renamed ${wasName} to ${first} ${last}.` };
}

// ⛔ One `player_league_archive` row, never a delete and never global. The league id comes straight
// from the client, so `leagueIdIfExists` resolves it before the guard.
export async function archivePlayer(
  playerId: string,
  leagueId: string,
): Promise<RosterActionState> {
  const admin = createAdminClient();
  const manager = await requireLeagueManager(() =>
    leagueIdIfExists(leagueId, admin),
  );

  const { data: person } = await admin
    .from("players")
    .select("first_name, last_name")
    .eq("id", playerId)
    .maybeSingle();
  if (!person) return { ok: false, message: "That person no longer exists." };
  const name = `${person.first_name} ${person.last_name}`;

  // ⛔ Nobody is archived while on any of this league's rosters, in any season: an archived player
  // with a Transfer button is the state this feature makes unreachable.
  const activeRosterTeams = async () => {
    const { data } = await admin
      .from("team_players")
      .select("teams!team_players_team_id_fkey(name), seasons!inner(league_id)")
      .eq("player_id", playerId)
      .is("left_on", null)
      .eq("seasons.league_id", leagueId);
    return [
      ...new Set(
        (data ?? []).flatMap((a) => (a.teams?.name ? [a.teams.name] : [])),
      ),
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

  // Upsert: archiving someone already archived (two managers at once) is not an error.
  const { error } = await admin
    .from("player_league_archive")
    .upsert(
      { player_id: playerId, league_id: leagueId, archived_by: manager.id },
      { onConflict: "player_id,league_id" },
    );
  if (error) return { ok: false, message: error.message };

  // ⚠️ Re-checked after the write, since `addRosterPlayer` may insert concurrently. This narrows the
  // race rather than closing it (that needs a trigger); the archive row goes either way.
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

  revalidatePath("/[league]/teams/[slug]", "page");
  revalidatePath("/[league]/people", "page");
  return { ok: true, message: `${name} was archived from this league.` };
}

/** Undo an archive, for this league only. The mirror of `archivePlayer`. */
export async function restorePlayer(
  playerId: string,
  leagueId: string,
): Promise<RosterActionState> {
  const admin = createAdminClient();
  const manager = await requireLeagueManager(() =>
    leagueIdIfExists(leagueId, admin),
  );

  const { data: person } = await admin
    .from("players")
    .select("first_name, last_name")
    .eq("id", playerId)
    .maybeSingle();
  const name = person
    ? `${person.first_name} ${person.last_name}`
    : "That player";

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

  revalidatePath("/[league]/teams/[slug]", "page");
  revalidatePath("/[league]/people", "page");
  return { ok: true, message: `${name} is available in this league again.` };
}
