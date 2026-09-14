/** A merge is not revertible (rows are summed and deleted), so the refusals come first. */

export type RosterRow = {
  id: string;
  playerId: string;
  seasonId: string;
  teamId: string;
  jerseyNumber: number | null;
  isCaptain: boolean;
  /**
   * Required, not optional: defaulting to null reads every departed row as active, over-broadens
   * the refusal below and lets `richer` keep a departed row over the active one.
   */
  leftOn: string | null;
};

export type GameRow = {
  id: string;
  gameId: string;
  teamId: string;
  playerId: string;
  goals: number;
  assists: number;
  pim: number;
};

/** One game's outcome: a surviving roster row holding the summed totals. */
export type GameResolution = {
  gameId: string;
  survivorId: string;
  deleteIds: string[];
  goals: number;
  assists: number;
  pim: number;
  /** survivor.player_id must be rewritten to keepId. */
  repoint: boolean;
};

export type MergePlan =
  | { ok: false; reason: "opposing-teams"; gameId: string }
  | { ok: false; reason: "different-active-teams"; teamIds: string[] }
  | { ok: false; reason: "both-linked"; playerIds: string[] }
  | { ok: false; reason: "keep-archived"; teamIds: string[] }
  | {
      ok: true;
      rosterKeep: string[];
      rosterDelete: string[];
      games: GameResolution[];
    };

function groupBy<T>(rows: T[], key: (r: T) => string): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const r of rows) {
    const k = key(r);
    const bucket = out.get(k);
    if (bucket) bucket.push(r);
    else out.set(k, [r]);
  }
  return out;
}

/**
 * Active beats departed first (keeping a departed row files the player as gone from their own
 * team), then a jersey, then captaincy, then the lowest id for a stable choice.
 */
function richer(a: RosterRow, b: RosterRow): RosterRow {
  const aActive = a.leftOn == null;
  const bActive = b.leftOn == null;
  if (aActive !== bActive) return aActive ? a : b;
  const aJersey = a.jerseyNumber != null;
  const bJersey = b.jerseyNumber != null;
  if (aJersey !== bJersey) return aJersey ? a : b;
  if (a.isCaptain !== b.isCaptain) return a.isCaptain ? a : b;
  return a.id < b.id ? a : b;
}

/**
 * ⚠️ Every row in `rosters` and `games` must belong to the merge set: load by `player_id in (set)`,
 * never by game, or strangers' goals are summed into the survivor and their rows deleted.
 */
export function planMerge(
  keepId: string,
  rosters: RosterRow[],
  games: GameRow[],
  linkedPlayerIds: readonly string[] = [],
  keepArchived = false,
): MergePlan {
  // 1. Two same-named records on both sides of one game is proof they are two
  // people. Summing them would carry goals across teams.
  for (const [gameId, rows] of groupBy(games, (r) => r.gameId)) {
    const teamIds = new Set(rows.map((r) => r.teamId));
    if (teamIds.size > 1)
      return { ok: false, reason: "opposing-teams", gameId };
  }

  // 2. Records ACTIVE on different teams in one season hit `team_players_one_active_team` (0036)
  // mid-merge, after rows are deleted. Departed rows are excluded, or transfers are unmergeable.
  const active = rosters.filter((r) => r.leftOn == null);
  for (const [, rows] of groupBy(active, (r) => r.seasonId)) {
    const teamIds = [...new Set(rows.map((r) => r.teamId))];
    if (teamIds.length > 1) {
      return {
        ok: false,
        reason: "different-active-teams",
        teamIds: teamIds.sort(),
      };
    }
  }

  // 3. `profiles.player_id` is not unique, so re-pointing two linked records gives two accounts
  // one player, and both captain rights through `is_captain_of`.
  if (linkedPlayerIds.length > 1) {
    return {
      ok: false,
      reason: "both-linked",
      playerIds: [...linkedPlayerIds].sort(),
    };
  }

  // One resolution per game, so two-way and N-way merges behave identically and
  // no two rows ever repoint onto the same (game_id, player_id).
  const resolutions: GameResolution[] = [];
  for (const [gameId, rows] of groupBy(games, (r) => r.gameId)) {
    const ordered = [...rows].sort((a, b) =>
      a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
    );
    const survivor = ordered.find((r) => r.playerId === keepId) ?? ordered[0];
    resolutions.push({
      gameId,
      survivorId: survivor.id,
      deleteIds: ordered.filter((r) => r.id !== survivor.id).map((r) => r.id),
      goals: ordered.reduce((n, r) => n + r.goals, 0),
      assists: ordered.reduce((n, r) => n + r.assists, 0),
      pim: ordered.reduce((n, r) => n + r.pim, 0),
      repoint: survivor.playerId !== keepId,
    });
  }
  resolutions.sort((a, b) => a.gameId.localeCompare(b.gameId));

  // One surviving roster row per team and season; the rest are absorbed. Every
  // survivor still has to be repointed at keepId, including a lone row.
  const rosterKeep: string[] = [];
  const rosterDelete: string[] = [];
  for (const [, rows] of groupBy(rosters, (r) => `${r.seasonId}|${r.teamId}`)) {
    const winner = rows.reduce(richer);
    rosterKeep.push(winner.id);
    for (const r of rows) if (r.id !== winner.id) rosterDelete.push(r.id);
  }

  // 4. ⛔ A third writer to 0040's invariant: a merge can move an active row onto an archived
  // survivor, which neither `archivePlayer` nor `addRosterPlayer` sees. Read off the survivors.
  const kept = new Set(rosterKeep);
  const strandedTeams = [
    ...new Set(
      rosters
        .filter((r) => kept.has(r.id) && r.leftOn == null)
        .map((r) => r.teamId),
    ),
  ];
  if (keepArchived && strandedTeams.length) {
    return {
      ok: false,
      reason: "keep-archived",
      teamIds: strandedTeams.sort(),
    };
  }

  return {
    ok: true,
    rosterKeep: rosterKeep.sort(),
    rosterDelete: rosterDelete.sort(),
    games: resolutions,
  };
}
