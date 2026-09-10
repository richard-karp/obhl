# Ice-time Spreading for Constrained Seasons — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a season that carries manager requests get the same ice-time spreading an unconstrained one gets, and show the manager the number that changed.

**Architecture:** The night-order pass is switched off whenever a request exists, because a permutation could move a pinned block off its night and `rankSchedule` cannot see that. Replace that all-or-nothing gate with per-night *class labels*: a permutation may only swap nights of the same class, which is an O(nights) test folded into a loop that already runs, rather than the per-step constraint evaluation the pass's own comment rejected. Best-of-N must be restored for constrained seasons at the same time — measured, the gate lift alone is worth 15 → 14, and the two together are worth 15 → 5.

**Tech Stack:** TypeScript, Next.js App Router, Vitest, Playwright.

**Spec:** `docs/superpowers/specs/2026-09-09-clustering-for-constrained-seasons-design.md`

## Global Constraints

- **An unconstrained season must stay byte-identical to `main`.** Removing the
  gate has to be a no-op when there are no requests. Every existing bound in
  `src/lib/schedule/*.test.ts` is the check.
- **Never lower an assertion to make a test pass.** Every bound was measured.
  Raise a *timeout* freely; never a bound.
- **Assert on `scheduledAt`,** the only positional field persisted. A feature has
  already shipped here that passed 364 tests while writing nothing.
- **Do not set `OBHL_SLOT_RESTARTS` anywhere** — not in a test, not in a config.
  `assignNights.test.ts` asserts it is unset, and the divergence it guards is
  what made the previous feature invisible in production.
- **Phase S is wall-clock bounded as well as restart bounded.** Run any file
  carrying a new quality assertion 3x before calling it done.
- **`bye_on` is infeasible on the 6-team/3-sheet fixture** — all six teams play
  every night, so no team can ever bye. Never build a constraint measurement on
  it; use `slot_on` or a `slot_bias` window.
- **`ScheduleConstraint`'s field is `teamId`, not `team_id`.** A wrong key
  resolves to `items` but to no solver entry, so `resolved.empty` stays true and
  the fixture silently tests nothing.
- **Do not run the full e2e locally.** CI runs it on the PR.
- **Run long suites in the FOREGROUND with a long timeout.**

---

### Task 1: Night classes, and the pass runs on constrained seasons

**Files:**
- Modify: `src/lib/schedule/assignNights.ts` (the `if (resolved.empty)` block around `improveNightOrder`, and the admissibility scorer inside it)
- Test: `src/lib/schedule/constraints.test.ts`

**Interfaces:**
- Consumes: `ResolvedConstraints` (`constraints.ts:100`) — `forced {team,night,plays}`, `slotPins {team,night,slot}`, `byeInWeek {team,week}`, `biases {team, nights: boolean[], prefer}`; and `smeta.week` (`NightMeta.week`, week index per night).
- Produces: a pass that runs on every season. Task 2 depends on this being in place — without it, Task 2 alone is worth nothing.

- [ ] **Step 1: Write the failing test**

In `src/lib/schedule/constraints.test.ts`, beside the existing
`"a pinned slot survives the clustering pass"` describe (which must stay green
and becomes the correctness guard for this task):

```ts
// Measured 2026-09-09: one `slot_on` pin took worst-team clustering from 4 to
// 15, because the night-order pass was switched off entirely whenever any
// request existed. Night classes let it run — a permutation may only swap nights
// of the same class, so a pinned night is a fixed point and cannot be relabelled
// out from under its pin.
//
// ⛔ NOT `bye_on`. Six teams over three sheets means all six play every night,
// so no team can ever bye and the constraint is infeasible on this fixture —
// it reports unmet in every column and measures nothing.
describe("assignNights — a constrained season still gets its ice time spread", () => {
  const ts = Array.from({ length: 6 }, (_, i) => `t${i + 1}`);
  const ns = enumerateNights("2026-09-08", {
    weekdays: new Set([2]),
    slotTimes: ["19:00", "20:15", "21:30"],
    excluded: new Set<string>(),
    maxNights: 23,
  });
  const pairings = buildBalancedPairings(ts, 23);
  const resolved = resolveConstraints(
    [c("p1", "t3", "slot_on", { date: ns[11].date, time: "21:30" })],
    { nights: ns, teamIds: ts },
  );
  const { report } = assignNights(pairings, ns, ts, { constraints: resolved });

  it("keeps the pin satisfied", () => {
    expect(report.constraints.find((x) => x.id === "p1")!.satisfied).toBe(true);
  });

  // The unconstrained floor on this shape is 4 and the spike measured 5 here.
  // Assert the bound, not the floor — pinning 5 would be asserting search luck.
  it("spreads ice time nearly as well as an unconstrained season", () => {
    expect(report.spacing.slotClusterWorstTeam).toBeLessThanOrEqual(8);
  }, 120_000);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/lib/schedule/constraints.test.ts -t "still gets its ice time spread"`
