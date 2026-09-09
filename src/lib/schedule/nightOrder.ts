/**
 * Reorder a finished season's nights.
 *
 * Permuting nights carries each night's games AND their ice times together, so
 * games per team, meetings per pair, home/away and every team's ice-time share
 * are invariant. Only the temporal metrics move — clustering, back-to-backs,
 * three-game runs, rematch spacing, and (on a multi-weekday or bye-carrying
 * league) byes and the weekday split. That is why the caller judges
 * admissibility on the WHOLE rank vector rather than on clustering alone: the
 * pass is then safe on shapes where reordering would cost something, because it
 * simply declines and the identity survives.
 *
 * The search anneals rather than descends, and the two halves of `score` are
 * why. A pure descent cannot help here: the admissible region is narrow — one
 * adjacent rematch is enough to refuse an order — so a hill climb that rejects
 * every inadmissible step never leaves the identity. Annealing on `cost` lets
 * the walk cross inadmissible ground, while `admissible` gates what may be
 * *recorded*. Measured 2026-09-09 on the 23-Tuesday reference: descent reached a
 * worst team of 8, annealing through the infeasible region reached 4.
 *
 * `cost` is a scalar because the acceptance test needs one. An earlier draft had
 * `score` return the rank vector and packed it into a scalar here; that is not
 * implementable — the vector runs ~17 entries and `pairingWeekdayExcess` is a
 * float, so any positional packing overflows `Number.MAX_SAFE_INTEGER` and
 * saturates to a constant, turning the anneal into a random walk. The caller
 * owns the weighting because only the caller knows the baseline.
 */

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export type NightOrderScore = { cost: number; admissible: boolean };

export function improveNightOrder(
  nightCount: number,
  score: (order: number[]) => NightOrderScore,
  opts?: { seed?: number; restarts?: number; steps?: number },
): number[] {
  const identity = Array.from({ length: nightCount }, (_, i) => i);
  if (nightCount < 3) return identity;
  const { seed = 1, restarts = 4, steps = 6_000 } = opts ?? {};

  const baseline = score(identity);
  let best = identity;
  let bestCost = baseline.admissible ? baseline.cost : Infinity;

  for (let r = 0; r < restarts; r++) {
    const rnd = mulberry32(seed + r * 7919);
    const order = [...identity];
    if (r > 0) {
      for (let i = nightCount - 1; i > 0; i--) {
        const j = Math.floor(rnd() * (i + 1));
        [order[i], order[j]] = [order[j], order[i]];
      }
    }
    let cur = score(order).cost;
    for (let step = 0; step < steps; step++) {
      const temp = 40 * Math.exp((-step / steps) * 7);
      const i = Math.floor(rnd() * nightCount);
      let j = Math.floor(rnd() * nightCount);
      if (i === j) j = (j + 1) % nightCount;
      [order[i], order[j]] = [order[j], order[i]];
      const c = score(order);
      if (c.cost <= cur || rnd() < Math.exp((cur - c.cost) / Math.max(0.001, temp))) {
        cur = c.cost;
        if (c.admissible && c.cost < bestCost) {
          bestCost = c.cost;
          best = [...order];
        }
      } else {
        [order[i], order[j]] = [order[j], order[i]];
      }
    }
  }
  return best;
}
