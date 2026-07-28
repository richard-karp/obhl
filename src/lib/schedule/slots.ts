/**
 * Phase S — hand out ice times (#4). Participation and matchups are already
 * fixed, so every team's list of game nights is frozen; all that's left is which
 * slot each night's games take. That makes this cleanly separable: a night's
 * games just permute among that night's slots, and the only things affected are
 * the six-or-so teams playing that night.
 *
 * Two goals, both per team: an even share of each ice time, and not being stuck
 * in the same slot on back-to-back games.
 */

import { SPACING_W } from "./spacing";

/** Even-share pull, as a sum-of-squares gradient toward a flat share. Sized so
 * one step of imbalance outweighs a few back-to-back repeats: an even split of
 * the good and bad ice times is the more visible fairness property. */
const SHARE_W = 20;

export type SlotOptions = {
  teamCount: number;
  /** Per night, the team pairs playing (from Phase M). */
  pairsByNight: [number, number][][];
  /** Ice slots available each night. */
  slotsPerNight: number[];
  seed?: number;
  restarts?: number;
  /** Wall-clock cap on the whole search. */
  timeBudgetMs?: number;
  /**
   * `initial[night][gameIndex]` — start from these slots rather than the default
   * packing. Repairing a published season starts from the slots it already has,
   * so unchanged nights stay put unless moving them helps.
   */
  initial?: number[][];
  /**
   * Nights the search may not touch (already played, or otherwise off limits).
   * Their slots still count toward every team's share — they're fixed history
   * the free nights have to even out against.
   */
  frozen?: boolean[];
  /**
   * `pinned[night]` — game indexes within that night that must keep the slot
   * `initial` gave them while the night's other games permute around them. Used
   * to hold a labelled game on the feature ice time.
   */
  pinned?: (number[] | undefined)[];
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

/**
 * Returns `slotOfGame[night][gameIndex]` — the slot each of a night's games
 * takes, aligned with `pairsByNight`. Games pack into the night's first `k`
 * slots (leaving a hole mid-evening isn't a real option for a rink), so the
 * search is over which game takes which of those, and the move is swapping two
 * games on the same night.
 *
 * Mid-season repair uses the same search with part of the season held still
 * (`initial`, `frozen`, `pinned`). That works because `teamCost` scores a team's
 * slots over the *whole* season: frozen nights become fixed history, and the
 * free nights are what even the season-long share back out.
 */
export function assignSlots(opts: SlotOptions): number[][] {
  const {
    teamCount: T,
    pairsByNight,
    slotsPerNight,
    seed = 1,
    restarts = 60,
    timeBudgetMs = 400,
    initial,
    frozen,
    pinned,
  } = opts;
  const N = pairsByNight.length;
  if (N === 0) return [];
  const numSlots = Math.max(1, ...slotsPerNight);
  const rnd = mulberry32(seed);
  const deadline = Date.now() + timeBudgetMs;

  // Each team's game nights are fixed by the earlier phases, so index its games
  // once: `slotSeq[t]` is that team's slots in chronological order, which is all
  // the cost function needs.
  const nightsOf: number[][] = Array.from({ length: T }, () => []);
  for (let n = 0; n < N; n++) {
    for (const [a, b] of pairsByNight[n]) {
      nightsOf[a].push(n);
      nightsOf[b].push(n);
    }
  }
  const posOf: Map<number, number>[] = nightsOf.map(
    (list) => new Map(list.map((n, i) => [n, i])),
  );
  const slotSeq: number[][] = nightsOf.map((list) => new Array(list.length).fill(0));

  // The state: which slot each of a night's games holds. Games use the night's
  // first k slots, so this is always a permutation of 0..k-1.
  // A night's slots are always a permutation of 0..k-1; anything else would put
  // two games on one sheet of ice and leave a hole where a caller expects a
  // game. Fall back to the default packing rather than propagate it.
  const isPermutation = (a: number[] | undefined, k: number): boolean => {
    if (!a || a.length !== k) return false;
    const seen = new Array<boolean>(k).fill(false);
    for (const v of a) {
      if (!Number.isInteger(v) || v < 0 || v >= k || seen[v]) return false;
      seen[v] = true;
    }
    return true;
  };
  const slotOf: number[][] = pairsByNight.map((pairs, n) =>
    isPermutation(initial?.[n], pairs.length)
      ? [...initial![n]]
      : pairs.map((_, gi) => gi),
  );

  /** A game the search must leave alone: on a frozen night, or explicitly pinned. */
  const isPinned = (n: number, gi: number): boolean =>
    !!frozen?.[n] || !!pinned?.[n]?.includes(gi);

  const syncNight = (n: number) => {
    pairsByNight[n].forEach(([a, b], gi) => {
      slotSeq[a][posOf[a].get(n)!] = slotOf[n][gi];
      slotSeq[b][posOf[b].get(n)!] = slotOf[n][gi];
    });
  };
  for (let n = 0; n < N; n++) syncNight(n);

  const teamCost = (t: number): number => {
    const seq = slotSeq[t];
    if (seq.length === 0) return 0;
    const counts = new Array(numSlots).fill(0);
    let consec = 0;
    for (let i = 0; i < seq.length; i++) {
      counts[seq[i]]++;
      if (i > 0 && seq[i] === seq[i - 1]) consec += SPACING_W.slotConsecutive;
    }
    const spread = Math.max(...counts) - Math.min(...counts);
    let sq = 0;
    for (const c of counts) sq += c * c;
    return consec + SPACING_W.slotSpread * Math.max(0, spread - 1) + SHARE_W * sq;
  };

  /** Cost over just the teams a swap on night `n` can touch. */
  const costOfPair = (p: [number, number], q: [number, number]) => {
    const ts = new Set<number>([p[0], p[1], q[0], q[1]]);
    let c = 0;
    for (const t of ts) c += teamCost(t);
    return c;
  };

  const swapGames = (n: number, i: number, j: number) => {
    const tmp = slotOf[n][i];
    slotOf[n][i] = slotOf[n][j];
    slotOf[n][j] = tmp;
    const [a, b] = pairsByNight[n][i];
    const [c, d] = pairsByNight[n][j];
    slotSeq[a][posOf[a].get(n)!] = slotOf[n][i];
    slotSeq[b][posOf[b].get(n)!] = slotOf[n][i];
    slotSeq[c][posOf[c].get(n)!] = slotOf[n][j];
    slotSeq[d][posOf[d].get(n)!] = slotOf[n][j];
  };

  const totalCost = () => {
    let c = 0;
    for (let t = 0; t < T; t++) c += teamCost(t);
    return c;
  };

  /** Descend on swaps of two games' slots within a night, to a local optimum. */
  const descend = () => {
    let improved = true;
    let pass = 0;
    while (improved && pass++ < 40) {
      improved = false;
      if (Date.now() > deadline) return;
      for (let n = 0; n < N; n++) {
        if (frozen?.[n]) continue;
        const k = pairsByNight[n].length;
        for (let i = 0; i < k; i++) {
          if (isPinned(n, i)) continue;
          for (let j = i + 1; j < k; j++) {
            if (isPinned(n, j)) continue;
            const before = costOfPair(pairsByNight[n][i], pairsByNight[n][j]);
            swapGames(n, i, j);
            const after = costOfPair(pairsByNight[n][i], pairsByNight[n][j]);
            if (after < before - 1e-9) improved = true;
            else swapGames(n, i, j);
          }
        }
      }
    }
  };

  const snapshot = () => slotOf.map((row) => [...row]);
  const restoreFrom = (snap: number[][]) => {
    for (let n = 0; n < N; n++) {
      for (let gi = 0; gi < snap[n].length; gi++) slotOf[n][gi] = snap[n][gi];
      syncNight(n);
    }
  };

  // Iterated local search: descend, then kick a few nights off the incumbent
  // rather than restarting cold — the descent is cheap but its basins are wide.
  descend();
  let bestSnap = snapshot();
  let bestTotal = totalCost();
  for (let r = 0; r < Math.max(0, restarts) && Date.now() < deadline; r++) {
    restoreFrom(bestSnap);
    const kicks = 1 + Math.floor(rnd() * 4);
    for (let k = 0; k < kicks; k++) {
      const n = Math.floor(rnd() * N);
      if (frozen?.[n]) continue;
      const g = pairsByNight[n].length;
      if (g < 2) continue;
      const i = Math.floor(rnd() * g);
      const j = Math.floor(rnd() * g);
      if (i !== j && !isPinned(n, i) && !isPinned(n, j)) swapGames(n, i, j);
    }
    descend();
    const total = totalCost();
    if (total < bestTotal) {
      bestTotal = total;
      bestSnap = snapshot();
    }
  }
  restoreFrom(bestSnap);
  return bestSnap;
}
