/**
 * Resolving a merge of same-name player records — or refusing it.
 *
 * A merge is not revertible: rows are summed and deleted. So the three refusals
 * below come first and cost nothing, and no resolution is computed for a merge
 * that will not happen.
 */

export type RosterRow = {
  id: string;
  playerId: string;
  seasonId: string;
  teamId: string;
  jerseyNumber: number | null;
  isCaptain: boolean;
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
  | { ok: true; rosterKeep: string[]; rosterDelete: string[]; games: GameResolution[] };

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
 * Which of two roster rows on one team and season to keep: a jersey beats none,
 * then captaincy, then the lowest id so the choice is stable across runs.
 */
function richer(a: RosterRow, b: RosterRow): RosterRow {
  const aJersey = a.jerseyNumber != null;
  const bJersey = b.jerseyNumber != null;
  if (aJersey !== bJersey) return aJersey ? a : b;
  if (a.isCaptain !== b.isCaptain) return a.isCaptain ? a : b;
  return a.id < b.id ? a : b;
}

/**
 * ⚠️ **Every row passed in must belong to the merge set** — that is, its
 * `playerId` must be `keepId` or one of the records being absorbed. This
 * function cannot check that for itself: it is told which record to keep, never
 * which ones are being merged, so it treats whatever it is handed as the whole
 * set.
 *
 * The natural way to load `games` gets this wrong. Fetching `game_rosters` by
 * `game_id` returns EVERY player dressed for that game, and passing that in
 * sums strangers' goals into the survivor and lists their roster rows in
 * `deleteIds`. Nothing here would report an error; the merge would simply
 * corrupt the other players' stat lines and delete their rows. Filter by
 * `player_id in (merge set)` at the call site, not by game.
 *
 * `rosters` carries the same requirement. `linkedPlayerIds` does too, but it
 * fails safe — an id from outside the set can only cause a spurious
 * `both-linked` refusal, never a bad write.
 */
export function planMerge(
  keepId: string,
  rosters: RosterRow[],
  games: GameRow[],
  linkedPlayerIds: readonly string[] = [],
): MergePlan {
  // 1. Two same-named records on both sides of one game is proof they are two
  // people. Summing them would carry goals across teams.
  for (const [gameId, rows] of groupBy(games, (r) => r.gameId)) {
    const teamIds = new Set(rows.map((r) => r.teamId));
    if (teamIds.size > 1) return { ok: false, reason: "opposing-teams", gameId };
  }

  // 2. `left_on` does not exist until Phase B, so a record active on two teams
  // in one season cannot be expressed as a departure — the operator removes one
  // roster row first. This refusal is also what keeps B1's unique index
  // creatable.
  for (const [, rows] of groupBy(rosters, (r) => r.seasonId)) {
    const teamIds = [...new Set(rows.map((r) => r.teamId))];
    if (teamIds.length > 1) {
      return { ok: false, reason: "different-active-teams", teamIds: teamIds.sort() };
    }
  }

  // 3. `profiles` has no unique index on `player_id`, so re-pointing two linked
  // records would leave two accounts controlling one player — and `is_captain_of`
  // joins `profiles` on `player_id`, so both would hold captain rights over that
  // team. The operator unlinks one account first.
  if (linkedPlayerIds.length > 1) {
    return { ok: false, reason: "both-linked", playerIds: [...linkedPlayerIds].sort() };
  }

  // One resolution per game, so two-way and N-way merges behave identically and
  // no two rows ever repoint onto the same (game_id, player_id).
  const resolutions: GameResolution[] = [];
  for (const [gameId, rows] of groupBy(games, (r) => r.gameId)) {
    const ordered = [...rows].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
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

  return { ok: true, rosterKeep: rosterKeep.sort(), rosterDelete: rosterDelete.sort(), games: resolutions };
}
