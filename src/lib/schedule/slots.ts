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

import { SPACING_W, proportionalSplit } from "./spacing";

/**
 * Even-share pull over the *season*, as a sum-of-squares gradient toward a flat
 * share. An even split of the good and bad ice times is the more visible
 * fairness property, so one step of imbalance outweighs a few back-to-back
 * repeats.
 *
 * Raised from 20 when the per-weekday term below arrived, and that is the whole
 * reason it is this high. Breaking a three-game run means taking some team a
 * step off its flat weekday split, and a team can absorb that two ways: 6-7-5 on
 * one weekday and 6-6-6 on the other, which dents the season total too, or
 * 6-7-5 against 6-5-7, which cancels and leaves the season at 12-12-12. Those
 * cost the same under the weekday term alone. At 20 the search took the first
 * and the season share the pipeline already had regressed to a spread of 2; this
 * is what makes it take the second.
 */
const SHARE_W = 60;

/**
 * The same pull, but on the share *within each weekday* — the season total can
 * read a perfect 12/12/12 while every Monday is 9/5/4. Ranked above `SHARE_W`
 * because it is the stronger statement: a flat split on every weekday implies a
 * flat-or-flatter season split, so this term subsumes that one rather than
 * fighting it.
 *
 * With a single weekday the two terms are the same statement scored twice. That
 * is deliberate — they pull the same way, so the only effect is that ice share
 * outweighs repeats by more on a one-weekday cadence, which is the right
 * ordering anyway.
 */
const WEEKDAY_SHARE_W = 30;

/**
 * Extra charge on the third-and-later game of an unbroken run in one ice time,
 * on top of the `slotConsecutive` each adjacent pair already pays, so a run of 4
 * pays it twice. Three in a row is a different complaint from two unrelated
 * repeats, not twice the same one.
 *
 * Sized against what removing a run actually costs. Breaking one means moving a
 * game to another ice time, which takes both its teams a step off their flat
 * per-weekday share: 2 teams × 2 × `WEEKDAY_SHARE_W` = 120. So the charge has to
 * clear 120 or the search will not pay it — but it deliberately stops short of
 * 240, the cost when the game swapped *with* is knocked off its share too.
 * Runs that can only be broken that expensively are left alone.
 *
 * This is the one weight here with a cliff on either side rather than a slope,
 * so it was measured across 140–260 on the reference season rather than picked:
 * every value in that band clears the runs, and where in it the season's
 * residual `slotWeekdaySpread` lands (4 to 12) is search luck, not a trend. Read
 * a big swing from a small change as that noise, not as a better weight.
 *
 * **160 is no longer load-bearing.** It is the default for callers that pass no
 * `streak3W`, and the first of several candidates generation actually runs — see
 * `SLOT_CANDIDATES` in `assignNights.ts`, which ranks their results and keeps the
 * best. Tuning this number on one fixture is therefore the wrong move twice over:
 * the band above says a single fixture cannot tell you which value in it is
 * better, and selection has made the question moot. Change the candidate set
 * instead. 160 must stay in it — that is what makes the selected result provably
 * never worse than what shipped before selection existed.
 */
const STREAK3_W_DEFAULT = 160;

/**
 * The seed's pull toward rotating through the ice times rather than merely
 * avoiding the one just played, charged per recent game in the same slot and
 * scaled by how recent: the previous game costs `numSlots - 1` of these, the one
 * before it one fewer, and anything older is free.
 *
 * "Not the same as last time" is too short a memory to seed with. It lets a team
 * settle into 0,1,0,1 and leaves whole runs for the search to unpick one swap at
 * a time; asking for a rotation instead is what takes the seed's own three-game
 * runs to nothing on most cadences.
 *
 * Kept small on purpose — an ordinary repeat's worth. The seed's job is the
 * share layout, and its per-weekday marginal moves in steps of 2 ×
 * `WEEKDAY_SHARE_W`, so this only ever decides between slots the share is
 * indifferent about. Raising it to where it can outbid the share makes the seed
 * worse, not better: at 20 the reference season ends at 2 three-game runs where
 * at 6 it ends at none.
 */
const SEED_ROTATE_W = 6;

