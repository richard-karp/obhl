/**
 * Circle-method round-robin. Every team plays every other team `cycles` times.
 * Odd team counts get a dummy BYE team (that team sits out the round). Home/away
 * alternates by round parity and swaps on alternate cycles for rough balance.
 *
 * The primitive is `roundRobinRounds` — the first N rounds of the *repeating*
 * circle method. One round gives each team exactly one game (even counts), so
 * `numRounds` == games per team for even leagues. `roundRobin` and
 * `buildBalancedPairings` are thin wrappers over it.
 */

export type Pairing = { home: string; away: string; round: number };

export const BYE = "__BYE__";

/**
 * Pairings for the first `numRounds` rounds of the repeating circle method.
 * Cycles repeat (with home/away swapped on odd cycles), so a pair's repeat
 * meetings land a whole cycle apart — good temporal spread. The `round` field
 * is the global 1-based round index.
 */
export function roundRobinRounds(teamIds: string[], numRounds: number): Pairing[] {
  const base = [...teamIds];
  if (base.length < 2 || numRounds < 1) return [];
  if (base.length % 2 === 1) base.push(BYE);

  const n = base.length;
  const roundsPerCycle = n - 1;
  const half = n / 2;
  const pairings: Pairing[] = [];

  let rot = [...base];
  for (let round = 1; round <= numRounds; round++) {
    const r = (round - 1) % roundsPerCycle; // index within the current cycle
    const cycle = Math.floor((round - 1) / roundsPerCycle);
    if (r === 0) rot = [...base]; // fresh rotation at the start of each cycle

    for (let i = 0; i < half; i++) {
      const a = rot[i];
      const b = rot[n - 1 - i];
      if (a === BYE || b === BYE) continue;

      let home: string;
      let away: string;
      if (i === 0) {
        [home, away] = r % 2 === 0 ? [a, b] : [b, a];
      } else {
        [home, away] = r % 2 === 0 ? [b, a] : [a, b];
      }
      if (cycle % 2 === 1) [home, away] = [away, home];
      pairings.push({ home, away, round });
    }
    // Rotate clockwise, keeping index 0 fixed.
    rot.splice(1, 0, rot.pop()!);
  }

  return pairings;
}

export function roundRobin(teamIds: string[], cycles = 1): Pairing[] {
  const effective = teamIds.length + (teamIds.length % 2); // + dummy BYE if odd
  if (effective < 2) return [];
  return roundRobinRounds(teamIds, cycles * (effective - 1));
}

/**
 * A balanced set of pairings where every team plays (at least) `gamesPerTeam`
 * games, opponents as equal as possible. Even leagues hit the target exactly;
 * odd leagues can't always divide evenly (parity), so a few teams land one game
 * over — never under.
 */
export function buildBalancedPairings(
  teamIds: string[],
  gamesPerTeam: number,
): Pairing[] {
  if (teamIds.length < 2 || gamesPerTeam < 1) return [];

  // Even leagues: one round == one game per team, so numRounds == gamesPerTeam.
  if (teamIds.length % 2 === 0) return roundRobinRounds(teamIds, gamesPerTeam);

  // Odd leagues: each round one team byes, so a team needs more rounds than
  // games. Generate a generous stream once, then take the shortest whole-round
  // prefix where every team has reached the target (a few land one game over).
  const n = teamIds.length;
  const guardRounds = Math.ceil((gamesPerTeam * n) / (n - 1)) + 2;
  const all = roundRobinRounds(teamIds, guardRounds);
  const gp = new Map<string, number>(teamIds.map((t) => [t, 0]));
  const out: Pairing[] = [];
  let i = 0;
  while (i < all.length) {
    const round = all[i].round;
    while (i < all.length && all[i].round === round) {
      out.push(all[i]);
      gp.set(all[i].home, gp.get(all[i].home)! + 1);
      gp.set(all[i].away, gp.get(all[i].away)! + 1);
      i++;
    }
    if (Math.min(...teamIds.map((t) => gp.get(t)!)) >= gamesPerTeam) break;
  }
  return out;
}