Expected: `keeps the pin satisfied` PASSES (the control — the pin is honoured
today because the pass never runs), and `spreads ice time nearly as well` FAILS
with `expected 15 to be less than or equal to 8`.

If the first one fails too, the fixture is wrong — check `teamId` before
anything else.

- [ ] **Step 3: Build the class labels**

Immediately before the `if (resolved.empty) {` line that guards the
`improveNightOrder` call:

```ts
  /**
   * A permutation may only swap nights carrying the same label.
   *
   * This replaces the `resolved.empty` gate that used to switch the whole pass
   * off. That gate was right about the danger — a request names a specific night
   * index and no entry in `rankSchedule` encodes it, so a permutation could
   * relabel which night holds a pinned block while every ranked metric ties —
   * and the comment below records that re-evaluating the constraints on each of
   * ~6k annealing steps was considered and rejected as too expensive.
   *
   * Labelling is the cheap equivalent: forbid the permutations that could break
   * a request instead of evaluating whether they did. Cost is one O(nights)
   * comparison folded into the ice-capacity loop that already runs per step.
   *
   * ⚠️ A BIAS IS NOT INVARIANT under a night permutation, which is the trap
   * here. `SlotBias.nights` is a per-night boolean WINDOW, so moving a game
   * across the window boundary changes what the bias is scored over. Carrying
   * each bias's membership bit in the label is what keeps it honest — and a
   * whole-season bias has the same bit on every night, so it costs nothing.
   *
   * With no requests every label is `"-|"`, every permutation is admissible, and
   * this is exactly the behaviour the `resolved.empty` gate used to produce.
   */
  const nightClass = (() => {
    const fixed = new Set<number>();
    // Names one night's participation, and one night's ice time: both make that
    // night a class of one, i.e. a fixed point of every admissible permutation.
    for (const f of resolved.forced) fixed.add(f.night);
    for (const sp of resolved.slotPins) fixed.add(sp.night);
    const namedWeeks = new Set(resolved.byeInWeek.map((b) => b.week));
    return nights.map((_, n) => {
      if (fixed.has(n)) return `FIX${n}`;
      const wk = namedWeeks.has(smeta.week[n]) ? `W${smeta.week[n]}` : "-";
      const bias = resolved.biases
        .map((b) => (b.nights[n] ? "1" : "0"))
        .join("");
      return `${wk}|${bias}`;
    });
  })();
```

- [ ] **Step 4: Extend admissibility and remove the gate**

Change `if (resolved.empty) {` to `{` (keep the block, drop the condition), and
inside the scorer's existing per-night loop add the class test beside the
overflow one:

```ts
      for (let n = 0; n < nights.length; n++) {
        const short = slotsNeeded[n] - slotsPerNight[pos[n]];
        if (short > 0) overflow += short;
        // A night may only move to a night of its own class. Scored through the
        // same `overflow` penalty so the annealer can cross an inadmissible
        // region on its way somewhere legal, exactly as it does for capacity.
        if (nightClass[n] !== nightClass[pos[n]]) overflow += 10;
      }
```

Then **replace** the `⛔ GATED ON resolved.empty` paragraph in the comment above
the block with this. Leaving a comment that says the pass only runs unconstrained
would be worse than no comment:

