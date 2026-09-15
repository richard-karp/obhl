// ⚠️ Anneals, not descends: one adjacent rematch refuses an order, so a descent never leaves
// the identity (worst team 8 against 4). `cost` steers the walk; `admissible` gates the record.
// ⚠️ `cost` stays a caller-weighted scalar: packing the ~17-entry rank vector overflows.

import { mulberry32 } from "./rng";

export type NightOrderScore = { cost: number; admissible: boolean };

export function improveNightOrder(
  nightCount: number,
  score: (order: number[]) => NightOrderScore,
  opts?: { seed?: number; restarts?: number; steps?: number },
): number[] {
  const identity = Array.from({ length: nightCount }, (_, i) => i);
  if (nightCount < 3) return identity;
  const { seed = 1, restarts = 4, steps = 1_500 } = opts ?? {};

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
