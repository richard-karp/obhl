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
  /**
   * `team_players.left_on` — the date the record left this team, or null while
   * still on it (`0036`).
   *
   * Required rather than optional on purpose. An optional field defaulting to
   * null would read every departed row as active, which turns the refusal below
   * back into the over-broad one it replaced and lets `richer` keep a departed
   * row over the active one beside it. A caller that has not thought about
   * departures should not compile.
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
 * Which of two roster rows on one team and season to keep: still on the team
 * beats departed, then a jersey beats none, then captaincy, then the lowest id
 * so the choice is stable across runs.
 *
 * Active comes first and outranks everything. The two rows describe the same
 * team in the same season, so keeping the departed one would file the merged
 * player as gone from a team they are currently on — and every read that asks
 * "who is on this team now" would then be right to leave them out.
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
 *
 * `keepArchived` says whether the SURVIVOR is archived out of the league this
 * merge is running in (0040). Passed in rather than looked up for the same
 * reason `linkedPlayerIds` is: this function stays pure and the league is the
 * caller's fact, not this function's. Defaulting it to `false` keeps every
 * existing call honest — a caller that does not know is asserting nothing.
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

  // 2. Two records CURRENTLY on different teams in one season cannot become one
  // player: `team_players_one_active_team` (0036) is a unique index on
  // (season_id, player_id) where left_on is null, so repointing both at keepId
  // raises 23505 partway through a merge that has already deleted rows. The
  // operator removes or transfers one first.
  //
  // Departed rows are excluded, and that exclusion is the whole reason this
  // filter exists. A player who moved from one team to another mid-season has
  // exactly this shape — one season, two teams — and refusing it would make
  // every transferred player permanently unmergeable, which is the opposite of
  // what the check is for. Only the active rows can collide.
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

  // 3. `profiles` has no unique index on `player_id`, so re-pointing two linked
  // records would leave two accounts controlling one player — and `is_captain_of`
  // joins `profiles` on `player_id`, so both would hold captain rights over that
  // team. The operator unlinks one account first.
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

  // 4. An archived survivor may not come out of this holding an active roster
  // row. `archivePlayer` refuses to archive anyone still rostered, and 0040's
  // header calls that an invariant — but a merge reaches the same end from the
  // other side: archive P out of this league while every row P has here is
  // departed (allowed), then merge an actively-rostered duplicate INTO P. The
  // repoint below moves that active row onto P and the league now has an
  // archived player on a team, hidden from every picker that filters the
  // archive and still holding a working Transfer button.
  //
  // ⛔ THIS IS A THIRD WRITER TO THAT INVARIANT, NOT A SECOND. `archivePlayer`
  // guards its own direction and `addRosterPlayer` guards the other; neither
  // sees a merge. Anything else that repoints `team_players.player_id` has to
  // answer this question too.
  //
  // Read off the SURVIVORS rather than off `rosters`, so it stays exact if
  // `richer` ever stops preferring active rows. Today it does prefer them, so
  // the two readings agree and this is the one that cannot drift.
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