```ts
  // ⛔ CLASS-GATED, NOT CONSTRAINT-GATED. A request names a SPECIFIC night index
  // (`forced`, `slot_on`), which no entry in `rankSchedule` encodes. A
  // permutation can relabel which night holds a pinned block of games while
  // leaving every ranked metric no worse, so the rank vector alone cannot see
  // that it just moved a pin Phase P had honoured off the night it was pinned
  // to. `evaluateConstraints` runs afterward, off the final `games`, so it would
  // then honestly report that met request as unmet — exactly the silent
  // downgrade the ⛔ block above (`needsPhaseP`) exists to prevent.
  //
  // This whole pass used to be switched OFF whenever `resolved.empty` was false,
  // because the obvious repair — re-evaluating the constraints inside
  // admissibility — is a constraint evaluation on each of ~6k annealing steps
  // (4 restarts × 1500 steps, see `nightOrder.ts`). `nightClass` above is the
  // cheap equivalent: forbid the permutations that COULD break a request rather
  // than evaluate whether they did, at one O(nights) comparison folded into the
  // ice-capacity loop that already runs.
  //
  // Measured 2026-09-09 on 6 teams / one weeknight / 3 sheets: one `slot_on` pin
  // took worst-team clustering from 4 to 15 under the old gate. It is 5 now.
```

⚠️ Leave the `⛔ REWRITE scheduledAt WITH nightIndex, ALWAYS` paragraph exactly
as it is. It documents a shipped no-op and is not about this change.

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run src/lib/schedule/constraints.test.ts`
Expected: green, including the pre-existing `"a pinned slot survives the
clustering pass"` describe.

⚠️ That older test was written to fail if the pass ever moves a pin, and was
verified by forcing the pass to run unconditionally. It is now the guard for a
pass that genuinely runs. **If it goes red, the labels are wrong — do not touch
the test.**

- [ ] **Step 6: Prove the labels are load-bearing**

Mutation: delete the `if (nightClass[n] !== nightClass[pos[n]]) overflow += 10;`
line and re-run `npx vitest run src/lib/schedule/constraints.test.ts`. A
constraint test MUST go red. Confirm the mutant applied before believing a red or
a green, then revert.

If nothing goes red, the class test is not load-bearing and the fixture needs a
pin the pass actually wants to move — say `ns[11]` rather than `ns[0]`.

- [ ] **Step 7: Run the whole schedule suite three times**

Run: `npx vitest run src/lib/schedule` — three times, foreground.
Expected: green all three.

⛔ **Green is not enough here.** Every existing ice-time assertion is a `<=`
bound, so an unconstrained regression from 4 to 6 passes silently. Removing this
gate MUST be a no-op when there are no requests (labels are all `"-|"`, so no
permutation is ever refused). Add to the 6-team clustering describe in
`assignNights.test.ts`:

```ts
  // ⛔ EQUALITY, not the `<= 6` bound above. Removing the `resolved.empty` gate
  // has to be a no-op on a season with no requests, and a bound cannot see a
  // 4 -> 6 drift. If this fails, `nightClass` is refusing a permutation it
  // should admit — every label on an unconstrained season is `"-|"`.
  it("is unchanged on a season with no requests", () => {
    expect(report.spacing.slotClusterWorstTeam).toBe(4);
    expect(report.spacing.slotClusterWindows).toBe(17);
  });
```

- [ ] **Step 8: Cover every constraint kind this fixture can satisfy**

All six `CONSTRAINT_KINDS` map to a field `nightClass` labels — `bye_on`,
`play_on` and `bye_week` to `forced`, `slot_on` to `slotPins`, `bye_in_week` to
`byeInWeek`, `slot_bias` to `biases` — so the labelling is exhaustive **today**.
Nothing fails if a seventh kind is added.

