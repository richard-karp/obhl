export type Pairing = { home: string; away: string; round: number };

export const BYE = "__BYE__";

/** The first `numRounds` rounds of the repeating circle method; `round` is global and 1-based. */
export function roundRobinRounds(
  teamIds: string[],
  numRounds: number,
): Pairing[] {
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
    rot.splice(1, 0, rot.pop()!);
  }

  return pairings;
}

/** Every team plays at least `gamesPerTeam`: exactly in an even league, while an odd league
 *  leaves a few teams one game over. */
export function buildBalancedPairings(
  teamIds: string[],
  gamesPerTeam: number,
): Pairing[] {
  if (teamIds.length < 2 || gamesPerTeam < 1) return [];

  if (teamIds.length % 2 === 0) return roundRobinRounds(teamIds, gamesPerTeam);

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
