// Phase S: which ice time. Weights and candidates: RUNBOOK.md, _Schedule generator_.

import {
  SPACING_W,
  SLOT_BIAS_W,
  biasSign,
  proportionalSplit,
  type SlotBias,
} from "./spacing";
import { mulberry32 } from "./rng";

// ⚠️ 60, not 20: breaking a three-game run must cancel across weekdays (6-7-5 against 6-5-7),
// and at 20 the search dented the season share instead (spread 2).
const SHARE_W = 60;

const WEEKDAY_SHARE_W = 30;

// ⚠️ Must clear 120 (2 teams × 2 × `WEEKDAY_SHARE_W`) and stay under 240. Don't tune it on one
// fixture: change `SLOT_CANDIDATES` in `assignNights.ts`, where 160 must stay.
const STREAK3_W_DEFAULT = 160;

// ⚠️ Kept to an ordinary repeat's worth: at 20 it outbids the share and the reference season
// ends with 2 three-game runs; at 6, none.
const SEED_ROTATE_W = 6;

export type SlotOptions = {
  teamCount: number;
  pairsByNight: [number, number][][];
  slotsPerNight: number[];
  /** Dense indexes or raw 0=Sun..6=Sat both work; omitted, the search is weekday-blind. */
  weekdayOfNight?: number[];
  seed?: number;
  restarts?: number;
  timeBudgetMs?: number;
  streak3W?: number;
  /** `initial[night][gameIndex]`. ⚠️ An undefined night is seeded like any other, unlike a
   *  supplied identity packing: generation passes only its `slot_on` nights. */
  initial?: (number[] | undefined)[];
  /** Nights the search may not touch; their slots still count toward every team's share. */
  frozen?: boolean[];
  /** `pinned[night]`: games that keep `initial`'s slot while the night's others permute. */
  pinned?: (number[] | undefined)[];
  /** `slot_bias` requests. ⚠️ The same list must reach `iceOutcome`, or the best-of-five
   *  choice ignores it. RUNBOOK.md, _Schedule generator_. */
  biases?: SlotBias[];
};

/** Cheapest one-game-per-slot packing: exact up to 6 games, greedy beyond (it only seeds).
 *  ⚠️ No branch-and-bound: costs can be negative. Ties keep the first, for determinism. */
function bestAssignment(cost: number[][], k: number): number[] {
  if (k > 6) {
    const order: [number, number][] = [];
    for (let g = 0; g < k; g++) for (let s = 0; s < k; s++) order.push([g, s]);
    order.sort(
      (a, b) =>
        cost[a[0]][a[1]] - cost[b[0]][b[1]] || a[0] - b[0] || a[1] - b[1],
    );
    const out = new Array(k).fill(-1);
    const slotTaken = new Array(k).fill(false);
    for (const [g, s] of order) {
      if (out[g] !== -1 || slotTaken[s]) continue;
      out[g] = s;
      slotTaken[s] = true;
    }
    return out;
  }
  let best = Array.from({ length: k }, (_, i) => i);
  let bestCost = Infinity;
  const used = new Array(k).fill(false);
  const cur = new Array(k).fill(0);
  const walk = (g: number, acc: number) => {
    if (g === k) {
      if (acc < bestCost) {
        bestCost = acc;
        best = [...cur];
      }
      return;
    }
    for (let s = 0; s < k; s++) {
      if (used[s]) continue;
      used[s] = true;
      cur[g] = s;
      walk(g + 1, acc + cost[g][s]);
      used[s] = false;
    }
  };
  walk(0, 0);
  return best;
}