```ts
  // ⛔ THREE KINDS, AND THE OTHER THREE ARE HONESTLY UNCOVERED. Six teams over
  // three sheets fills every night exactly, so all six teams play every night
  // and NO team can ever bye: `bye_on`, `bye_week` and `bye_in_week` are
  // infeasible here and report unmet whatever the pass does. The only fixture
  // with real byes is the 8-team Mon+Thu league, and that one is too tight for
  // the pass to find any admissible permutation — so it cannot exercise these
  // labels either. Those three reach `nightClass` through `forced` and
  // `byeInWeek`; `forced` IS covered below by `play_on`, `byeInWeek` is not.
  //
  // ⛔ NO CONDITIONAL SKIP. An earlier draft ended `if (!verdict.satisfied)
  // return;`, which skips the assertion in exactly the case the test exists to
  // catch — a guard that fails open. Every row here is one this shape can
  // satisfy, so an unmet verdict is a real failure.
  it.each([
    ["slot_on", "t3", { date: ns[11].date, time: "21:30" }],
    ["play_on", "t2", { date: ns[7].date }],
    ["slot_bias", "t1", { from: ns[0].date, to: ns[11].date, prefer: "late" }],
  ])("a %s request survives the night-order pass", (kind, team, params) => {
    const r = resolveConstraints(
      [c("k1", team, kind as ScheduleConstraint["kind"], params)],
      { nights: ns, teamIds: ts },
    );
    // Guards the fixture itself: a wrong param key resolves into `items` but
    // into no solver entry, leaving `empty` true and testing nothing.
    // `teamId`, not `team_id`.
    expect(r.empty).toBe(false);
    const out = assignNights(pairings, ns, ts, { constraints: r });
    expect(out.report.constraints.find((x) => x.id === "k1")!.satisfied).toBe(
      true,
    );
  }, 180_000);