export type SlotOptions = {
  teamCount: number;
  /** Per night, the team pairs playing (from Phase M). */
  pairsByNight: [number, number][][];
  /** Ice slots available each night. */
  slotsPerNight: number[];
  /**
   * Which weekday each night falls on. Either dense indexes or raw 0=Sun..6=Sat
   * day numbers work — they are compressed internally, so the weekday count is
   * derived rather than passed. Without it the search is weekday-blind and only
   * the season-wide ice share is modelled, which is what it did before.
   */
  weekdayOfNight?: number[];
  seed?: number;
  restarts?: number;
  /** Wall-clock cap on the whole search. */
  timeBudgetMs?: number;
  /**
   * Charge on the third-and-later game of a run in one ice time. Defaults to
   * `STREAK3_W_DEFAULT`. Exposed because no single value is best across
   * cadences — `assignNights` runs several and ranks the results.
   */
  streak3W?: number;
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
 * The cheapest one-game-per-slot packing of a single night, given a cost that
 * is separable per (game, slot) — a linear assignment problem on a tiny matrix.
 *
 * Exact by enumeration up to 6 games a night (720 orders, ~35k leaves over a
 * season, which is noise beside the descent). Beyond that it falls back to a
 * cheapest-pair-first greedy: the enumeration would start to cost real time,
 * and this only ever produces a *starting point* the descent then improves.
 * No branch-and-bound prune, because the costs are deviations and can be
 * negative, which makes a partial sum no bound on its completions. Ties keep
 * the lexicographically first packing, so the result stays deterministic.
 */
function bestAssignment(cost: number[][], k: number): number[] {
  if (k > 6) {
    const order: [number, number][] = [];
    for (let g = 0; g < k; g++) for (let s = 0; s < k; s++) order.push([g, s]);
    order.sort(
      (a, b) => cost[a[0]][a[1]] - cost[b[0]][b[1]] || a[0] - b[0] || a[1] - b[1],
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
    weekdayOfNight,
    seed = 1,
    restarts = 60,
    timeBudgetMs = 400,
    streak3W = STREAK3_W_DEFAULT,
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
  /** `giOfTeam[night].get(team)` — which of a night's games a team is in. */
  const giOfTeam: Map<number, number>[] = pairsByNight.map((pairs) => {
    const m = new Map<number, number>();
    pairs.forEach(([a, b], gi) => {
      m.set(a, gi);
      m.set(b, gi);
    });
    return m;
  });
  const slotSeq: number[][] = nightsOf.map((list) => new Array(list.length).fill(0));

  // Weekday frame. Compressed to dense indexes so a caller may hand over raw
  // 0=Sun..6=Sat day numbers without paying for five empty weekdays in the
  // innermost loop. D = 0 means weekday-blind, the pre-goal-3 behaviour.
  const usedWd = weekdayOfNight
    ? [...new Set(weekdayOfNight.slice(0, N))].sort((a, b) => a - b)
    : [];
  const wdIndex = new Map(usedWd.map((w, i) => [w, i]));
  const D = usedWd.length;
  const wdOfNight = weekdayOfNight
    ? weekdayOfNight.slice(0, N).map((w) => wdIndex.get(w)!)
    : [];
  /** Each team's game weekdays, index-aligned with `slotSeq[t]`. */
  const wdOfGame: number[][] = nightsOf.map((list) => list.map((n) => wdOfNight[n]));

  /**
   * `idealOf[t][d * numSlots + s]` — the flattest split of team `t`'s games on
   * weekday `d` across that weekday's ice times, which is what the per-weekday
   * share term measures deviation from.
   *
   * The weights are how many of *this team's* nights on that weekday actually
   * offer slot `s`: an under-filled night drops its latest slot, so a uniform
   * target would ask for a share of ice that does not exist. `proportionalSplit`
   * is the same largest-remainder rounding the report's target uses, so the cost
   * the search minimises and the number the panel prints cannot drift apart.
   */
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
        for (let s = 0; s < Math.min(pairsByNight[n].length, numSlots); s++) avail[s]++;
      }
      const sum = avail.reduce((x, y) => x + y, 0);
      const split = proportionalSplit(total, avail);
      for (let s = 0; s < numSlots; s++) {
        ideal[d * numSlots + s] = split[s];
        cap[d * numSlots + s] = sum === 0 ? 0 : Math.ceil((total * avail[s]) / sum);
      }
    }
    idealOf.push(ideal);
    capOf.push(cap);
  }

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
  const fromInitial = pairsByNight.map((pairs, n) =>
    isPermutation(initial?.[n], pairs.length),
  );
  const slotOf: number[][] = pairsByNight.map((pairs, n) =>
    fromInitial[n] ? [...initial![n]] : pairs.map((_, gi) => gi),
  );

  /** A game the search must leave alone: on a frozen night, or explicitly pinned. */
  const isPinned = (n: number, gi: number): boolean =>
    !!frozen?.[n] || !!pinned?.[n]?.includes(gi);

  /**
   * The default packing — game `i` takes slot `i` — is weekday-blind, and the
   * descent below is a local search under a wall clock: where it starts decides
   * which basin it can reach. So lay the season down once in chronological
   * order, giving each night's games the ice times that leave every team closest
   * to a flat per-weekday share and off the slot it just played. Nights the
   * caller supplied (`initial`) keep what they were given — a mid-season repair
   * must not reshuffle the ice times a published season already has — but their
   * slots still feed the running counts the later nights balance against.
   *
   * Targets here are the *ceiling* of each proportional share, not
   * `proportionalSplit`: on an odd total the latter hands every team's leftover
   * to the same slot, and a greedy chasing a split no schedule can hold is worse
   * than one with a unit of slack. The exact target is the descent's job.
   */
  const seedNights = () => {
    if (D === 0) return;
    const seen = new Int32Array(T * D * numSlots);
    // Each team's last `numSlots - 1` ice times, most recent first. Long enough
    // to hold a full rotation, which is what `SEED_ROTATE_W` is asking for.
    const recent = Math.max(1, numSlots - 1);
    const hist = new Int32Array(T * recent).fill(-1);

    for (let n = 0; n < N; n++) {
      const pairs = pairsByNight[n];
      const k = Math.min(pairs.length, numSlots);
      const d = wdOfNight[n];
      if (!fromInitial[n] && !frozen?.[n] && k > 1) {
        // cost[gi][s]: what putting game `gi` on slot `s` costs the two teams in
        // it, given everything already laid down. Separable per (game, slot), so
        // the night's best packing is a linear assignment.
        const cost: number[][] = pairs.map((pr) =>
          Array.from({ length: k }, (_, s) => {
            let c = 0;
            for (const t of pr) {
              const key = (t * D + d) * numSlots + s;
              // Marginal squared deviation of taking one more of this slot.
              c += WEEKDAY_SHARE_W * (2 * (seen[key] - capOf[t][d * numSlots + s]) + 1);
              for (let j = 0; j < recent; j++) {
                if (hist[t * recent + j] === s) c += (recent - j) * SEED_ROTATE_W;
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

  // Scratch buffers for `teamCost`, which runs inside the innermost swap loop
  // millions of times a season. Reused rather than reallocated; it neither
  // recurses nor escapes, so one set is enough.
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
        // Charged on the third and later game of a run, so a run of 4 pays it
        // twice — the same shape as the `slotStreak3` the report counts.
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
    return (
      consec +
      streak +
      SPACING_W.slotSpread * Math.max(0, hi - lo - 1) +
      SHARE_W * sq +
      WEEKDAY_SHARE_W * wdDev
    );
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

  /**
   * The paired move the single-swap neighbourhood cannot reach.
   *
   * Moving a team off a repeated ice time always dents its per-weekday share,
   * and share now outranks repeats — so a lone swap that breaks a run is a cost
   * *rise* and the descent refuses it, however many runs the season has left.
   * (Turning that around by weight would invert the goals' priority, which is
   * not on offer.) So make the move in two halves: shift the team off the repeat
   * on one night, and take the slot back on another of its nights *on the same
   * weekday*. Its per-weekday counts are then unchanged by construction, and
   * only the repeats and the swapped-with teams are left to score.
   *
   * `SCHEDULE_HANDOFF.md` §5 predicted this — "a compound move that swaps slots
   * across two nights at once, restoring each team's share in the same step".
   *
   * Only started from a repeat that already exists, so the neighbourhood stays
   * proportional to the damage rather than to the season.
   */
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
        // Either end of the repeat will do; try the later game first.
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

  /**
   * Descend on swaps of two games' slots within a night, to a local optimum —
   * then, once that stalls, on the compound move above. Ordered that way because
   * the single swap is an order of magnitude cheaper to evaluate, so it should
   * do all the work it can before the paired neighbourhood is opened.
   */
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
