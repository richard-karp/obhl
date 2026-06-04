/**
 * Circle-method round-robin. Every team plays every other team `cycles` times.
 * Odd team counts get a dummy BYE team (that team sits out the round). Home/away
 * alternates by round parity and swaps on alternate cycles for rough balance.
 */

export type Pairing = { home: string; away: string; round: number };

export const BYE = "__BYE__";

export function roundRobin(teamIds: string[], cycles = 1): Pairing[] {
  const base = [...teamIds];
  if (base.length < 2) return [];
  if (base.length % 2 === 1) base.push(BYE);

  const n = base.length;
  const roundsPerCycle = n - 1;
  const half = n / 2;
  const pairings: Pairing[] = [];

  for (let cycle = 0; cycle < cycles; cycle++) {
    const rot = [...base];
    for (let r = 0; r < roundsPerCycle; r++) {
      const round = cycle * roundsPerCycle + r + 1;
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
  }

  return pairings;
}
