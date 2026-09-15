// Home/away for repair, whose Phase M pairs are unordered: choosing arbitrarily would walk a
// season's split off balance one repair at a time.

import { mulberry32 } from "./rng";

export type OrientableGame = {
  pair: [number, number];
  /** Already played (or otherwise untouchable): counts, but can't flip. */
  locked: boolean;
  /** Required when locked (a fact); on a free game, the churn tiebreaker. */
  current?: [number, number];
};

export function homeAwaySpread(
  teamCount: number,
  games: [number, number][],
): number {
  const diff = new Array<number>(teamCount).fill(0);
  for (const [h, a] of games) {
    diff[h]++;
    diff[a]--;
  }
  return diff.reduce((s, d) => s + d * d, 0);
}

/** `[home, away]` per game, aligned with the input. Iterated local search: reconciling +2 and
 *  −2 goes through a third team, and that path's first flip is cost-neutral. */
export function assignHomeAway(opts: {
  teamCount: number;
  games: OrientableGame[];
  seed?: number;
  restarts?: number;
}): [number, number][] {
  const { teamCount: T, games, seed = 1, restarts = 40 } = opts;
  const rnd = mulberry32(seed);

  const out: [number, number][] = games.map((g) => {
    const [a, b] = g.pair;
    const cur = g.current;
    const home = cur && (cur[0] === a || cur[0] === b) ? cur[0] : a;
    return home === a ? [a, b] : [b, a];
  });

  const diff = new Array<number>(T).fill(0);
  for (const [h, a] of out) {
    diff[h]++;
    diff[a]--;
  }

  const free = games.map((g, i) => (g.locked ? -1 : i)).filter((i) => i >= 0);
  if (free.length === 0) return out;

  const flip = (i: number) => {
    const [h, a] = out[i];
    diff[h] -= 2;
    diff[a] += 2;
    out[i] = [a, h];
  };

  const gain = (i: number): number => {
    const [h, a] = out[i];
    return (
      (diff[h] - 2) ** 2 + (diff[a] + 2) ** 2 - diff[h] ** 2 - diff[a] ** 2
    );
  };

  const total = () => diff.reduce((s, d) => s + d * d, 0);

  const descend = () => {
    for (;;) {
      let bestIdx = -1;
      let bestGain = 0; // strict — a zero-gain flip is churn for nothing
      for (const i of free) {
        const g = gain(i);
        if (g < bestGain) {
          bestGain = g;
          bestIdx = i;
        }
      }
      if (bestIdx < 0) return;
      flip(bestIdx);
    }
  };

  const snapshot = () => out.map((p) => [...p] as [number, number]);
  const restore = (snap: [number, number][]) => {
    for (let i = 0; i < out.length; i++) out[i] = [...snap[i]];
    diff.fill(0);
    for (const [h, a] of out) {
      diff[h]++;
      diff[a]--;
    }
  };

  descend();
  let bestSnap = snapshot();
  let bestTotal = total();

  const gameCount = new Array<number>(T).fill(0);
  for (const g of games) {
    gameCount[g.pair[0]]++;
    gameCount[g.pair[1]]++;
  }
  const floor = gameCount.reduce((s, n) => s + (n % 2), 0);

  for (let r = 0; r < Math.max(0, restarts) && bestTotal > floor; r++) {
    restore(bestSnap);
    const kicks = 1 + Math.floor(rnd() * 3);
    for (let k = 0; k < kicks; k++) {
      flip(free[Math.floor(rnd() * free.length)]);
    }
    descend();
    const t = total();
    if (t < bestTotal) {
      bestTotal = t;
      bestSnap = snapshot();
    }
  }

  restore(bestSnap);
  return out;
}
