# Schedule Variations Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the ice-time clustering feature actually reach production, and give a manager a way to ask for a different schedule without downgrading their own.

**Architecture:** Two independent changes. (1) Phase S's restart count drops from 20,000 to 1,000 and the test config stops overriding it, so CI and production run the same search — this alone takes the reporting league's worst-team clustering from 13 to 4. (2) `assignNights` gains a seed, and generates a *variation* as the best of a block of seeds ranked by the existing `rankSchedule`, surfaced as a "Try a different schedule" button.

**Tech Stack:** TypeScript, Next.js App Router server actions, Vitest, Playwright.

**Spec:** `docs/superpowers/specs/2026-09-09-schedule-variations-design.md`

## Global Constraints

- **Never lower an assertion to make a test pass.** Every quality bound in
  `src/lib/schedule/*.test.ts` was measured. If one goes red, the change is
  wrong, not the bound. Raise a *timeout* freely; never a bound.
- **Assert on `scheduledAt`, not on `report`.** `scheduledAt` is the only
  positional field persisted (`src/lib/actions/schedule.ts` writes
  `scheduled_at`; `nightIndex`/`slotIndex` are in-memory scratch). A feature has
  already shipped in this repo that passed 364 tests while writing nothing.
- **The suite must run at the production default.** After Task 1 no test may
  set `OBHL_SLOT_RESTARTS`, in the environment or in `vitest.config.ts`. That
  divergence is the bug this plan fixes; re-introducing it anywhere voids every
  assertion downstream.
- **Phase S is wall-clock bounded as well as restart bounded.** A single green
  run proves nothing about a bound. Where a task adds a quality assertion, run
  that file 3x before calling it done.
- **Do not run the full e2e suite locally.** CI runs it on the PR.
- **Run long suites in the FOREGROUND with a long timeout.** Do not background a
  test run and then stop with nothing to do.

---

### Task 1: Make the suite run production's Phase S search