/** `slotOfGame[night][gameIndex]`, aligned with `pairsByNight`; games take the first k slots. */
export function assignSlots(opts: SlotOptions): number[][] {
  const {
    teamCount: T,
    pairsByNight,
    slotsPerNight,
    weekdayOfNight,
    seed = 1,
    restarts = 60,
    timeBudgetMs = 400,
    streak3W = STREAK3_W_DEFAULT,
    initial,
    frozen,
    pinned,
    biases,
  } = opts;
  const N = pairsByNight.length;
  if (N === 0) return [];
  const numSlots = Math.max(1, ...slotsPerNight);
  const rnd = mulberry32(seed);
  const deadline = Date.now() + timeBudgetMs;

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
  const giOfTeam: Map<number, number>[] = pairsByNight.map((pairs) => {
    const m = new Map<number, number>();
    pairs.forEach(([a, b], gi) => {
      m.set(a, gi);
      m.set(b, gi);
    });
    return m;
  });
  const slotSeq: number[][] = nightsOf.map((list) =>
    new Array(list.length).fill(0),
  );

  const usedWd = weekdayOfNight
    ? [...new Set(weekdayOfNight.slice(0, N))].sort((a, b) => a - b)
    : [];
  const wdIndex = new Map(usedWd.map((w, i) => [w, i]));
  const D = usedWd.length;
  const wdOfNight = weekdayOfNight
    ? weekdayOfNight.slice(0, N).map((w) => wdIndex.get(w)!)
    : [];
  const wdOfGame: number[][] = nightsOf.map((list) =>
    list.map((n) => wdOfNight[n]),
  );

  /** `biasOfGame[t][i]`: signed pull on team t's i-th game; undefined for unasked teams. */
  const biasOfGame: (Int8Array | undefined)[] = new Array(T).fill(undefined);
  for (const b of biases ?? []) {
    if (b.team < 0 || b.team >= T) continue;
    const sign = biasSign(b.prefer);
    const row = biasOfGame[b.team] ?? new Int8Array(nightsOf[b.team].length);
    nightsOf[b.team].forEach((n, i) => {
      // ⛔ `+=`, not `=`: one row serves every bias this team has, and `iceOutcome` sums
      // overlapping windows. Assigning made the descent and the rank-off price different seasons.
      if (b.nights[n]) row[i] += sign;
    });
    biasOfGame[b.team] = row;
  }

  /** Flattest per-weekday split of each team's games over the ice its nights offer (an
   *  under-filled night drops its latest slot). `proportionalSplit`, so cost and report agree. */
  const idealOf: number[][] = [];
  /** The same target rounded up — see `seedNights` for why the seed wants it. */
  const capOf: number[][] = [];
  for (let t = 0; t < T; t++) {
    const ideal = new Array(D * numSlots).fill(0);
    const cap = new Array(D * numSlots).fill(0);
    for (let d = 0; d < D; d++) {
      const avail = new Array(numSlots).fill(0);
      let total = 0;
      for (const n of nightsOf[t]) {
        if (wdOfNight[n] !== d) continue;
        total++;
        for (let s = 0; s < Math.min(pairsByNight[n].length, numSlots); s++)
          avail[s]++;
      }
      const sum = avail.reduce((x, y) => x + y, 0);
      const split = proportionalSplit(total, avail);
      for (let s = 0; s < numSlots; s++) {
        ideal[d * numSlots + s] = split[s];
        cap[d * numSlots + s] =
          sum === 0 ? 0 : Math.ceil((total * avail[s]) / sum);
      }
    }
    idealOf.push(ideal);
    capOf.push(cap);
  }

  // Slots must be a permutation of 0..k-1, or two games share a sheet: fall back to packing.
  const isPermutation = (a: number[] | undefined, k: number): boolean => {
    if (!a || a.length !== k) return false;
    const seen = new Array<boolean>(k).fill(false);
    for (const v of a) {
      if (!Number.isInteger(v) || v < 0 || v >= k || seen[v]) return false;
      seen[v] = true;
    }
    return true;
  };
  const fromInitial = pairsByNight.map((pairs, n) =>
    isPermutation(initial?.[n], pairs.length),
  );
  const slotOf: number[][] = pairsByNight.map((pairs, n) =>
    fromInitial[n] ? [...initial![n]!] : pairs.map((_, gi) => gi),
  );

  const isPinned = (n: number, gi: number): boolean =>
    !!frozen?.[n] || !!pinned?.[n]?.includes(gi);

  /** Seeds the season in order, since the descent's start decides its basin. ⚠️ Supplied nights
   *  keep their slots (repair), and targets are ceilings: `proportionalSplit` stacks leftovers. */
  const seedNights = () => {
    if (D === 0) return;
    const seen = new Int32Array(T * D * numSlots);
    const recent = Math.max(1, numSlots - 1);
    const hist = new Int32Array(T * recent).fill(-1);

    for (let n = 0; n < N; n++) {
      const pairs = pairsByNight[n];
      const k = Math.min(pairs.length, numSlots);
      const d = wdOfNight[n];
      if (!fromInitial[n] && !frozen?.[n] && k > 1) {
        const cost: number[][] = pairs.map((pr) =>
          Array.from({ length: k }, (_, s) => {
            let c = 0;
            for (const t of pr) {
              const key = (t * D + d) * numSlots + s;
              c +=
                WEEKDAY_SHARE_W *
                (2 * (seen[key] - capOf[t][d * numSlots + s]) + 1);
              for (let j = 0; j < recent; j++) {
                if (hist[t * recent + j] === s)
                  c += (recent - j) * SEED_ROTATE_W;
              }
            }
            return c;
          }),
        );
        slotOf[n] = bestAssignment(cost, k);
      }
      for (let gi = 0; gi < pairs.length; gi++) {
        const s = slotOf[n][gi];
        for (const t of pairs[gi]) {
          if (s < numSlots) seen[(t * D + d) * numSlots + s]++;
          for (let j = recent - 1; j > 0; j--) {
            hist[t * recent + j] = hist[t * recent + j - 1];
          }
          hist[t * recent] = s;
        }
      }
    }
  };

  seedNights();

  const syncNight = (n: number) => {
    pairsByNight[n].forEach(([a, b], gi) => {
      slotSeq[a][posOf[a].get(n)!] = slotOf[n][gi];
      slotSeq[b][posOf[b].get(n)!] = slotOf[n][gi];
    });
  };
  for (let n = 0; n < N; n++) syncNight(n);

  // Reused scratch: `teamCost` runs millions of times and neither recurses nor escapes.
  const countsBuf = new Int32Array(numSlots);
  const wdBuf = new Int32Array(D * numSlots);

  const teamCost = (t: number): number => {
    const seq = slotSeq[t];
    if (seq.length === 0) return 0;
    countsBuf.fill(0);
    let consec = 0;
    let streak = 0;
    for (let i = 0; i < seq.length; i++) {
      countsBuf[seq[i]]++;
      if (i > 0 && seq[i] === seq[i - 1]) {
        consec += SPACING_W.slotConsecutive;
        // Third and later game of a run, the same shape as the report's `slotStreak3`.
        if (i > 1 && seq[i] === seq[i - 2]) streak += streak3W;
      }
    }
    let hi = countsBuf[0];
    let lo = countsBuf[0];
    let sq = 0;
    for (let s = 0; s < numSlots; s++) {
      const c = countsBuf[s];
      if (c > hi) hi = c;
      if (c < lo) lo = c;
      sq += c * c;
    }
    let wdDev = 0;
    if (D > 0) {
      wdBuf.fill(0);
      const wds = wdOfGame[t];
      for (let i = 0; i < seq.length; i++) wdBuf[wds[i] * numSlots + seq[i]]++;
      const ideal = idealOf[t];
      for (let k = 0; k < wdBuf.length; k++) {
        const dv = wdBuf[k] - ideal[k];
        wdDev += dv * dv;
      }
    }
    let bias = 0;
    const bg = biasOfGame[t];
    if (bg) for (let i = 0; i < seq.length; i++) bias += bg[i] * seq[i];
    return (
      consec +
      streak +
      SPACING_W.slotSpread * Math.max(0, hi - lo - 1) +
      SHARE_W * sq +
      WEEKDAY_SHARE_W * wdDev +
      SLOT_BIAS_W * bias
    );
  };

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

  /** ⚠️ The paired move a lone swap can't make: breaking a run dents the weekday share, so
   *  shift off on one night and take the slot back on another night of the same weekday. */
  const compoundPass = (): boolean => {
    if (D === 0) return false;
    let improved = false;
    const touched = new Set<number>();
    for (let t = 0; t < T; t++) {
      if (Date.now() > deadline) return improved;
      const seq = slotSeq[t];
      const nts = nightsOf[t];
      for (let i = 1; i < seq.length; i++) {
        if (seq[i] !== seq[i - 1]) continue;
        for (const at of [i, i - 1]) {
          const n1 = nts[at];
          if (frozen?.[n1]) continue;
          const i1 = giOfTeam[n1].get(t)!;
          if (isPinned(n1, i1)) continue;
          const s1 = slotOf[n1][i1];
          const d1 = wdOfNight[n1];
          let done = false;
          for (let s2 = 0; s2 < pairsByNight[n1].length && !done; s2++) {
            if (s2 === s1) continue;
            const j1 = slotOf[n1].indexOf(s2);
            if (j1 < 0 || isPinned(n1, j1)) continue;
            for (let m = 0; m < nts.length; m++) {
              const n2 = nts[m];
              if (n2 === n1 || seq[m] !== s2 || wdOfNight[n2] !== d1) continue;
              if (frozen?.[n2]) continue;
              const i2 = giOfTeam[n2].get(t)!;
              const j2 = slotOf[n2].indexOf(s1);
              if (j2 < 0 || isPinned(n2, i2) || isPinned(n2, j2)) continue;
              touched.clear();
              for (const g of [
                pairsByNight[n1][i1],
                pairsByNight[n1][j1],
                pairsByNight[n2][i2],
                pairsByNight[n2][j2],
              ]) {
                touched.add(g[0]);
                touched.add(g[1]);
              }
              let before = 0;
              for (const x of touched) before += teamCost(x);
              swapGames(n1, i1, j1);
              swapGames(n2, i2, j2);
              let after = 0;
              for (const x of touched) after += teamCost(x);
              if (after < before - 1e-9) {
                improved = true;
                done = true;
                break;
              }
              swapGames(n2, i2, j2);
              swapGames(n1, i1, j1);
            }
          }
          if (done) break;
        }
      }
    }
    return improved;
  };

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
      if (!improved) improved = compoundPass();
    }
  };

  const snapshot = () => slotOf.map((row) => [...row]);
  const restoreFrom = (snap: number[][]) => {
    for (let n = 0; n < N; n++) {
      for (let gi = 0; gi < snap[n].length; gi++) slotOf[n][gi] = snap[n][gi];
      syncNight(n);
    }
  };

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