```

⚠️ A whole-season `slot_bias` (`to: ns.at(-1)!.date`) is **not** satisfiable on a
single draw here — measured — which is why this row uses the first half. Task 2
uses the whole-season one deliberately, for the opposite reason.

- [ ] **Step 9: Commit**

```bash
git add src/lib/schedule/assignNights.ts src/lib/schedule/constraints.test.ts
git commit -m "feat(schedule): spread ice time on seasons that carry requests"
```

---

### Task 2: Restore best-of-N for constrained seasons, and teach selection to see requests

**Files:**
- Modify: `src/lib/schedule/assignNights.ts` (the `auto` line and `rankOf` in the `assignNights` wrapper, and the `variations` doc on `AssignOptions`)
- Modify: `src/lib/schedule/constraints.test.ts` (**one existing test is deleted — see Step 1**)

**Interfaces:**
- Consumes: Task 1's pass. **Do not start before Task 1 is committed** — on its own this multiplies a constrained generate's cost by four and buys nothing.

**Measured:** night classes alone take one pinned season from 15 to 14. With
best-of-N restored, 15 to 5. The gate collapsing constrained seasons to a single
draw was justified entirely by the pass being off for them.

- [ ] **Step 1: Delete the test this task reverses**

⛔ **READ THIS BEFORE THE GLOBAL CONSTRAINTS TRIP YOU UP.** The rule "never lower
an assertion to make a test pass" does not apply here, and this is the one
exception in this plan. `constraints.test.ts:966` currently holds:

```ts
describe("assignNights — a constrained season takes one draw, not a block", () => {
  ...
  it("ignores a request for four draws", () => {
    expect(stamps(4)).toBe(stamps(1));
  }, 120_000);
});
```

That test is correct, mutation-verified, and **encodes the decision this task
deliberately reverses**. It was written when the night-order pass could not run
on a constrained season, so a block of four draws differed only in Phase P/M/S
luck and cost 4x for nothing. Task 1 changed that premise.

Delete the `it`, and keep the describe with a replacement that preserves what is
still true — the clamp, which stops a caller asking for an unbounded search:

```ts
// A constrained season now DRAWS A BLOCK like any other: Task 1's night classes
// let the night-order pass run on it, which is what made a block worth drawing
// again. What survives from the old behaviour is the clamp — `variations` may
// only ever REDUCE the automatic count, which is how `generateSchedule`'s
// step-down retry loop forces a single draw on its degraded path.
//
// ⚠️ A TEN-WEEK SEASON. The clamp is arithmetic and does not depend on season
// length, and the 23-week fixture would spend ten full generates proving it.
// PR #66 made exactly this mistake and fixed it the same way.
describe("assignNights — variations can be reduced but never raised", () => {
  const shortNs = enumerateNights("2026-09-08", {
    weekdays: new Set([2]),
    slotTimes: ["19:00", "20:15", "21:30"],
    excluded: new Set<string>(),
    maxNights: 10,
  });
  const shortPairings = buildBalancedPairings(ts, 10);
  const shortResolved = resolveConstraints(
    [c("p1", "t3", "slot_on", { date: shortNs[4].date, time: "21:30" })],
    { nights: shortNs, teamIds: ts },
  );
  const stamps = (variations: number) =>
    assignNights(shortPairings, shortNs, ts, {
      constraints: shortResolved,
      variations,
    })
      .games.map((g) => `${g.home}|${g.away}|${g.scheduledAt}`)
      .sort()
      .join("\n");

  // Only the clamp. Determinism for a fixed seed is already covered in
  // `assignNights.test.ts` and re-checking it here costs two more generates.
  it("clamps a request above the automatic count", () => {
    expect(stamps(99)).toBe(stamps(4));
  }, 180_000);
});
```

- [ ] **Step 2: Write the failing tests**

```ts
  // Task 1 alone was worth 15 -> 14 here; the single draw, not the permutation
  // freedom, was the binding constraint. Measured 2026-09-09.
  it("draws a block, not a single schedule", () => {
    const stamps = (variations: number) =>
      assignNights(pairings, ns, ts, { constraints: resolved, variations })
        .games.map((g) => `${g.home}|${g.away}|${g.scheduledAt}`)
        .sort()
        .join("\n");
    expect(stamps(4)).not.toBe(stamps(1));
  }, 180_000);

  // ⛔ THE DRAW THAT HONOURS THE MANAGER WINS, ALWAYS. `rankFromReport`'s
  // seventeen entries are all balance and spacing — not one of them is "did we
  // meet the request". While constrained seasons took a single draw that could
  // not matter; a block makes it a coin toss, and Phase S already carries the
  // same warning on `outcomeFor`: a term invisible to the ranking means the
  // candidate honouring the request best can lose to one that ignores it.
  it("never picks a draw that honours fewer requests", () => {
    // ⛔ A WHOLE-SEASON `slot_bias`, NOT the `slot_on` pin above. Every draw
    // satisfies the pin, so with that fixture `chosen` and all four singles are
    // 0 unmet and this passes against a comparator carrying no constraint term
    // at all. Measured 2026-09-09: a whole-season "prefer late" is UNMET on a
    // single draw and MET on a block of four — the one fixture here where the
    // draws actually disagree about a request.
    const biased = resolveConstraints(
      [c("b1", "t1", "slot_bias", {
        from: ns[0].date,
        to: ns.at(-1)!.date,
        prefer: "late",
      })],
      { nights: ns, teamIds: ts },
    );
    const unmet = (r: ReturnType<typeof assignNights>) =>
      r.report.constraints.filter((x) => !x.satisfied).length;
    const chosen = unmet(
      assignNights(pairings, ns, ts, { constraints: biased, variations: 4 }),
    );
    for (const seed of [1, 2, 3, 4]) {
      const one = unmet(
        assignNights(pairings, ns, ts, { constraints: biased, seed, variations: 1 }),
      );
      expect(chosen).toBeLessThanOrEqual(one);
    }
  }, 300_000);
```

- [ ] **Step 3: Run them to verify they fail**

Run: `npx vitest run src/lib/schedule/constraints.test.ts -t "draws a block"`
Expected: FAIL — `variations` is clamped to 1 for a constrained season, so both
sides are the same schedule.

The `never picks a draw that honours fewer requests` test may pass by luck before
the fix, because with one draw there is nothing to choose between. Step 6's
mutation is what proves it.

- [ ] **Step 4: Make the count unconditional**

Replace:

```ts
  const auto = resolved.empty ? variationsFor(pairings.length) : 1;
```

with:

```ts
  // ⚠️ NOT gated on `resolved.empty` any more. It used to be, and correctly:
  // with the night-order pass switched off for constrained seasons, no seed in a
  // block could differ on clustering repair, so four draws cost 4x for nothing.
  // `nightClass` lets the pass run on every season, which makes the block worth
  // drawing again — measured, one pinned season goes 15 -> 14 on the pass alone
  // and 15 -> 5 once the block comes back.
  const auto = variationsFor(pairings.length);
