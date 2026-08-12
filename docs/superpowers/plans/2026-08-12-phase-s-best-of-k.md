# Phase S Best-of-k Weight Selection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop depending on one hand-tuned `STREAK3_W` value by running Phase S at several weights and keeping the winner under a lexicographic ranking of the reported ice-time metrics.

**Architecture:** Three moves, in order. (1) Add a shared comparator that ranks ice-time outcomes lexicographically on the *reported* metrics rather than on Phase S's internal blended scalar. (2) Use it to restore the one-off repair's "never worse than leaving it alone" guarantee, which is broken today at production budget. (3) Use it again in `assignNights` to run `assignSlots` at k weights and keep the best. Because the current weight (160) stays in the candidate set, the result can never be worse than what ships today.

**Tech Stack:** TypeScript, Vitest, no new dependencies.

## Global Constraints

- **Rematch spacing is protected.** All four rematch metrics are 0 on the reference season and must stay 0. Nothing in this plan touches Phase M, but any change that moves them is a regression.
- **Never regress the priority order.** `rankSchedule`'s order is: everything placed ▸ weekday balance ▸ byes ▸ rematch ▸ ice time. This plan operates strictly *inside* the ice-time family and must not reorder anything above it.
- **Ice-time sub-order, decided:** season share ▸ per-weekday share ▸ `slotStreak3` ▸ `slotConsecutive`. Season share leads because breaking the 12/12/12 season split is the failure mode that has fooled this search twice — simulated annealing "beat" 41 that way, and so did every spread-4 candidate found in a restart-pool probe on 2026-08-12. If the league ever decides per-weekday fairness outweighs season fairness, `compareIceOutcome` is the single place to change it.
- **`STREAK3_W` default stays 160.** It remains the first candidate so the guarantee holds.
- **Do not rescale `MULT_W` or the `SPACING_W` rematch weights** without rescaling `oneOff.ts`'s `nightPenalty` churn in the same change. No test covers this coupling; it fails silently. See `SCHEDULE_HANDOFF.md` §5.
- **Verify with:** `npx vitest run && npm run lint && npx tsc --noEmit`. Baseline before this plan: **214 pass**, lint clean, tsc clean.

## Measured facts this plan is built on

All watched appear on 2026-08-12 at production budget (`OBHL_SLOT_BUDGET_MS=5000`), reference season (8 teams, Mon + Thu, 3 ice times, 48 nights, 36 games/team):

| `STREAK3_W` | ref `slotWeekdaySpread` | ref `slotConsecutive` | Mon/Wed/Fri spread |
|---|---|---|---|
| 140 | **0** | 48 | 28 (guard is 26) |
| 160 (shipped) | 8 | 46 | **24** |
| 144 / 148 / 152 | 8 | 58 | — |

Neither weight dominates: 140 wins the reference cadence, 160 wins Mon/Wed/Fri. Best-of-both wins both. 140 is an isolated basin, not a trend — 144–152 are strictly worse, which is why selection is the right mechanism and a formula is not.

Longer budgets do **not** substitute for this: at 160, 10 s and 20 s still read spread 8.

---

## File Structure

| File | Responsibility |
|---|---|
| `src/lib/schedule/spacing.ts` (modify) | Gains `IceOutcome`, `iceOutcome()`, `compareIceOutcome()`. Lives here because it already owns the metric definitions these must agree with. |
| `src/lib/schedule/spacing.test.ts` (modify) | Tests the comparator and the agreement between `iceOutcome()` and `spacingReport()`. |
| `src/lib/schedule/oneOff.ts` (modify) | Drops repair plans that lose to the no-repair baseline. |
| `src/lib/schedule/slots.ts` (modify) | `STREAK3_W` becomes a per-call option with default 160. |
| `src/lib/schedule/assignNights.ts` (modify) | Runs `assignSlots` at k weights, keeps the best by `compareIceOutcome`. |
| `vitest.config.ts` (modify) | Test slot budget 400 → 5000, so tests stop masking production behaviour. |

