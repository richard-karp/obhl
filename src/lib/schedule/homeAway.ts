/**
 * Orientation — who is the home team in each game.
 *
 * The generator never needs this phase: `buildBalancedPairings` emits ordered
 * `Pairing`s and inherits the circle method's parity alternation, which is
 * already roughly even. Repairing a published season does need it, because Phase
 * M works in *unordered* pairs — re-pairing a night produces matchups with no
 * orientation at all, and choosing arbitrarily would walk a season's home/away
 * split off balance one repair at a time.
 *
 * The goal is one number per team: home games minus away games, as near zero as
 * the parity of its game count allows. Sum of squares rather than a spread, for
 * the same reason Phase S uses it — it keeps pulling once the worst team is
 * fixed, instead of letting everyone settle at the edge of an acceptable band.
 */

export type OrientableGame = {
  /** The two teams, in no particular order. */
  pair: [number, number];
  /** Already played (or otherwise untouchable): counts, but can't flip. */
  locked: boolean;
  /**
   * The orientation this game currently has. Required for locked games, since
   * that orientation is a fact rather than a choice. On free games it's the
   * churn tiebreaker: an unchanged game keeps it unless flipping helps.
   */
  current?: [number, number];
};

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

/** Σ (home − away)² across teams — the quantity `assignHomeAway` minimises. */
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

/**
 * `[home, away]` per game, aligned with the input.
 *
 * Iterated local search, same shape as Phase S. A plain descent isn't enough:
 * two teams sitting at +2 and −2 with no game between them are only reconciled
 * through a third team, and the first flip of that path is cost-neutral, so
 * strict descent won't take it. Kicking off the incumbent and re-descending
 * finds those paths.
 */
export function assignHomeAway(opts: {
  teamCount: number;
  games: OrientableGame[];
  seed?: number;
  restarts?: number;
}): [number, number][] {
  const { teamCount: T, games, seed = 1, restarts = 40 } = opts;
  const rnd = mulberry32(seed);

  // Seed from the current orientation where there is one, so a game nobody
  // needed to touch starts out unmoved.
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

  /** Change in Σ diff² from flipping game `i`. Negative is an improvement. */
  const gain = (i: number): number => {
    const [h, a] = out[i];
    return (diff[h] - 2) ** 2 + (diff[a] + 2) ** 2 - diff[h] ** 2 - diff[a] ** 2;
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

  // The theoretical floor: a team with an odd game count can never reach zero,
  // so there's no point kicking once every team is as even as its parity allows.
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
