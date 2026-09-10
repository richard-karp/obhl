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

Then update the `⛔ GATED ON resolved.empty` paragraph in the comment above the
block to describe night classes instead — leaving a comment that says the pass
only runs unconstrained would be worse than no comment.

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
Expected: green all three, and the unconstrained bounds unchanged.

- [ ] **Step 8: Commit**

```bash
git add src/lib/schedule/assignNights.ts src/lib/schedule/constraints.test.ts
git commit -m "feat(schedule): spread ice time on seasons that carry requests"
```

---

### Task 2: Restore best-of-N for constrained seasons

**Files:**
- Modify: `src/lib/schedule/assignNights.ts` (the `auto` line in the `assignNights` wrapper)
- Test: `src/lib/schedule/constraints.test.ts`

**Interfaces:**
- Consumes: Task 1's pass. **Do not start this before Task 1 is committed** — on its own it multiplies a constrained generate's cost by four and buys nothing.

**Measured:** night classes alone take one pinned season from 15 to 14. With
best-of-N restored, 15 to 5. The gate that collapses constrained seasons to a
single draw was justified entirely by the pass being off for them.

- [ ] **Step 1: Write the failing test**

Add to the describe created in Task 1:

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
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/lib/schedule/constraints.test.ts -t "draws a block"`
Expected: FAIL — `variations` is clamped to 1 for a constrained season, so both
sides are the same schedule.

- [ ] **Step 3: Make the count unconditional**

In the `assignNights` wrapper, replace:

```ts
  const auto = resolved.empty ? variationsFor(pairings.length) : 1;
```

with:

```ts
  // ⚠️ NOT gated on `resolved.empty` any more. It used to be, and correctly:
  // with the night-order pass switched off for constrained seasons, no seed in a
  // block could differ on clustering repair, so four draws cost 4x for nothing.
  // Night classes let the pass run on every season, which makes the block worth
  // drawing again — measured, one pinned season goes 15 -> 14 on the pass alone
  // and 15 -> 5 once the block comes back.
  const auto = variationsFor(pairings.length);
```

Also update the comment above it, and the `variations` doc on `AssignOptions`,
which still says a constrained season collapses to one draw.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/lib/schedule/constraints.test.ts -t "draws a block"`
Expected: PASS.

- [ ] **Step 5: Check the cost**

A constrained generate goes from ~6 s to ~25-29 s — the same cost an
unconstrained one already carries, not a new cost class. Confirm
`npx vitest run src/lib/schedule/constraints.test.ts` still finishes inside its
timeouts and report its wall clock.

⚠️ `generateSchedule`'s retry loop still forces `variations: 1` on every
iteration after the first. Leave that alone — it is what stops eight retries
becoming 32 generations.

- [ ] **Step 6: Run the whole schedule suite three times**

Run: `npx vitest run src/lib/schedule` — three times, foreground.
Expected: green all three.

- [ ] **Step 7: Commit**

```bash
git add src/lib/schedule/assignNights.ts src/lib/schedule/constraints.test.ts
git commit -m "feat(schedule): draw a block of seeds for constrained seasons too"
```

---

### Task 3: Show the number, and remember the variation

**Files:**
- Modify: `src/components/manage/schedule-builder-panel.tsx` (the `[label, count]` tuple array ending `] as const`, ~line 920)
- Modify: `src/components/manage/schedule-generate-form.tsx` (the `variation` state)
- Test: `e2e/11-schedule-builder.spec.ts`

**Interfaces:**
- Consumes: `report.spacing.slotClusterWindows` and `.slotClusterWorstTeam`, which already reach the panel — `presentSpacing` spreads `...raw` and touches only the four bye fields.

- [ ] **Step 1: Add the two rows**

In the tuple array, **above** the back-to-back row:

```ts
                      [
                        "Five-game stretches with three in one ice time",
                        spacing.slotClusterWindows,
                      ],
                      [
                        "…the worst-affected team's",
                        spacing.slotClusterWorstTeam,
                      ],
```

Placed above back-to-back on purpose: that is the order variation selection uses,
and it is the metric a manager actually complains about.

- [ ] **Step 2: Persist the variation counter**

In `schedule-generate-form.tsx`, replace `useState(1)` for `variation` with a
lazy initialiser reading `localStorage`, and write on every change:

```tsx
  /**
   * ⚠️ `localStorage`, NOT a column on `seasons`. This is per-manager,
   * per-browser scratch — a migration for a counter is disproportionate.
   *
   * ⛔ EVERY ACCESS IN try/catch AND EVERY READ TOLERATES null. A private
   * window, cleared site data, or a browser set to block storage makes the
   * accessor itself throw, and a season with nothing stored must simply start
   * at 1 rather than render nothing.
   */
  const variationKey = `obhl:variation:${seasonId}`;
  const [variation, setVariation] = useState(() => {
    try {
      const raw = window.localStorage.getItem(variationKey);
      const n = Number(raw);
      return Number.isFinite(n) && n >= 1 ? Math.min(50, Math.floor(n)) : 1;
    } catch {
      return 1;
    }
  });
  const rememberVariation = (v: number) => {
    setVariation(v);
    try {
      window.localStorage.setItem(variationKey, String(v));
    } catch {
      /* storage unavailable — the counter is a convenience, not state */
    }
  };
```

Then call `rememberVariation` in place of `setVariation` at both call sites
(`onSubmit` resets to 1, `tryAnother` advances).

⚠️ `useState`'s initialiser runs during render, and this component is
`"use client"` but still server-rendered first. If the build or the browser
console reports a hydration mismatch, move the read into a `useEffect` that runs
once on mount instead — do not reach for `suppressHydrationWarning`.

- [ ] **Step 3: Assert the rows render**

Extend the existing `"spacing checks report every goal the generator models"`
test in `e2e/11-schedule-builder.spec.ts` — it already generates a draft and
checks the spacing list — with the new labels.

- [ ] **Step 4: Run the affected specs**

Run: `npx vitest run src/lib/schedule` then
`npx playwright test e2e/11-schedule-builder.spec.ts`
Expected: green. Do NOT run the full e2e suite locally.

⚠️ Restore any guard you flip and discard drafts through the app, not with SQL.

- [ ] **Step 5: Commit**

```bash
git add src/components/manage src/lib e2e
git commit -m "feat(schedule): show ice-time clustering and remember the variation"
```

---

## Self-Review

**Spec coverage:** §2 and §5.1 → Task 1. §3 and §5.2 → Task 2. §4 and §5.3-4 →
Task 3. Acceptance 1 → Task 1 Step 7 and Task 2 Step 6 (existing bounds
unchanged); 2 → Task 1 Step 1; 3 → Task 1 Step 5; 4 → Task 1 Step 6; 5 → Task 3
Step 3; 6 → the final review.

**Ordering is load-bearing, not cosmetic.** Task 2 before Task 1 quadruples a
constrained generate's cost for no benefit, and Task 1 without Task 2 measures as
a near-failure (15 → 14) that a reviewer could reasonably reject. They ship
together or not at all.

**Type consistency:** `smeta` is in scope at the `improveNightOrder` call site
(`buildNightMeta(nights)`, assigned near the top of `assignNights`); `nights`,
`pos`, `slotsNeeded` and `slotsPerNight` are all already used by the loop the
class test joins. `variationsFor(pairings.length)` is unchanged from PR #66.

**Known risk:** Task 1 removes a gate that three existing comments describe. The
guard against getting it wrong is the pre-existing `"a pinned slot survives the
clustering pass"` test, which was itself verified by forcing the pass to run
unconditionally — exactly the condition this task creates permanently.
