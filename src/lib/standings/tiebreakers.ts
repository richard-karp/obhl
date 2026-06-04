/**
 * Pure standings ordering. Aggregates (W/L/T/PTS/GF/GA) are computed in SQL
 * (v_standings_raw); the ordered table — including the head-to-head tiebreaker,
 * which depends on *which* teams are tied — is computed here.
 *
 * Order: points → wins → head-to-head (among the tied group only) → goal
 * differential → goals for → teamId (deterministic final fallback).
 */

export type RankableTeam = {
  teamId: string;
  points: number;
  wins: number;
  gd: number;
  gf: number;
};

export type HeadToHeadGame = {
  homeTeamId: string;
  awayTeamId: string;
  homeGoals: number;
  awayGoals: number;
};

/** Head-to-head points use a fixed 2/1/0 (win/tie/loss) record. */
function h2hPoints(gf: number, ga: number): number {
  if (gf > ga) return 2;
  if (gf === ga) return 1;
  return 0;
}

export function rankStandings<T extends RankableTeam>(
  rows: T[],
  games: HeadToHeadGame[],
): (T & { rank: number })[] {
  // 1. Primary sort: points, then wins.
  const byPointsWins = [...rows].sort(
    (a, b) => b.points - a.points || b.wins - a.wins,
  );

  // 2. Group teams that are still tied on (points, wins).
  const groups: T[][] = [];
  for (const row of byPointsWins) {
    const last = groups[groups.length - 1];
    if (last && last[0].points === row.points && last[0].wins === row.wins) {
      last.push(row);
    } else {
      groups.push([row]);
    }
  }

  // 3. Within each tied group, break ties by head-to-head among the group,
  //    then goal differential, then goals for, then teamId.
  const ordered: T[] = [];
  for (const group of groups) {
    if (group.length === 1) {
      ordered.push(group[0]);
      continue;
    }

    const ids = new Set(group.map((g) => g.teamId));
    const h2h = new Map<string, number>(group.map((g) => [g.teamId, 0]));
    for (const game of games) {
      if (ids.has(game.homeTeamId) && ids.has(game.awayTeamId)) {
        h2h.set(
          game.homeTeamId,
          h2h.get(game.homeTeamId)! + h2hPoints(game.homeGoals, game.awayGoals),
        );
        h2h.set(
          game.awayTeamId,
          h2h.get(game.awayTeamId)! + h2hPoints(game.awayGoals, game.homeGoals),
        );
      }
    }

    const sorted = [...group].sort(
      (a, b) =>
        h2h.get(b.teamId)! - h2h.get(a.teamId)! ||
        b.gd - a.gd ||
        b.gf - a.gf ||
        a.teamId.localeCompare(b.teamId),
    );
    ordered.push(...sorted);
  }

  return ordered.map((row, i) => ({ ...row, rank: i + 1 }));
}
