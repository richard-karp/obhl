/**
 * Spread a player's *season* totals (the only thing esportsdesk publishes) into
 * plausible per-game box scores, because OBHL derives all stats from per-game
 * `game_rosters` counters — there is no season-totals table.
 *
 * Guarantees, given enough games:
 *  - every player's G / A / PIM and GP come out exactly equal to their season
 *    line (the leaderboard must match esportsdesk);
 *  - a player only records stats in games they "dressed" for (their GP games);
 *  - no game shows more skater goals than the team actually scored (goals fill
 *    each game's real capacity = the team's goals that game), so synthetic box
 *    scores never contradict the final score.
 *
 * Pure + deterministic (no Supabase, no Date/Math.random) so it unit-tests
 * without a database. Game order is the caller's (chronological); `cap` is the
 * team's goals in that game.
 */

export type DistPlayer = { gp: number; g: number; a: number; pim: number };
export type DistGame = { cap: number };
export type GameStat = { goals: number; assists: number; pim: number };
/** Per player: gameIndex → counters, one entry per appearance (GP) game. */
export type PlayerDist = Map<number, GameStat>;

export function distributeStats(
  games: DistGame[],
  players: DistPlayer[],
): PlayerDist[] {
  const n = games.length;
  if (n === 0) return players.map(() => new Map());

  const goalCap = games.map((x) => x.cap);
  const assistCap = games.map((x) => 2 * x.cap); // ≤2 assists per goal
  const rosterCount = new Array(n).fill(0);

  // 1. Appearances: give each player GP games, load-balanced so rosters spread
  //    across the season instead of piling onto the same nights.
  const appearances = players.map((p) => {
    const gp = Math.min(Math.max(p.gp, 0), n);
    const order = [...Array(n).keys()].sort(
      (a, b) => rosterCount[a] - rosterCount[b] || a - b,
    );
    const chosen = order.slice(0, gp);
    chosen.forEach((gi) => rosterCount[gi]++);
    return chosen;
  });

  const result: PlayerDist[] = players.map(() => new Map<number, GameStat>());
  const bump = (pi: number, gi: number, field: keyof GameStat, by: number) => {
    const cur = result[pi].get(gi) ?? { goals: 0, assists: 0, pim: 0 };
    cur[field] += by;
    result[pi].set(gi, cur);
  };

  // 2. Goals then assists: biggest scorers first, into their highest-capacity
  //    appearance games, decrementing capacity. Any residual (capacity ran out)
  //    is forced into a game so the season total still reconciles exactly.
  const fill = (cap: number[], key: "g" | "a", field: keyof GameStat) => {
    const order = [...players.keys()].sort((a, b) => players[b][key] - players[a][key]);
    for (const pi of order) {
      let need = players[pi][key];
      if (need <= 0) continue;
      const apps = [...appearances[pi]].sort((a, b) => cap[b] - cap[a]);
      for (const gi of apps) {
        if (need <= 0) break;
        const take = Math.min(need, cap[gi]);
        if (take > 0) {
          bump(pi, gi, field, take);
          cap[gi] -= take;
          need -= take;
        }
      }
      if (need > 0 && apps.length) {
        bump(pi, apps[0], field, need);
        cap[apps[0]] -= need;
      }
    }
  };
  fill(goalCap, "g", "goals");
  fill(assistCap, "a", "assists");

  // 3. PIM: no per-game cap; round-robin across the player's appearances.
  players.forEach((p, pi) => {
    let need = p.pim;
    const apps = appearances[pi];
    let k = 0;
    while (need > 0 && apps.length) {
      bump(pi, apps[k % apps.length], "pim", 1);
      need--;
      k++;
    }
  });

  // 4. Every appearance is a roster row even with no points (dressed, GP counts).
  appearances.forEach((apps, pi) => {
    apps.forEach((gi) => {
      if (!result[pi].has(gi)) result[pi].set(gi, { goals: 0, assists: 0, pim: 0 });
    });
  });

  return result;
}