**Files:**
- Modify: `src/lib/schedule/assignNights.ts:149` (`SLOT_RESTARTS`)
- Modify: `vitest.config.ts:29-33` (the `env` block)
- Test: `src/lib/schedule/assignNights.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: a generator whose default Phase S search is 1,000 restarts. Tasks 2-4 measure against this; their numbers are meaningless at any other value.

**Why 1,000:** measured sweep in the spec §2. 500/1,000/2,000 all return
identical schedules on both reference leagues; 250 degrades back-to-backs 6 -> 8;
4,000+ collapses worst-team clustering to 13. 1,000 is the geometric centre of
the good band.

- [ ] **Step 1: Write the guard test**

In `src/lib/schedule/assignNights.test.ts`, at the top level after the imports:

```ts
// ⛔ THE SUITE MUST RUN THE SEARCH PRODUCTION RUNS. `vitest.config.ts` used to
// pin OBHL_SLOT_RESTARTS to 2000 while `assignNights.ts` defaulted to 20000, so
// every quality bound below was a claim about a program nobody ran: at 20000 the
// two ice-time clustering tests in this file fail with "expected 13 to be less
// than or equal to 6". Measured 2026-09-09; see
// `docs/superpowers/specs/2026-09-09-schedule-variations-design.md` §1.
//
// A test config may raise a TIMEOUT. It may not override a constant that shapes
// the search.
it("runs Phase S at the production default, not a test-only one", () => {
  expect(process.env.OBHL_SLOT_RESTARTS).toBeUndefined();
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/lib/schedule/assignNights.test.ts -t "production default"`
Expected: FAIL — `expected '2000' to be undefined`.

- [ ] **Step 3: Remove the override and lower the default**

In `vitest.config.ts`, delete the `OBHL_SLOT_RESTARTS` line from the `env`
block, leaving `OBHL_SLOT_BUDGET_MS` (which matches the production default and
so diverges from nothing). Replace the block's explanatory comment's second
paragraph — the one beginning "Overridable from the environment so slower
hardware (CI) has a lever" — with:

```ts
    // ⛔ DO NOT ADD `OBHL_SLOT_RESTARTS` BACK. It was pinned to 2000 here while
    // `assignNights.ts` defaulted to 20000, and the two ice-time clustering
    // tests pass at 2000 and fail at 20000. Every quality bound in the schedule
    // suite was a claim about a search production did not run. The restart
    // count now lives in one place: `SLOT_RESTARTS` in `assignNights.ts`.
    // `assignNights.test.ts` asserts this variable is unset.
    //
    // `OBHL_SLOT_BUDGET_MS` stays: it is set to the production default, so it
    // documents rather than diverges.
    env: {
      OBHL_SLOT_BUDGET_MS: process.env.OBHL_SLOT_BUDGET_MS ?? "5000",
    },
```

In `src/lib/schedule/assignNights.ts:149`, change the constant and give it the
measurement:

```ts
/**
 * Phase S restart count. **1,000, and not more** — this search is
 * non-monotonic, and more of it returns a worse schedule.
 *
 * Measured 2026-09-09 on 6 teams / one weeknight / 3 sheets / 23 weeks,
 * worst-team clustered windows by restart count:
 *
 *   250 -> 6 (and back-to-backs 6 -> 8)   500 -> 4   1,000 -> 4   2,000 -> 4
 *   4,000 -> 13   8,000 -> 10   20,000 -> 13
 *
 * It is NOT the 5 s budget truncating the sweep: given a 60 s budget so it
 * completes, 4,000 still returns 13. The cause (a reading, not a measurement) is
 * that `compareIceOutcome` picks among `SLOT_CANDIDATES` without seeing
 * clustering at all, so a better-searched candidate wins its own comparator from
 * a basin the night-order post-pass cannot permute out of.
 *
 * 1,000 is the geometric centre of the measured-good band [500, 2,000]; all
 * three return identical schedules on both reference leagues. The 8-team
 * reference league is unchanged at every value from 500 to 20,000.
 */
const SLOT_RESTARTS = envInt("OBHL_SLOT_RESTARTS", 1_000);
```

- [ ] **Step 4: Run the guard test and the clustering tests**

Run: `npx vitest run src/lib/schedule/assignNights.test.ts`
Expected: PASS, including `keeps no team far worse off than the rest on ice time`
(`slotClusterWorstTeam <= 6`) and `delivers that clustering through scheduledAt`.
These are the two that fail today at the production default.

- [ ] **Step 5: Run the whole schedule suite three times**

Run: `npx vitest run src/lib/schedule` — three times, foreground.
Expected: green all three. Report the wall-clock of each; the suite should get
faster, not slower.

If any *other* file's bound goes red, STOP and report it — do not adjust the
bound. It means 1,000 restarts changed a league this plan did not measure.

- [ ] **Step 6: Commit**

```bash
git add src/lib/schedule/assignNights.ts vitest.config.ts src/lib/schedule/assignNights.test.ts
git commit -m "fix(schedule): run the Phase S search production runs

vitest.config.ts pinned OBHL_SLOT_RESTARTS=2000 while assignNights.ts
defaulted to 20000. At 20000 the ice-time clustering feature's own two
tests fail (expected 13 to be less than or equal to 6), so #62 shipped a
feature that worked only at CI's restart count.

Phase S is non-monotonic: 500/1000/2000 all reach worst-team 4, and
4000+ collapses to 13 even given 12x the time budget. Defaults to 1000,
the centre of the measured-good band, and the suite now runs it."
```

---

### Task 2: Thread a seed through every phase

**Files:**
- Modify: `src/lib/schedule/assignNights.ts` (`AssignOptions`, and four call sites)
- Test: `src/lib/schedule/assignNights.test.ts`

**Interfaces:**
- Consumes: Task 1's `SLOT_RESTARTS = 1_000`.
- Produces: `AssignOptions.seed?: number` (default 1). Task 3 calls `assignNights` with successive integers here.

**Measured:** six seeds gave six distinct schedules at both 1,000 and 20,000
restarts (spec §4). Phase M's seed alone is a proven dead lever — varying it
changes nothing, because Phase M re-derives its cycle — so the seed MUST reach
Phase P, Phase S and the night-order pass, not just Phase M.

- [ ] **Step 1: Write the failing test**

```ts
// Six seeds gave six distinct schedules when this was measured (spec §4).
// Two is all this needs to assert: that the lever is connected at all.
//
// ⛔ Compares `scheduledAt`, the only field that is persisted. Comparing
// `nightIndex` would pass against a generator that changed nothing a manager
// can see — the exact failure mode of the first clustering attempt.
describe("assignNights — seeds produce different schedules", () => {
  const ts = teams(6);
  const ns = enumerateNights("2026-09-08", {
    weekdays: new Set([2]),
    slotTimes: ["19:00", "20:15", "21:30"],
    excluded: new Set<string>(),
    maxNights: 23,
  });
  const pairings = buildBalancedPairings(ts, 23);
  const stamps = (seed: number) =>
    assignNights(pairings, ns, ts, { seed })
      .games.map((g) => `${g.home}|${g.away}|${g.scheduledAt}`)
      .sort()
      .join("\n");

  it("returns the same schedule for the same seed", () => {
    expect(stamps(1)).toBe(stamps(1));
  });

  it("returns a different schedule for a different seed", () => {
    expect(stamps(2)).not.toBe(stamps(1));
  });

  it("defaults to seed 1", () => {
    const bare = assignNights(pairings, ns, ts)
      .games.map((g) => `${g.home}|${g.away}|${g.scheduledAt}`)
      .sort()
      .join("\n");
    expect(bare).toBe(stamps(1));
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/lib/schedule/assignNights.test.ts -t "seeds produce"`
Expected: FAIL — `returns a different schedule for a different seed`, because
`seed` is ignored today, so the two strings are equal. (`same seed` and
`defaults to seed 1` will already pass; that is fine, they are the controls.)

- [ ] **Step 3: Add the option and thread it**

In `AssignOptions` (`assignNights.ts:115`):

```ts
/** Everything `assignNights` takes beyond the pairings and the calendar. */
export type AssignOptions = {
  /** Manager constraints, already resolved against these exact nights. */
  constraints?: ResolvedConstraints;
  /**
   * Which of the equally-valid schedules to return. Default 1, and the default
   * MUST stay 1 — a season regenerated without this option has to come back
   * byte-identical, which is the promise `PLATEAU_SEEDS` documents.
   *
   * Offsets every phase's PRNG by `(seed - 1) * 1000`, a stride wider than any
   * phase's own seed list so two variations never share a draw. Phase M's seed
   * alone is a dead lever — it re-derives its cycle and returns the same answer
   * for every seed — so this has to reach Phase P, Phase S and the night-order
   * pass to move anything.
   */
  seed?: number;
};
```

Inside `assignNights`, next to `const resolved = ...`:

```ts
  const seedOffset = ((options?.seed ?? 1) - 1) * 1000;
```

`seedOffset` then has to reach four places. Three are inside
`planByParticipation`, so add a `seedOffset: number` parameter to it and pass
`seedOffset` at its call site in `assignNights`:

1. `let part = solve(300, PLATEAU_SEEDS[0] + seedOffset);`
2. `const better = solve(4_000, PLATEAU_SEEDS[0] + seedOffset);`
3. `for (const seed of PLATEAU_SEEDS.slice(1).map((s) => s + seedOffset)) {`
4. in the `assignMatchups({...})` call, add `seed: 1 + seedOffset,`
5. `let slotOf = assignSlots({ ...slotArgs, ...SLOT_CANDIDATES[0], seed: SLOT_CANDIDATES[0].seed + seedOffset });`
6. `const trial = assignSlots({ ...slotArgs, ...cand, seed: cand.seed + seedOffset });`

The fourth place is in `assignNights` itself — the `improveNightOrder` call
(~line 1947). Its third argument is `opts`:

```ts
    }, { seed: 1 + seedOffset });
```

⚠️ Do NOT change `restarts` or `steps` there. They are tuned to a measured
cliff — 1,500 steps reaches worst-team 4 and 1,000 reaches 8, with nothing in
between (`2026-09-09-ice-time-clustering-design.md`).

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/lib/schedule/assignNights.test.ts -t "seeds produce"`
Expected: PASS, all three.

- [ ] **Step 5: Run the schedule suite**

Run: `npx vitest run src/lib/schedule`
Expected: green. `seed` defaults to 1 and `seedOffset` to 0, so every existing
assertion must be unchanged. **If anything moved, the default is not 0 somewhere
— fix that, do not adjust the test.**

- [ ] **Step 6: Commit**

```bash
git add src/lib/schedule/assignNights.ts src/lib/schedule/assignNights.test.ts
git commit -m "feat(schedule): let a caller ask for a different schedule

AssignOptions.seed offsets every phase PRNG by (seed-1)*1000. Six seeds
gave six distinct schedules when measured. Phase M's seed alone is a dead
lever, so the offset reaches Phase P's plateau sweep, the five Phase S
candidates and the night-order pass too. Default 1 leaves every existing
schedule byte-identical."
```

---

### Task 3: A variation is the best of a block of seeds

**Files:**
- Modify: `src/lib/schedule/assignNights.ts` (rename the body, add the wrapper)
- Test: `src/lib/schedule/assignNights.test.ts`

**Interfaces:**
- Consumes: `AssignOptions.seed` from Task 2.
- Produces: `AssignOptions.variations?: number`, and `variationsFor(gameCount: number): number` (not exported). `assignNights` keeps its exact current return type.

**Why not a blind reroll:** measured, variations 3 and 6 are *worse* than
variation 1 on worst-team clustering (13 and 10 against 4). A button that can
silently downgrade the manager is the thing that sends them back to hand-editing.

- [ ] **Step 1: Write the failing test**

```ts
// A variation is the best of a block of seeds, ranked by `rankSchedule` — the
// same lexicographic comparator the planner rank-off uses, whose last two
// entries are the clustering terms. That is the ONLY place clustering can enter
// selection: Phase S's own `compareIceOutcome` cannot see it, which is why more
// Phase S search returns worse clustering (spec §2).
describe("assignNights — a variation is the best of its block", () => {
  const ts = teams(6);
  const ns = enumerateNights("2026-09-08", {
    weekdays: new Set([2]),
    slotTimes: ["19:00", "20:15", "21:30"],
    excluded: new Set<string>(),
    maxNights: 23,
  });
  const pairings = buildBalancedPairings(ts, 23);

  it("is no worse than any single seed in its block", () => {
    const best = assignNights(pairings, ns, ts, { variations: 4 });
    for (const seed of [1, 2, 3, 4]) {
      const one = assignNights(pairings, ns, ts, { seed, variations: 1 });
      expect(best.report.spacing.slotClusterWorstTeam).toBeLessThanOrEqual(
        one.report.spacing.slotClusterWorstTeam,
      );
    }
  }, 120_000);

  it("variation 2 draws a different block than variation 1", () => {
    const stamps = (v: number) =>
      assignNights(pairings, ns, ts, { seed: v, variations: 4 })
        .games.map((g) => g.scheduledAt)
        .sort()
        .join("|");
    expect(stamps(2)).not.toBe(stamps(1));
  }, 120_000);

  it("a constrained season takes one draw, not a block", () => {
    // The night-order pass is gated off when constraints exist, so no seed in a
    // block can differ on clustering repair — selecting over four would cost 4x
    // the time for nothing. Same fixture as the pinned-slot test in
    // constraints.test.ts.
    const resolved = resolveConstraints(
      [{ kind: "slot_on", team: ts[0], date: "2026-09-08", time: "19:00" }],
      { nights: ns, teamIds: ts },
    );
    const t0 = Date.now();
    assignNights(pairings, ns, ts, { constraints: resolved, variations: 4 });
    const constrainedMs = Date.now() - t0;
    const t1 = Date.now();
    assignNights(pairings, ns, ts, { constraints: resolved, variations: 1 });
    const oneMs = Date.now() - t1;
    // Collapsed to one draw, so within a factor of two of a single generate
    // rather than four times it.
    expect(constrainedMs).toBeLessThan(oneMs * 2);
  }, 120_000);
});
```

Add `resolveConstraints` to the file's imports from `./constraints` if it is not
already there.

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/lib/schedule/assignNights.test.ts -t "best of its block"`
Expected: FAIL — `variations` is not a recognised option, so all three calls
return the seed-1 schedule and `variation 2 draws a different block` fails.

- [ ] **Step 3: Rename the body and add the wrapper**

Rename the existing exported `assignNights` function to `assignNightsOnce` and
drop `export` from it. Leave its body **completely unchanged**. Then add, in its
place:

```ts
/**
 * How many seeds a variation is chosen from, keyed on game count — the same
 * signal `ilsRestartsFor` uses, so this is a function of the input and never of
 * the clock. A clock-sized N would make the schedule hardware-dependent, which
 * is the bug this file's `SLOT_RESTARTS` note exists about.
 *
 * The 8-team reference league (144 games) gets 1: measured, it takes NOTHING
 * from the night-order pass — worst-team 17 and 94 windows with the pass running
 * and unconstrained, identical at every restart count from 500 to 20,000 — so
 * ranking four draws on clustering would spend 4x the time to pick between four
 * identical-quality schedules.
 *
 * At <= 80 games a generate is ~6.6 s, so four is ~26 s: the SAME wall clock the
 * manager waited before `SLOT_RESTARTS` dropped.
 */
function variationsFor(gameCount: number): number {
  if (gameCount <= 80) return 4;
  if (gameCount <= 120) return 2;
  return 1;
}

export function assignNights(
  pairings: Pairing[],
  nights: Night[],
  teamIds: string[],
  options?: AssignOptions,
): ReturnType<typeof assignNightsOnce> {
  const resolved = options?.constraints ?? noConstraints();
  // Gate 1: a constrained season gets no night-order repair on ANY seed, so a
  // block would cost 4x for no product difference.
  // Gate 2: an explicit `variations` from the caller wins, so the retry loop in
  // `generateSchedule` can force 1 on its degraded path.
  const n = Math.max(
    1,
    options?.variations ??
      (resolved.empty ? variationsFor(pairings.length) : 1),
  );
  const base = options?.seed ?? 1;
  if (n === 1) return assignNightsOnce(pairings, nights, teamIds, options);

  const meta = buildMeta(nights);
  let best = assignNightsOnce(pairings, nights, teamIds, {
    ...options,
    seed: (base - 1) * n + 1,
  });
  let bestRank = rankFromReport(
    { games: best.games, unscheduled: best.report.unscheduled },
    best.report.spacing,
    teamIds,
    meta,
  );
  for (let i = 1; i < n; i++) {
    const trial = assignNightsOnce(pairings, nights, teamIds, {
      ...options,
      seed: (base - 1) * n + 1 + i,
    });
    const rank = rankFromReport(
      { games: trial.games, unscheduled: trial.report.unscheduled },
      trial.report.spacing,
      teamIds,
      meta,
    );
    if (rankLess(rank, bestRank)) {
      best = trial;
      bestRank = rank;
    }
  }
  return best;
}
```

Add `variations?: number` to `AssignOptions`:

```ts
  /**
   * How many seeds to draw this variation from, best-of by `rankSchedule`.
   * Omitted means "decide from the game count and the constraint set" — pass an
   * explicit 1 to force a single draw on a degraded path.
   */
  variations?: number;
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/lib/schedule/assignNights.test.ts -t "best of its block"`
Expected: PASS, all three.

- [ ] **Step 5: Prove the selection is load-bearing**

Mutation test. Temporarily invert the comparison — `if (!rankLess(rank, bestRank))` —
and re-run `-t "no worse than any single seed"`. It MUST go red. If it stays
green the assertion is not testing selection, and the test needs strengthening
before you revert the mutant.

Confirm the mutant actually applied (a missing edit exits 0 and kills nothing).
Revert it before continuing.

- [ ] **Step 6: Run the schedule suite three times**

Run: `npx vitest run src/lib/schedule` — three times, foreground.
Expected: green all three.

⚠️ Existing tests call `assignNights` with no options, so they now get
`variationsFor(pairings.length)` draws instead of one. The 6-team fixtures (69
games) get 4 and should IMPROVE or hold; the 8-team reference (144 games) gets 1
and must be byte-identical. Report the suite's wall clock — it will rise.

- [ ] **Step 7: Commit**

```bash
git add src/lib/schedule/assignNights.ts src/lib/schedule/assignNights.test.ts
git commit -m "feat(schedule): pick the best of a block of seeds

A variation is now the best of N draws ranked by rankSchedule, whose last
two entries are the clustering terms — the only place clustering can
enter selection, since Phase S's compareIceOutcome cannot see it.

N is keyed on game count so it never depends on the clock: 4 under 80
games (~26s, the wall clock managers waited before the restart fix), 1
over 120. Constrained seasons take one draw — the night-order pass is
gated off for them, so a block would cost 4x for nothing."
```

---

### Task 4: The "Try a different schedule" button

**Files:**
- Modify: `src/lib/actions/schedule.ts` (`generateSchedule`, both branches of the length-mode split)
- Modify: `src/components/manage/schedule-generate-form.tsx`
- Test: `src/lib/actions/schedule.test.ts` (create if absent) or extend the nearest existing action test
- Test: `e2e/11-schedule-builder.spec.ts`

**Interfaces:**
- Consumes: `AssignOptions.seed` and `.variations` from Tasks 2-3.
- Produces: a `variation` form field read by `generateSchedule`.

- [ ] **Step 1: Read the two `assignNights` call sites**

`src/lib/actions/schedule.ts` calls `assignNights` twice — once in the
`lengthMode === "date"` branch (~line 545) and once in the `else` branch (~line
580). Both sit inside a bounded retry loop that steps games-per-team or night
count until everything fits.

- [ ] **Step 2: Read `variation` from the form**

Next to the other `formData` reads (~line 370):

```ts
  // Which of the equally-valid schedules to show. The manager advances it with
  // "Try a different schedule"; Generate resets it to 1.
  //
  // ⚠️ NOT PERSISTED, deliberately. `seasons` has no column for it and a
  // counter does not earn a migration. The cost is that after a page reload the
  // form starts from 1 again and may re-offer a schedule the manager already
  // rejected. Capped so a hand-edited form cannot ask for an unbounded search.
  const variation = Math.max(
    1,
    Math.min(50, Math.floor(Number(formData.get("variation") ?? 1))),
  );
```

- [ ] **Step 3: Pass it at both call sites**

In BOTH branches, change the `assignNights` call to carry the seed, and force a
single draw on every retry. In the `"date"` branch the loop variable is `tries`:

```ts
      result = assignNights(pairings, nights, teamIds, {
        constraints: check.resolved,
        seed: variation,
        // ⛔ ONE DRAW ON A RETRY. This loop runs up to 8 times; a block of 4
        // inside it is up to 32 generations — minutes, and past the function
        // timeout on a large league. A retry is already the degraded path where
        // placing the games at all beats picking the prettiest of four.
        ...(tries > 0 ? { variations: 1 } : {}),
      });
```

In the `else` branch the loop variable is `extra`, stepping `0, 2, 4, …`:

```ts
      result = assignNights(pairings, nights, teamIds, {
        constraints: check.resolved,
        seed: variation,
        ...(extra > 0 ? { variations: 1 } : {}),
      });
```

- [ ] **Step 4: Add the button to the form**

In `src/components/manage/schedule-generate-form.tsx`, add a `variation` state
initialised to 1, a hidden input carrying it, and a second submit button. The
form already holds its inputs across a generate — `variation` joins them.

```tsx
const [variation, setVariation] = useState(1);
```

```tsx
<input type="hidden" name="variation" value={variation} />
```

Beside the existing submit button:

```tsx
<Button
  type="submit"
  variant="outline"
  disabled={pending}
  onClick={() => setVariation((v) => v + 1)}
>
  Try a different schedule
</Button>
```

and make the primary Generate button reset it:

```tsx
onClick={() => setVariation(1)}
```

⚠️ Both buttons submit the SAME form and the same action. The only difference is
the value of `variation` at submit time. Verify the state update lands before the
submit — React batches, so if the generated schedule does not change, set the
value from a ref or move the increment into the form's `onSubmit` keyed on which
button was clicked (`event.nativeEvent.submitter`).

- [ ] **Step 5: Verify the button actually changes the schedule**

Extend `e2e/11-schedule-builder.spec.ts`: generate a schedule, capture the first
night's rendered times, click "Try a different schedule", wait for the generate
to finish, and assert the rendered schedule differs.

⚠️ Read the file's existing timeout note first — it already documents that a
generate outruns the default Playwright expect timeout at
`OBHL_SLOT_BUDGET_MS` 5 s. Two generates in one spec need that budget twice.

⚠️ `e2e-red-step-dirties-fixture`: restore any guard you flip, and discard the
draft through the app rather than deleting rows.

- [ ] **Step 6: Run the affected specs only**

Run: `npx vitest run src/lib/actions` then
`npx playwright test e2e/11-schedule-builder.spec.ts`
Expected: green. Do NOT run the full e2e suite locally — CI runs it on the PR.

- [ ] **Step 7: Commit**

```bash
git add src/lib/actions/schedule.ts src/components/manage/schedule-generate-form.tsx e2e/11-schedule-builder.spec.ts
git commit -m "feat(schedule): add Try a different schedule

Generation is deterministic by design, so a manager who disliked a
schedule and regenerated got the identical one forever, and reaching for
a manager request instead switched the clustering pass off entirely. The
button advances the variation; Generate resets it to 1.

Not persisted — seasons has no column for a counter and it does not earn
a migration. A reload restarts the counter at 1."
```

---

## Self-Review

**Spec coverage:** §3 -> Task 1. §4 seed -> Task 2. §4 best-of-N and the two
gates -> Task 3. §4 UI -> Task 4. §7 acceptance 1-2 -> Task 1 Steps 4-5;
3 -> Task 1 Step 5 (the reference test already exists and must stay green);
4 -> Task 2 Step 1; 5 -> Task 3 Step 1; 6 -> the final review.

**Deferred by the spec and absent here, correctly:** the Phase M compound pass,
clustering inside `compareIceOutcome`, making the 8-team league benefit, the
builder-panel clustering row, persisting the variation.

**Type consistency:** `variationsFor(gameCount: number): number` is called with
`pairings.length` — `pairings` is `Pairing[]`, one per game, so that is the game
count. `rankFromReport(plan, r, teamIds, meta)` is called with a literal
`{ games, unscheduled }`, which is exactly `type Plan`. `rankLess(a, b)` and
`buildMeta(nights)` are module-private and the wrapper is in the same module.

**Known risk, flagged not hidden:** Task 3 changes what every existing
no-options `assignNights` call returns for fixtures under 80 games — from one
draw to the best of four. Bounds should improve or hold, never regress, but this
is the step most likely to move a number in another file. Task 3 Step 6 runs the
suite three times for exactly that reason.