---

### Task 1: Lexicographic ice-time comparator

**Files:**
- Modify: `src/lib/schedule/spacing.ts`
- Test: `src/lib/schedule/spacing.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  - `export type IceOutcome = { seasonSpread: number; weekdaySpread: number; streak3: number; consecutive: number }`
  - `export function iceOutcome(opts: { teamCount: number; pairsByNight: [number, number][][]; slotOf: number[][]; weekdayOfNight?: number[] }): IceOutcome`
  - `export function compareIceOutcome(a: IceOutcome, b: IceOutcome): number` — negative when `a` is better.

- [ ] **Step 1: Write the failing tests**

Add to `src/lib/schedule/spacing.test.ts`:

```ts
import { iceOutcome, compareIceOutcome, spacingReport } from "./spacing";

describe("compareIceOutcome", () => {
  const base = { seasonSpread: 0, weekdaySpread: 8, streak3: 0, consecutive: 46 };

  it("prefers a flat season share over every other gain", () => {
    // The failure mode this exists to prevent: a candidate that looks better on
    // weekday spread and repeats but breaks the even season share.
    const tempting = { seasonSpread: 4, weekdaySpread: 0, streak3: 0, consecutive: 41 };
    expect(compareIceOutcome(base, tempting)).toBeLessThan(0);
  });

  it("prefers a flatter weekday split once season share ties", () => {
    const better = { ...base, weekdaySpread: 0 };
    expect(compareIceOutcome(better, base)).toBeLessThan(0);
  });

  it("prefers fewer three-game runs over fewer ordinary repeats", () => {
    const fewerRuns = { ...base, streak3: 0, consecutive: 50 };
    const fewerRepeats = { ...base, streak3: 1, consecutive: 40 };
    expect(compareIceOutcome(fewerRuns, fewerRepeats)).toBeLessThan(0);
  });

  it("falls through to ordinary repeats when all else ties", () => {
    expect(compareIceOutcome({ ...base, consecutive: 40 }, base)).toBeLessThan(0);
  });

  it("is 0 for identical outcomes", () => {
    expect(compareIceOutcome(base, { ...base })).toBe(0);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/lib/schedule/spacing.test.ts -t compareIceOutcome`
Expected: FAIL — `compareIceOutcome is not a function` (it is not exported yet).

- [ ] **Step 3: Implement the comparator**

Add to `src/lib/schedule/spacing.ts`:

```ts
/**
 * An ice-time result, in the four numbers `spacingReport` publishes. Selection
 * ranks these lexicographically rather than blending them, because a blended
 * scalar can and does prefer a candidate that breaks the even season share to
 * buy a flatter weekday split — the trade the league has rejected twice.
 */
export type IceOutcome = {
  /** Σ over teams of (max − min) of that team's season slot counts. */
  seasonSpread: number;
  /** `slotWeekdaySpread` — the same, within each weekday. */
  weekdaySpread: number;
  /** `slotStreak3`. */
  streak3: number;
  /** `slotConsecutive`. */
  consecutive: number;
};

/** Lexicographic, lower is better. Negative when `a` beats `b`. */
export function compareIceOutcome(a: IceOutcome, b: IceOutcome): number {
  return (
    a.seasonSpread - b.seasonSpread ||
    a.weekdaySpread - b.weekdaySpread ||
    a.streak3 - b.streak3 ||
    a.consecutive - b.consecutive
  );
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/lib/schedule/spacing.test.ts -t compareIceOutcome`
Expected: PASS, 5 tests.

- [ ] **Step 5: Write the failing agreement test**

This is the load-bearing test of the task: selection must optimise exactly what the report publishes, or the generator silently chases a different target than it prints.

```ts
import { assignNights } from "./assignNights";
import { buildBalancedPairings } from "./roundRobin";
import { enumerateNights } from "./capacity";
import { iceOutcome } from "./spacing";

describe("iceOutcome", () => {
  it("agrees with spacingReport on a generated season", () => {
    const ts = Array.from({ length: 8 }, (_, i) => `t${i + 1}`);
    const ns = enumerateNights("2026-09-10", {
      weekdays: new Set([1, 4]),
      slotTimes: ["19:00", "20:15", "21:30"],
      excluded: new Set(["2026-12-21", "2026-12-24", "2026-12-28", "2026-12-31", "2027-03-04"]),
      maxNights: 48,
    });
    const { report, slotOf, pairsByNight, weekdayOfNight } =
      assignNights(buildBalancedPairings(ts, 36), ns, ts);
    const out = iceOutcome({ teamCount: 8, pairsByNight, slotOf, weekdayOfNight });

    expect(out.weekdaySpread).toBe(report.spacing.slotWeekdaySpread);
    expect(out.streak3).toBe(report.spacing.slotStreak3);
    expect(out.consecutive).toBe(report.spacing.slotConsecutive);
    const seasonSpread = report.slotShareByTeam.reduce(
      (a, s) => a + (Math.max(...s.counts) - Math.min(...s.counts)),
      0,
    );
    expect(out.seasonSpread).toBe(seasonSpread);
  });
});
```

⚠️ `assignNights` does **not** currently return `slotOf`, `pairsByNight` or `weekdayOfNight`. Step 7 adds them. If you prefer not to widen that return type, build the three values in the test from `report` and the games instead — but the widened return is needed by Task 4 anyway, so do it here.

- [ ] **Step 6: Run it to verify it fails**

Run: `npx vitest run src/lib/schedule/spacing.test.ts -t "agrees with spacingReport"`
Expected: FAIL — `iceOutcome is not a function`, then a type error on the destructured fields.

- [ ] **Step 7: Implement `iceOutcome` and widen the `assignNights` return**

In `spacing.ts`:

```ts
/**
 * The four ice-time numbers, computed straight from a slot assignment rather
 * than from placed games — so Phase S can rank candidates without building a
 * season for each one. Definitions are kept identical to `spacingReport`'s and
 * a test asserts they agree; change both together or neither.
 */
export function iceOutcome(opts: {
  teamCount: number;
  pairsByNight: [number, number][][];
  slotOf: number[][];
  weekdayOfNight?: number[];
}): IceOutcome {
  const { teamCount, pairsByNight, slotOf, weekdayOfNight } = opts;
  const numSlots = Math.max(1, ...slotOf.flat().map((s) => s + 1));
  const wds = weekdayOfNight ?? pairsByNight.map(() => 0);
  const usedW = [...new Set(wds)].sort((a, b) => a - b);
  const wIndex = new Map(usedW.map((d, i) => [d, i]));

  // Each team's slots in chronological night order — night indexes are already
  // chronological, which is the same assumption `spacingReport` makes.
  const seq: number[][] = Array.from({ length: teamCount }, () => []);
  const seqW: number[][] = Array.from({ length: teamCount }, () => []);
  pairsByNight.forEach((pairs, n) => {
    pairs.forEach(([a, b], gi) => {
      const s = slotOf[n][gi];
      for (const t of [a, b]) {
        seq[t].push(s);
        seqW[t].push(wIndex.get(wds[n])!);
      }
    });
  });

  let seasonSpread = 0;
  let weekdaySpread = 0;
  let streak3 = 0;
  let consecutive = 0;
  for (let t = 0; t < teamCount; t++) {
    const s = seq[t];
    if (s.length === 0) continue;
    const season = new Array(numSlots).fill(0);
    for (let i = 0; i < s.length; i++) {
      season[s[i]]++;
      if (i > 0 && s[i] === s[i - 1]) consecutive++;
      if (i > 1 && s[i] === s[i - 1] && s[i] === s[i - 2]) streak3++;
    }
    seasonSpread += Math.max(...season) - Math.min(...season);
    for (let d = 0; d < usedW.length; d++) {
      const c = new Array(numSlots).fill(0);
      for (let i = 0; i < s.length; i++) if (seqW[t][i] === d) c[s[i]]++;
      weekdaySpread += Math.max(...c) - Math.min(...c);
    }
  }
  return { seasonSpread, weekdaySpread, streak3, consecutive };
}
```

In `assignNights.ts`, add `slotOf`, `pairsByNight` and `weekdayOfNight` to the object the entry point returns (they are already in scope at the return — `slotOf` from the `assignSlots` call at `assignNights.ts:1395`, `matched.pairsByNight`, and `meta.nightW`). Extend the return type alongside `games` and `report`.

- [ ] **Step 8: Run it to verify it passes**

Run: `npx vitest run src/lib/schedule/spacing.test.ts`
Expected: PASS, all tests in the file.

- [ ] **Step 9: Full verification and commit**

Run: `npx vitest run && npm run lint && npx tsc --noEmit`
Expected: **214 pass** (this task adds 6, so **220**), lint clean, tsc clean.

```bash
git add src/lib/schedule/spacing.ts src/lib/schedule/spacing.test.ts src/lib/schedule/assignNights.ts
git commit -m "feat: rank ice-time outcomes lexicographically instead of by blended cost"
```

---

### Task 2: Restore the one-off repair's never-worse guarantee

**Files:**
- Modify: `vitest.config.ts:16`
- Modify: `src/lib/schedule/oneOff.ts` (near the plan assembly at `oneOff.ts:688-710`)
- Test: `src/lib/schedule/oneOff.test.ts:239` (existing test — currently masked)

**Interfaces:**
- Consumes: `compareIceOutcome`, `IceOutcome` from Task 1.
- Produces: no new exports. `planOneOff`'s returned `plans` array gains the guarantee that every non-`no-repair` plan is `<=` the `no-repair` baseline under `compareIceOutcome`.

**Why this is a real defect, not a test artifact:** `oneOff.ts:613` gives its own search a hardcoded 600 ms, so this is not about repair budget. What changes is the *season being repaired*: the fixture is generated by running a full season through `assignNights`, which uses the env budget. At 400 ms the fixture hides the violation; at production's 5000 ms it surfaces. Production generates seasons at 5000 ms, so the seasons the repair meets in production are the ones that expose it.

- [ ] **Step 1: Unmask the failing test**

Edit `vitest.config.ts:16`, changing the slot budget from `"400"` to `"5000"`, and replace the comment above it:

```ts
    // Phase S is measured at the budget production actually uses. A shorter
    // budget here once hid a real defect: the one-off repair could return a plan
    // worse than leaving the season alone, and the test only passed because the
    // fixture it built was a 400 ms season.
    env: {
      OBHL_SLOT_BUDGET_MS: "5000",
      OBHL_SLOT_RESTARTS: "2000",
    },
```

- [ ] **Step 2: Run the suite to verify exactly one test now fails**

Run: `npx vitest run`
Expected: **1 failed**, in `oneOff.test.ts > planOneOff > holds the per-weekday ice split rather than chasing the season total`, reading `AssertionError: expected 15 to be less than or equal to 13`. The exact numbers will differ once Task 1's changes are in; what must hold is that this is the *only* failure. If others fail, stop and report — that is new information this plan did not predict.

- [ ] **Step 3: Add the guard**

In `oneOff.ts`, where the repair plans are assembled (each already carries `slotSpreadAfter` and `spacingAfter`), drop any plan that loses to the baseline. Add near the top of the file:

```ts
import { compareIceOutcome, type IceOutcome } from "./spacing";

/** A plan's ice-time result, in the shape `compareIceOutcome` ranks. */
const outcomeOf = (p: { slotSpreadAfter: number; spacingAfter: SpacingReport }): IceOutcome => ({
  seasonSpread: p.slotSpreadAfter,
  weekdaySpread: p.spacingAfter.slotWeekdaySpread,
  streak3: p.spacingAfter.slotStreak3,
  consecutive: p.spacingAfter.slotConsecutive,
});
```

Then, after the plans array is built and before it is returned:

```ts
// A repair that leaves the season worse on ice time than doing nothing is not a
// repair. The search descends on a blended scalar, which can trade the season
// share for a gain elsewhere, so filter on the ranked metrics the UI reports.
const baselinePlan = plans.find((p) => p.id === "no-repair");
const kept = baselinePlan
  ? plans.filter(
      (p) =>
        p.id === "no-repair" ||
        compareIceOutcome(outcomeOf(p), outcomeOf(baselinePlan)) <= 0,
    )
  : plans;
```

Return `kept` in place of `plans`.

⚠️ `oneOff.test.ts:263` asserts `repairs.length` is greater than 0. If the filter removes every repair on that fixture, the guard is too strict for a plan the user still needs offered — in that case keep the plan but mark it, rather than dropping it, and adjust the test to assert the marking. Do not weaken the never-worse assertion itself.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/lib/schedule/oneOff.test.ts`
Expected: PASS, all tests in the file.

- [ ] **Step 5: Full verification and commit**

Run: `npx vitest run && npm run lint && npx tsc --noEmit`
Expected: **220 pass**, lint clean, tsc clean.

```bash
git add vitest.config.ts src/lib/schedule/oneOff.ts
git commit -m "fix: never offer a one-off repair worse than leaving the season alone"
```

---

### Task 3: Make `STREAK3_W` a per-call option

**Files:**
- Modify: `src/lib/schedule/slots.ts:64` (the constant) and `slots.ts:198-210` (the options destructure)
- Test: `src/lib/schedule/matchups.test.ts` (the `describe("assignSlots weekday split")` block)

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `SlotOptions` gains `streak3W?: number`, defaulting to 160. `assignSlots(opts)` signature is otherwise unchanged.

This task is a pure refactor — **no behaviour change, no metric moves.**

- [ ] **Step 1: Write the failing test**

Add to the `describe("assignSlots weekday split")` block in `matchups.test.ts`:

```ts
it("takes the three-game-run weight as an option", () => {
  // 140 reaches a flat per-weekday split on the reference cadence where the
  // default 160 leaves a spread of 8. Asserted as a difference, not as two
  // fixed numbers: the point is that the option reaches the search.
  const wd = Array.from({ length: 28 }, (_, n) => [1, 4][n % 2]);
  const a = run(wd, { streak3W: 140 });
  const b = run(wd, { streak3W: 160 });
  expect(a.aware.weekdaySpread).not.toBe(b.aware.weekdaySpread);
});
```

Read the existing `run()` helper in that file first and thread an options argument through it; it currently builds `assignSlots` options internally.

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/lib/schedule/matchups.test.ts -t "takes the three-game-run weight"`
Expected: FAIL — a type error on `streak3W`, or both values identical because the option is ignored.

- [ ] **Step 3: Thread the option through**

In `slots.ts`, rename the constant to a default and read the override from options. **The default stays 160** — this task changes no behaviour; Task 4 is what introduces 140, as one candidate among several. Keep the whole existing doc comment above it.

```ts
/** Default for `SlotOptions.streak3W`. */
const STREAK3_W_DEFAULT = 160;
```

Add to `SlotOptions`:

```ts
  /**
   * Charge on the third-and-later game of a run in one ice time. Defaults to
   * `STREAK3_W_DEFAULT`. Exposed because no single value is best across
   * cadences — `assignNights` runs several and ranks the results.
   */
  streak3W?: number;
```

Destructure it at `slots.ts:198-210` as `streak3W = STREAK3_W_DEFAULT`, and replace every use of `STREAK3_W` in the cost functions with `streak3W`. There is one use, at the `streak += STREAK3_W` line inside `teamCost`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/lib/schedule/matchups.test.ts`
Expected: PASS, all tests in the file.

- [ ] **Step 5: Full verification and commit**

Run: `npx vitest run && npm run lint && npx tsc --noEmit`
Expected: **221 pass**, lint clean, tsc clean. Every metric must be unchanged from Task 2 — this is a refactor.

```bash
git add src/lib/schedule/slots.ts src/lib/schedule/matchups.test.ts
git commit -m "refactor: make the three-game-run weight a per-call option"
```

---

### Task 4: Run Phase S at k weights and keep the best

**Files:**
- Modify: `src/lib/schedule/assignNights.ts:1395-1402` (the `assignSlots` call)
- Test: `src/lib/schedule/assignNights.test.ts` (the reference-season describe block)

**Interfaces:**
- Consumes: `compareIceOutcome`, `iceOutcome` from Task 1; `SlotOptions.streak3W` from Task 3.
- Produces: no new exports. `assignNights` behaviour changes: ice-time metrics become the best of the candidate set.

- [ ] **Step 1: Write the failing test**

In the reference-season block of `assignNights.test.ts`, replace the goal-3 assertion (currently `expect(report.spacing.slotWeekdaySpread).toBeLessThanOrEqual(12)`) with:

```ts
it("goal 3: shares each ice time evenly within each weekday too", () => {
  // Best-of-k reaches a perfectly flat per-weekday split on this cadence: every
  // one of the 16 team-weekday cells reads exactly 6-6-6. Reached by the 140
  // candidate; the 160 candidate alone reads 8 and is kept in the set so the
  // result can never be worse than what shipped before.
  expect(report.spacing.slotWeekdaySpread).toBe(0);
  // The season share is untouched by the trade — asserted above as 12/12/12.
  expect(report.spacing.slotStreak3).toBe(0);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/lib/schedule/assignNights.test.ts -t "goal 3"`
Expected: FAIL — `expected 8 to be 0`.

- [ ] **Step 3: Implement best-of-k**

Replace the single `assignSlots` call at `assignNights.ts:1395`:

```ts
/**
 * Phase S weights to try, best result kept. No single value wins everywhere:
 * on the reference cadence 140 reaches a flat weekday split where 160 leaves 8,
 * and on Mon/Wed/Fri 160 wins by 4. Measured 2026-08-12. 160 stays in the set so
 * the outcome can never be worse than the single-weight version that shipped.
 *
 * Cost is linear — each candidate gets the full slot budget.
 */
const SLOT_WEIGHTS = [160, 140];

const slotArgs = {
  teamCount: T,
  pairsByNight: matched.pairsByNight,
  slotsPerNight: nights.map((n) => n.slots.length),
  weekdayOfNight: meta.nightW,
  restarts: SLOT_RESTARTS,
  timeBudgetMs: SLOT_BUDGET_MS,
};

let slotOf = assignSlots({ ...slotArgs, streak3W: SLOT_WEIGHTS[0] });
let bestOutcome = iceOutcome({
  teamCount: T,
  pairsByNight: matched.pairsByNight,
  slotOf,
  weekdayOfNight: meta.nightW,
});
for (const w of SLOT_WEIGHTS.slice(1)) {
  const cand = assignSlots({ ...slotArgs, streak3W: w });
  const out = iceOutcome({
    teamCount: T,
    pairsByNight: matched.pairsByNight,
    slotOf: cand,
    weekdayOfNight: meta.nightW,
  });
  if (compareIceOutcome(out, bestOutcome) < 0) {
    slotOf = cand;
    bestOutcome = out;
  }
}
```

Add `iceOutcome` and `compareIceOutcome` to the existing `./spacing` import.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/lib/schedule/assignNights.test.ts`
Expected: PASS. `slotWeekdaySpread` is 0, `slotStreak3` is 0, season share still 12/12/12, all four rematch metrics still 0.

- [ ] **Step 5: Re-baseline the ice-time repeats assertion**

`slotConsecutive` rises when the 140 candidate wins (48 against 46 on the reference season) because it is the lowest-priority term. The existing bound is `toBeLessThanOrEqual(55)`, which still holds — confirm rather than change it. If it fails, do **not** raise the bound without first checking that season share and weekday spread are still at 0; a rise in repeats alongside a regression elsewhere means the comparator is wrong, not the bound.

- [ ] **Step 6: Full verification and commit**

Run: `npx vitest run && npm run lint && npx tsc --noEmit`
Expected: **221 pass**, lint clean, tsc clean.

Generation time roughly doubles, to ~11.5 s for the reference season — 2 candidates × ~5.76 s, plus ~500 ms for the rest of the pipeline. This is the intended trade.

```bash
git add src/lib/schedule/assignNights.ts src/lib/schedule/assignNights.test.ts
git commit -m "feat: run Phase S at several weights and keep the best-ranked result"
```

---

### Task 5: Update the handoff and the weight's own note

**Files:**
- Modify: `SCHEDULE_HANDOFF.md` §1, §3, §4, §5
- Modify: `src/lib/schedule/slots.ts` (the `STREAK3_W_DEFAULT` comment block)

**Interfaces:** none — documentation only.

⚠️ `SCHEDULE_HANDOFF.md` currently carries two bullets written on 2026-08-12 that this work supersedes: the G3 bullet claiming spread 8 is kept for budget fragility, and the `STREAK3_W` bullet listing the swept series. Both must be **replaced, not appended to** — leaving the old text beside the new is how this file has gone stale before.

- [ ] **Step 1: Update §1's outcome table**

`slotWeekdaySpread` (G3) becomes **0**, `slotConsecutive` becomes **48**, generate time becomes **~11.5 s**. Leave every other row alone.

- [ ] **Step 2: Rewrite §5's two ice-time bullets as one**

Replace both with a bullet saying: no single `STREAK3_W` is best across cadences (140 wins the reference by 8, 160 wins Mon/Wed/Fri by 4, 144–152 are strictly worse than both); `assignNights` therefore runs the set and ranks with `compareIceOutcome`; 160 stays in the set so the result can never be worse than the single-weight version. State that the weight is **no longer load-bearing**, which retires the old "do not tune it on one fixture" hazard.

- [ ] **Step 3: Add a §5 bullet for the ranking itself**

Record that ice-time selection is lexicographic on season share ▸ per-weekday share ▸ `slotStreak3` ▸ `slotConsecutive`, that `compareIceOutcome` is the one place to change it, and why season share leads — a blended scalar twice preferred candidates that broke the 12/12/12 share, and this structurally cannot.

- [ ] **Step 4: Update §3 and §4**

§3: Phase S now runs k times. §4: generate time ~11.5 s, of which ~10 s is Phase S; correct the stale "grinding ice-time repeats down" phrasing if it still reads as a single pass.

- [ ] **Step 5: Update the weight's note in `slots.ts`**

The block above `STREAK3_W_DEFAULT` should stop presenting 160 as a tuned value and instead say it is one candidate of several, pointing at `SLOT_WEIGHTS` in `assignNights.ts`. Keep the derivation of the 120 threshold — it still explains the floor.

- [ ] **Step 6: Full verification and commit**

Run: `npx vitest run && npm run lint && npx tsc --noEmit`
Expected: **221 pass**, lint clean, tsc clean.

```bash
git add SCHEDULE_HANDOFF.md src/lib/schedule/slots.ts
git commit -m "docs: record best-of-k Phase S selection and the ranking it uses"
```

---

## Out of scope

- **G2 (`pairingWeekdayExcess`, at 8).** Phase M, a different search, a different fix. Brief at `~/.claude/plans/g2-pairing-weekday-split.md`.
- **The Mon/Wed/Fri guard at `matchups.test.ts:544`.** Best-of-k keeps 160 in the set, so that cadence should still read 24 and the guard should still pass untouched. If it does not, that is a genuine surprise — stop and report rather than re-baselining it.
- **Parallelising the k runs.** Linear cost is acceptable today. Revisit only if generation time becomes a complaint.
