# Ice-time clustering: night-order post-pass — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop the generator handing one team the same ice time 3+ times in 5
straight weeks far more often than its rivals, without giving up anything the
league already ranks.

**Architecture:** Add a clustering metric to `SpacingReport`, then add a
post-generation pass that permutes the *night order* of the winning plan.
Permuting nights carries each night's games and ice times together, so ice
shares, meetings per pair and games per team are invariant; only temporal
metrics move. The pass accepts a permutation only when the whole `rankSchedule`
vector is no worse, which makes it safe on every league shape and a no-op where
it cannot help.

**Tech Stack:** TypeScript, Vitest (`npm test`), Next.js App Router.

**Spec:** `docs/superpowers/specs/2026-09-09-ice-time-clustering-design.md`

## Global Constraints

- **Never regress a ranked metric.** The pass compares the full `rankSchedule`
  vector before and after and keeps the permutation only on a strict improvement
  in clustering with no worsening anywhere else.
- **Clustering ranks last.** In `rankSchedule` the new metric goes *below*
  `slotConsecutive`. It must never be able to trade a back-to-back for a cluster
  — that is what makes this free by construction rather than by tuning.
- **Definitions.** A *clustered window* is 5 consecutive games in which one team
  takes the same ice time 3+ times. Windows are over a team's **games** in
  chronological order, not calendar nights — consistent with `slotConsecutive`.
- **Do not touch** `slots.ts` weights, `SLOT_CANDIDATES`, `matchups.ts`, or
  `oneOff.ts`'s deliberately-separate comparison rule.
- Run the schedule suite with `npx vitest run src/lib/schedule` — full e2e is CI's
  job.

## File Structure

- `src/lib/schedule/spacing.ts` — add two fields to `SpacingReport` and compute
  them in the existing per-team loop. Nothing else changes here.
- `src/lib/schedule/nightOrder.ts` — **new.** The permutation search. Pure:
  takes an order and a scoring callback, returns an order. No imports from
  `assignNights.ts`, so it stays testable in isolation.
- `src/lib/schedule/assignNights.ts` — add the metric to `rankSchedule` (last),
  and call the pass on the winning plan.
- Tests live beside each file as `*.test.ts`.

---

### Task 1: Measure clustering in `SpacingReport`