```

Update the comment above it, and the `variations` doc on `AssignOptions`, which
still says a constrained season collapses to one draw.

- [ ] **Step 5: Put requests ahead of everything in selection**

In the wrapper's `rankOf`, prepend the unmet count:

```ts
  const rankOf = (r: ReturnType<typeof assignNightsOnce>) => {
    const v = rankFromReport(
      { games: r.games, unscheduled: r.report.unscheduled },
      r.report.spacing,
      teamIds,
      meta,
    );
    const [consec, worst, windows] = v.slice(v.length - 3);
    return [
      // ⛔ FIRST, above every balance and spacing term. An unmet request is a
      // promise broken to a person; clustering is a preference. Free to compute
      // — `report.constraints` is already built for every draw.
      r.report.constraints.filter((x) => !x.satisfied).length,
      ...v.slice(0, v.length - 3),
      worst,
      windows,
      consec,
    ];
  };
```

⚠️ The two clustering terms stay ahead of `slotConsecutive` — that swap is from
PR #66 and is separately mutation-verified. Do not disturb it.

⚠️ **This is a no-op on an unconstrained season, and that is why it is safe.**
`assignNights` returns `constraints: []` when `resolved.items.length === 0`, so
the prepended count is a constant 0 across every draw and the lexicographic order
is unchanged. Task 1 Step 7's equality assertion and PR #66's
`"is the lexicographic minimum of the four seeds it draws from, by the selection
order"` — which rebuilds the vector WITHOUT this term — both keep passing. If
either goes red, the term is not constant and something else is wrong.

- [ ] **Step 6: Prove the constraint term is load-bearing**

Mutation: drop the `r.report.constraints.filter(...)` entry from `rankOf` and
re-run `npx vitest run src/lib/schedule/constraints.test.ts -t "honours fewer"`.

It should go red: the test's whole-season `slot_bias` is measured unmet on a
single draw and met on a block, so without the term the selection has no reason
to prefer the draw that meets it. If it stays green, print each of the four
seeds' unmet counts — if they are all equal the fixture has stopped
discriminating and needs replacing before this test means anything. Confirm the
mutant applied, then revert.

- [ ] **Step 7: Check the cost**

A constrained generate goes from ~6 s to ~25-29 s — the same cost an
unconstrained one already carries, not a new cost class. Report the wall clock of
`npx vitest run src/lib/schedule/constraints.test.ts`.

⚠️ `generateSchedule`'s retry loop still forces `variations: 1` on every
iteration after the first. Leave that alone — it is what stops eight retries
becoming 32 generations.

- [ ] **Step 8: Run the whole schedule suite three times**

Run: `npx vitest run src/lib/schedule` — three times, foreground.
Expected: green all three.

- [ ] **Step 9: Commit**

```bash
git add src/lib/schedule/assignNights.ts src/lib/schedule/constraints.test.ts
git commit -m "feat(schedule): draw a block of seeds for constrained seasons too"
```

---

### Task 3: Stop telling a constrained season the wrong wait

**Files:**
- Modify: `src/lib/schedule/assignNights.ts:266` (`estimatedGenerateMs`)
- Modify: `src/components/manage/schedule-builder-panel.tsx:501` (its only call site)
- Test: `src/components/manage/generate-progress.test.ts`

**Interfaces:**
- Consumes: Task 1. The flag being removed exists *because* the pass never ran on a constrained season.

`estimatedGenerateMs(opts?: { constrained?: boolean })` subtracts
`NIGHT_ORDER_ALLOWANCE_MS` for a constrained generate, and its comment says why:
"a constrained generate never runs the night-order pass, so counting its
allowance there over-stated the countdown by the full 1.5 s." Task 1 makes that
false, so the progress countdown now **under**-states a constrained generate.

- [ ] **Step 1: Remove the parameter**