**Files:**
- Modify: `src/lib/schedule/spacing.ts`
- Test: `src/lib/schedule/spacing.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `SpacingReport.slotClusterWindows: number` (Σ over all teams of that
  team's clustered windows) and `SpacingReport.slotClusterWorstTeam: number`
  (the largest single team's count). Task 3 ranks on both.

- [ ] **Step 1: Write the failing test**

Add to `src/lib/schedule/spacing.test.ts`:

```ts
describe("ice-time clustering", () => {
  // Two teams, one game a week, so each team's slot sequence is exactly the
  // list below. 6 games => two 5-game windows per team.
  const seasonOf = (slots: number[]) => {
    const nights = slots.map((_, i) => ({
      date: new Date(Date.UTC(2026, 8, 1) + i * 7 * 86400000)
        .toISOString()
        .slice(0, 10),
      slots: ["19:00", "20:15", "21:30"],
    }));
    const games = slots.map((s, i) => ({
      home: "t1",
      away: "t2",
      nightIndex: i,
      slotIndex: s,
    }));
    return spacingReport(games, nights, ["t1", "t2"]);
  };

  it("counts a window where one ice time takes 3 of 5 games", () => {
    // windows: [2,2,2,0,1] -> three 2s, and [2,2,0,1,2] -> three 2s.
    const r = seasonOf([2, 2, 2, 0, 1, 2]);
    expect(r.slotClusterWorstTeam).toBe(2);
    expect(r.slotClusterWindows).toBe(4); // both teams, both windows
  });

  it("counts nothing when the team rotates through the ice times", () => {
    const r = seasonOf([0, 1, 2, 0, 1, 2]);
    expect(r.slotClusterWorstTeam).toBe(0);
    expect(r.slotClusterWindows).toBe(0);
  });

  it("ignores a season too short to hold a window", () => {
    const r = seasonOf([2, 2, 2, 2]);
    expect(r.slotClusterWindows).toBe(0);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run src/lib/schedule/spacing.test.ts -t "ice-time clustering"`
Expected: FAIL — `slotClusterWorstTeam` is `undefined`.

- [ ] **Step 3: Implement**

In `src/lib/schedule/spacing.ts`, beside the other slot constants:

```ts
/**
 * A clustered window is 5 consecutive games in which a team takes one ice time
 * 3+ times — "the late game three times in five weeks", which is how the
 * complaint arrives. Counted over a team's GAMES, not calendar nights, so a
 * league with byes reads the same way a league without them does.
 */
const CLUSTER_WINDOW = 5;
const CLUSTER_MAX_SAME = 2;
```

Add to the `SpacingReport` type, beside `slotStreak3`:

```ts
  /**
   * Σ over teams of that team's clustered windows. A total, so it says how much
   * clustering the season holds but not who carries it.
   */
  slotClusterWindows: number;
  /**
   * The largest single team's clustered-window count. This is the number that
   * matches the complaint: the damage concentrates, and a season measured at 33
   * total had one team carrying 14 of them and another carrying 1.
   */
  slotClusterWorstTeam: number;
```

Initialise both to `0` in the `report` literal. Then inside the existing
per-team loop, directly after the `slotConsecutive` / `slotStreak3` block that
already walks `mine`:

```ts
    // Rolling window over this team's games. `mine` is already chronological.
    let clustered = 0;
    for (let i = 0; i + CLUSTER_WINDOW <= mine.length; i++) {
      const counts = new Array(numSlots).fill(0);
      for (let j = i; j < i + CLUSTER_WINDOW; j++) counts[mine[j][1]]++;
      if (Math.max(...counts) > CLUSTER_MAX_SAME) clustered++;
    }
    report.slotClusterWindows += clustered;
    if (clustered > report.slotClusterWorstTeam)
      report.slotClusterWorstTeam = clustered;
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run src/lib/schedule/spacing.test.ts`
Expected: PASS, including every pre-existing test in the file.

- [ ] **Step 5: Prove the test can fail**

Temporarily change `CLUSTER_MAX_SAME` to `4` and re-run. Expected: the first
test fails. Restore it to `2`. (A count-preserving assertion can pass against a
broken guard; this confirms it does not.)

- [ ] **Step 6: Commit**

```bash
git add src/lib/schedule/spacing.ts src/lib/schedule/spacing.test.ts
git commit -m "feat(schedule): measure ice-time clustering per team"
```

---

### Task 2: The night-order permutation search

**Files:**
- Create: `src/lib/schedule/nightOrder.ts`
- Test: `src/lib/schedule/nightOrder.test.ts`

**Interfaces:**
- Consumes: nothing — deliberately pure, so it never imports `assignNights.ts`.
- Produces:
  `improveNightOrder(nightCount: number, score: (order: number[]) => { cost: number; admissible: boolean }, opts?: { seed?: number; restarts?: number; steps?: number }): number[]`.
  `score` returns a scalar `cost` to minimise and whether the order is
  `admissible` at all. The search anneals on `cost` (so it may cross
  inadmissible ground) but only ever *records* an admissible order. Returns the
  best admissible order found, always a permutation of `0..nightCount-1`, and
  the identity when nothing beats it.

- [ ] **Step 1: Write the failing test**

Create `src/lib/schedule/nightOrder.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { improveNightOrder } from "./nightOrder";

describe("improveNightOrder", () => {
  const ok = (cost: number) => ({ cost, admissible: true });

  it("returns a permutation of every night", () => {
    const order = improveNightOrder(9, (o) => ok(o.indexOf(0)));
    expect([...order].sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8]);
  });

  it("finds an order the scorer prefers", () => {
    // Wants night 8 first; the identity costs 8, the optimum costs 0.
    const order = improveNightOrder(9, (o) => ok(o.indexOf(8)));
    expect(order[0]).toBe(8);
  });

  it("keeps the identity when nothing can beat it", () => {
    const order = improveNightOrder(9, () => ok(0));
    expect(order).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8]);
  });

  it("never returns an order the scorer called inadmissible", () => {
    // Only orders starting at night 3 are admissible; the rest are cheaper, so
    // a search that ignored `admissible` would settle on one of them.
    const order = improveNightOrder(9, (o) => ({
      cost: o[0] === 3 ? 10 : 0,
      admissible: o[0] === 3,
    }));
    expect(order[0]).toBe(3);
  });

  it("is deterministic for a given seed", () => {
    const s = (o: number[]) => ok(o.indexOf(5) * 10 + o.indexOf(2));
    expect(improveNightOrder(12, s, { seed: 7 })).toEqual(
      improveNightOrder(12, s, { seed: 7 }),
    );
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run src/lib/schedule/nightOrder.test.ts`
Expected: FAIL — cannot resolve `./nightOrder`.

- [ ] **Step 3: Implement**

Create `src/lib/schedule/nightOrder.ts`:

```ts
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
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run src/lib/schedule/nightOrder.test.ts`
Expected: PASS, all five.

- [ ] **Step 5: Commit**

```bash
git add src/lib/schedule/nightOrder.ts src/lib/schedule/nightOrder.test.ts
git commit -m "feat(schedule): night-order permutation search"
```

---

### Task 3: Rank on clustering, and run the pass

**Files:**
- Modify: `src/lib/schedule/assignNights.ts` (`rankSchedule`, and the winning
  plan's return path)
- Test: `src/lib/schedule/assignNights.test.ts`

**Interfaces:**
- Consumes: `SpacingReport.slotClusterWindows` / `.slotClusterWorstTeam`
  (Task 1); `improveNightOrder` (Task 2).
- Produces: no signature change. `assignNights` returns the same shape; the
  games' `nightIndex` values simply reflect the improved order.

- [ ] **Step 1: Write the failing test**

Add to `src/lib/schedule/assignNights.test.ts`:

```ts
// 6 teams, one game night a week, 3 sheets: everyone plays every week, so this
// is the shape where night order is free to move. Measured 2026-09-09: without
// the pass the worst team carries 14 clustered windows.
describe("assignNights — ice-time clustering, 6 teams on one weeknight", () => {
  const ts = teams(6);
  const ns = enumerateNights("2026-09-08", {
    weekdays: new Set([2]),
    slotTimes: ["19:00", "20:15", "21:30"],
    excluded: new Set<string>(),
    maxNights: 23,
  });
  const { games, report } = assignNights(buildBalancedPairings(ts, 23), ns, ts);

  it("schedules the whole season", () => {
    expect(report.unscheduled).toBe(0);
    expect(games.length).toBe(69);
    for (const t of report.gamesPerTeam) expect(t.count).toBe(23);
  });

  it("keeps no team far worse off than the rest on ice time", () => {
    // The floor measured by an exhaustive solver is 4. Assert the bound, not the
    // floor: pinning 4 would be asserting search luck.
    expect(report.spacing.slotClusterWorstTeam).toBeLessThanOrEqual(6);
  });

  it("buys that without giving up back-to-backs or runs", () => {
    expect(report.spacing.slotConsecutive).toBeLessThanOrEqual(6);
    expect(report.spacing.slotStreak3).toBe(0);
    expect(report.spacing.rematchAdjNight).toBe(0);
    expect(report.spacing.rematchConsecWeek).toBe(0);
  });

  it("still gives every team an even share of the three ice times", () => {
    for (const s of report.slotShareByTeam) {
      expect(Math.max(...s.counts) - Math.min(...s.counts)).toBeLessThanOrEqual(1);
    }
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run src/lib/schedule/assignNights.test.ts -t "6 teams on one weeknight"`
Expected: the clustering test FAILS with `slotClusterWorstTeam` at 14. The other
three pass — they describe what already works.

- [ ] **Step 3: Add the metric to `rankSchedule`**

In `rankSchedule`, append to the returned array, **after** `r.slotConsecutive`:

```ts
    r.slotClusterWorstTeam,
    r.slotClusterWindows,
```

Extend that function's doc comment with:

```
 * Clustering sits LAST on purpose. It can only choose between plans that
 * already tie on every other term, so it can never buy a shorter clustered
 * stretch with a back-to-back — which is what keeps the night-order pass free.
```

- [ ] **Step 4: Run the pass on the winning plan**

In `assignNights`, after the winning `plan` is settled and before its games are
returned, add:

```ts
  // Reordering nights moves clustering while carrying each night's games and
  // ice times with it. Admissibility is judged on the WHOLE rank vector, so on a
  // shape where reordering would cost byes, weekday balance or rematch spacing,
  // every candidate is refused and the identity survives.
  const baseRank = rankSchedule(plan, nights, teamIds, meta);
  // The last two entries are the clustering pair this task appended; everything
  // above them is what must not get worse.
  const CLUSTER_TAIL = 2;
  const worstOf = (v: number[]) => v[v.length - 2];
  const totalOf = (v: number[]) => v[v.length - 1];
  const reordered = improveNightOrder(nights.length, (order) => {
    // Position lookup, not `order.indexOf`: this runs once per annealing step.
    const pos = new Array<number>(nights.length);
    order.forEach((n, i) => (pos[n] = i));
    const moved = plan.games.map((g) => ({ ...g, nightIndex: pos[g.nightIndex] }));
    const rank = rankSchedule({ ...plan, games: moved }, nights, teamIds, meta);
    let penalty = 0;
    let noWorse = true;
    for (let i = 0; i < rank.length - CLUSTER_TAIL; i++) {
      const over = rank[i] - baseRank[i];
      if (over > 0) {
        noWorse = false;
        penalty += over * 1_000_000;
      }
    }
    const better =
      worstOf(rank) < worstOf(baseRank) ||
      (worstOf(rank) === worstOf(baseRank) && totalOf(rank) < totalOf(baseRank));
    return {
      cost: penalty + worstOf(rank) * 1_000 + totalOf(rank),
      admissible: noWorse && better,
    };
  });
  if (reordered.some((n, i) => n !== i)) {
    const pos = new Array<number>(nights.length);
    reordered.forEach((n, i) => (pos[n] = i));
    plan = {
      ...plan,
      games: plan.games.map((g) => ({ ...g, nightIndex: pos[g.nightIndex] })),
    };
  }
```

Import it at the top: `import { improveNightOrder } from "./nightOrder";`

- [ ] **Step 5: Run the tests**

Run: `npx vitest run src/lib/schedule`
Expected: PASS, including the reference-season suite. If the 8-team reference
regresses on any metric, STOP — the pass is meant to be incapable of that, so a
regression means the scorer is not seeing the full rank vector. Fix that rather
than relaxing the reference assertions.

- [ ] **Step 6: Commit**

```bash
git add src/lib/schedule/assignNights.ts src/lib/schedule/assignNights.test.ts
git commit -m "feat(schedule): reorder nights to break up ice-time clustering"
```

---

### Task 4: Confirm nothing regressed, and record it

**Files:**
- Modify: `SCHEDULE_HANDOFF.md`
- Test: the existing schedule suite

- [ ] **Step 1: Measure the reference season three times**

Phase S is wall-clock bounded, so one green run proves nothing.

```bash
for i in 1 2 3; do npx vitest run src/lib/schedule 2>&1 | tail -3; done
```

Expected: three passes. Record the wall-clock of a full generate — if it has
grown by more than ~2 s, lower `steps` in the `improveNightOrder` call rather
than loosening any assertion.

- [ ] **Step 2: Walk the §4 scenario table**

For each row of `SCHEDULE_HANDOFF.md` §4 (10t/4slot/45n, 9t/4slot/36n,
7t/3slot/35n, 8t Mon/Wed/Fri, 8t Thu-only, 6t, 10t/5slot, 8t/2slot/28n, 4t/2slot,
7t/3slot/11n, 12t/6slot/24n, over-capacity), confirm the existing tests covering
it still pass. Every one is already in `src/lib/schedule/*.test.ts`; there is no
new fixture to write.

- [ ] **Step 3: Record it in the handoff**

Add to `SCHEDULE_HANDOFF.md` §1's table:

```
| **G5.** Worst team's clustered 5-game windows (`slotClusterWorstTeam`) | 14 | **4** (6-team/1-weeknight/3-slot reference) |
```

And a §5 bullet:

```
- **Clustering is fixed by night order, not by Phase S or Phase M.** Two routes
  were built and measured dead on 2026-09-09: permuting the rounds
  `buildBalancedPairings` emits changes nothing (Phase M takes the pairings as a
  multiset and re-derives the periodic cycle itself), and varying Phase M's seed
  changes nothing (its rematch terms are threshold-based, so the cycle is one of
  many zero-cost orderings and the descent always lands on it). What works is
  reordering the finished plan's nights, which carries each night's games and ice
  times together. See the spec for the measurements before trying either dead
  route again.
```

- [ ] **Step 4: Commit**

```bash
git add SCHEDULE_HANDOFF.md
git commit -m "docs(schedule): record the night-order pass and two dead routes"
```