```ts
/**
 * Roughly how long a full generate takes, for the progress indicator in the
 * schedule builder.
 *
 * ⚠️ NO `constrained` FLAG ANY MORE. It used to subtract the night-order
 * allowance for a constrained generate, because the pass was switched off for
 * one. `nightClass` means every season runs it, so every season pays it.
 *
 * Typical, NOT a bound: Phase P alone may spend solve(4_000) plus a 3 s plateau
 * sweep on a hard league.
 */
export const estimatedGenerateMs = () =>
  SLOT_CANDIDATES.length * SLOT_BUDGET_MS +
  PHASE_PM_ALLOWANCE_MS +
  NIGHT_ORDER_ALLOWANCE_MS;
```

- [ ] **Step 2: Simplify the call site**

`schedule-builder-panel.tsx` becomes `expectedMs={estimatedGenerateMs()}`. Delete
the `resolvedConstraints`-derived argument and the paragraph of its comment that
explains the gating — but **keep** `resolvedConstraints` itself if anything else
in the file reads it (check before deleting).

- [ ] **Step 3: Run and commit**

Run: `npx vitest run src/components/manage/generate-progress.test.ts` and
`npx tsc --noEmit`. Expected: green.

```bash
git commit -am "fix(schedule): every season runs the night-order pass, so every season pays for it"
```

### Task 4: Show the number

**Files:**
- Modify: `src/components/manage/schedule-builder-panel.tsx` (the `[label, count]` tuple array ending `] as const`, ~line 920)
- Test: `e2e/11-schedule-builder.spec.ts`

**Interfaces:**
- Consumes: `report.spacing.slotClusterWindows` and `.slotClusterWorstTeam`, which already reach the panel — `presentSpacing` spreads `...raw` and rewrites only the four bye fields.

The spacing list ends at "Back-to-back games in the same ice time". The metric all
of this work moves is not displayed at all, so a manager cannot tell whether the
variation they just asked for is better than the one they rejected.

- [ ] **Step 1: Add the two rows**

In the tuple array, **above** the back-to-back row — that is the order variation
selection uses, and it is the metric a manager actually complains about:

```ts
                      [
                        "Five-game stretches with three in one ice time",
                        spacing.slotClusterWindows,
                      ],
                      [
                        "…the worst-affected team's share of those",
                        spacing.slotClusterWorstTeam,
                      ],
```

- [ ] **Step 2: Assert they render**

Extend the existing `"spacing checks report every goal the generator models"`
test in `e2e/11-schedule-builder.spec.ts` — it already generates a draft and
checks the spacing list — with both new labels.

- [ ] **Step 3: Run the affected specs and commit**

Run: `npx playwright test e2e/11-schedule-builder.spec.ts`. Do NOT run the full
e2e suite locally — CI runs it on the PR.

⚠️ Restore any guard you flip and discard drafts through the app, not with SQL.

```bash
git commit -am "feat(schedule): show ice-time clustering in the builder"
```

---

### Task 5: Remember the variation across a reload

**Files:**
- Modify: `src/components/manage/schedule-generate-form.tsx` (the `variation` state and its two setters)

**Interfaces:**
- Consumes: the `variation` state added in PR #66.

Split from Task 4 deliberately: a reviewer could take the panel rows and reject
this, and this one carries a hydration risk the display change does not.

- [ ] **Step 1: Persist it**

```tsx
  /**
   * ⚠️ `localStorage`, NOT a column on `seasons`. This is per-manager,
   * per-browser scratch — a migration for a counter is disproportionate.
   *
   * ⛔ EVERY ACCESS IN try/catch AND EVERY READ TOLERATES null. A private
   * window, cleared site data, or a browser set to block storage makes the
   * accessor ITSELF throw, and a season with nothing stored must simply start
   * at 1 rather than render nothing.
   */
  const variationKey = `obhl:variation:${seasonId}`;
  const [variation, setVariation] = useState(1);
  useEffect(() => {
    // ⛔ IN AN EFFECT, NOT A `useState` INITIALISER. This component is
    // "use client" but still server-rendered, where `window` does not exist and
    // the server cannot know the stored value — reading during render is a
    // hydration mismatch. The effect runs after mount, on the client only.
    try {
      const n = Number(window.localStorage.getItem(variationKey));
      if (Number.isFinite(n) && n >= 1) setVariation(Math.min(50, Math.floor(n)));
    } catch {
      /* storage unavailable — the counter is a convenience, not state */
    }
  }, [variationKey]);
  const rememberVariation = (v: number) => {
    setVariation(v);
    try {
      window.localStorage.setItem(variationKey, String(v));
    } catch {
      /* as above */
    }
  };
```

Call `rememberVariation` in place of `setVariation` at both existing call sites —
`onSubmit` resets to 1, `tryAnother` advances.

⚠️ `dispatch` still takes the variation as an ARGUMENT. Do not change it to read
the state: React batches the setter next to each caller, and reading state there
would dispatch the value from before the click. That is mutation-verified by the
e2e in PR #66.

- [ ] **Step 2: Check for a hydration warning**

Run `npm run build`, and load the builder page in the dev server with the console
open. Expected: no hydration mismatch. If one appears, the read has moved back
into render — do not reach for `suppressHydrationWarning`.

- [ ] **Step 3: Run and commit**

Run: `npx tsc --noEmit` and `npx playwright test e2e/11-schedule-builder.spec.ts`.

```bash
git commit -am "feat(schedule): remember which variation a manager is on"
```

---

### Task 6: Correct the documents that now say the opposite

**Files:**
- Modify: `SCHEDULE_HANDOFF.md` (§5)
- Modify: `docs/superpowers/specs/2026-09-09-schedule-variations-design.md` (§6, deferred list)

**Interfaces:**
- Consumes: Tasks 1 and 2. This task describes their behaviour, so it can only be written truthfully once both have landed. Independent of Tasks 3-5.

`SCHEDULE_HANDOFF.md` §5 currently reads "**Constrained seasons still get no
clustering repair, and now no block either**", written the same day as this plan.
Shipping this makes it false, and a handoff that contradicts the code is worse
than one that omits it.

- [ ] **Step 1: Rewrite the constrained-seasons bullet**

Replace it with what is now true: night classes, the measured 15 → 5, the weak
case (a partial-window `slot_bias`, 14 → 10), and that selection ranks unmet
requests first.

- [ ] **Step 2: Amend the previous spec's deferred list**

`2026-09-09-schedule-variations-design.md` §6 lists "Constrained seasons still get
no clustering repair" as deferred. Mark it done with a pointer to
`2026-09-09-clustering-for-constrained-seasons-design.md`, and leave the other
three entries alone.

⚠️ Do not rewrite the previous spec's measurements. They were true when taken and
are the record of why this work happened.

- [ ] **Step 3: Commit**

```bash
git commit -am "docs(schedule): constrained seasons get their ice time spread now"
```

---

## Self-Review

**Spec coverage:** §2 and §5.1 → Task 1. §3 and §5.2 → Task 2. §4 and §5.3 →
Task 4. §4 and §5.4 → Task 5. Acceptance 1 → Task 1 Step 7 (equality, not a
bound); 2 → Task 1 Step 1; 3 → Task 1 Step 5; 4 → Task 1 Step 6 and Task 2
Step 6; 5 → Task 4; 6 → the final review. Task 3 and Task 6 are consequences the
spec did not name — a stale progress estimate and two documents that assert the
opposite of what ships.

**Ordering is load-bearing, not cosmetic.** Task 2 before Task 1 quadruples a
constrained generate's cost for no benefit, and Task 1 without Task 2 measures as
a near-failure (15 → 14) a reviewer could reasonably reject. They ship together
or not at all. Tasks 3-6 are independent of each other and of ordering.

**The one place this plan overrides its own Global Constraints** is Task 2
Step 1, which deletes a passing, mutation-verified test. That is called out in
the task rather than left for an implementer to discover as a contradiction.

**Type consistency:** `smeta` is in scope at the `improveNightOrder` call site
(`buildNightMeta(nights)`, assigned near the top of `assignNights`); `nights`,
`pos`, `slotsNeeded` and `slotsPerNight` are already used by the loop the class
test joins. `report.constraints` entries carry `.satisfied` and `.id`.
`variationsFor(pairings.length)` is unchanged from PR #66.

**Known risk:** Task 1 removes a gate that three separate comments describe. The
guard is the pre-existing `"a pinned slot survives the clustering pass"` test,
which was itself verified by forcing the pass to run unconditionally — exactly
the condition this task makes permanent.
