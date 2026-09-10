# Schedule variations, and the Phase S restart bug behind them

**Date:** 2026-09-09
**Status:** designed, not yet built
**Supersedes nothing.** Follows `2026-09-09-ice-time-clustering-design.md`, whose
shipped result this document shows was not reaching production.

Every number here was **watched appear** on this machine (Darwin 24.6, M-series,
`node --experimental-strip-types`, unloaded). Where a claim is a reading of the
code rather than a measurement, it says so in those words.

---

## 1. The bug: the suite and production run different searches

`vitest.config.ts:32` pins `OBHL_SLOT_RESTARTS` to **2,000**. The production
default at `assignNights.ts:149` is **20,000**. Nothing in the app, CI, or Vercel
config sets the variable, so every generate a manager runs does a 10x longer
Phase S search than any test has ever exercised.

Run the schedule suite at production's value and the ice-time clustering
feature's own two tests fail:

```
$ OBHL_SLOT_RESTARTS=20000 npx vitest run src/lib/schedule
FAIL  assignNights — ice-time clustering, 6 teams on one weeknight
      > keeps no team far worse off than the rest on ice time
AssertionError: expected 13 to be less than or equal to 6

FAIL  ... > delivers that clustering through scheduledAt, not just the report
AssertionError: expected 13 to be less than or equal to 6

Test Files  2 failed | 19 passed (21)
     Tests  3 failed | 365 passed (368)
```

The third failure — `does not force Phase P for a bias-only set`, 37.6 s — is the
30 s `testTimeout`, not a quality regression: generation is simply slower at
20,000.

So PR #62 shipped a feature that works at the restart count CI uses and does not
work at the restart count the league uses. On the reporting league's shape
(6 teams, one weeknight, 3 sheets, 23 weeks) the real-world improvement was
**worst-team 14 -> 13**, not 14 -> 4. The manager's report — "not much better
than before" — was exactly right.

### This is the `assert-on-what-ships` trap in a second costume

The first costume was a feature that rewrote `nightIndex` while only
`scheduledAt` was persisted: 364 tests green, nothing shipped. The fix was to
assert on the persisted field. This one is the same mistake one level out — the
tests assert on the right field, in the wrong *environment*. A test
configuration that overrides a production constant makes every assertion
downstream of it a claim about a program nobody runs.

**Standing rule this produces:** a test config may set a constant the production
default does not define, and may raise a *timeout*. It may not override a
constant that shapes the search, because then the suite stops being evidence
about the product. See §7.

---

## 2. Why more search makes the schedule worse

Sweeping the restart count on the reporting league's shape, one run per row
(deterministic — three runs at 2,000 and three at 20,000 each returned identical
values):

| restarts | clusterWorst | clusterTotal | back-to-back | time | search ends by |
|---|---|---|---|---|---|
| 250 | 6 | 20 | **8** | 2.3 s | restarts |
| **500** | **4** | **17** | 6 | 3.8 s | restarts |
| **1,000** | **4** | **17** | 6 | 6.8 s | restarts |
| **2,000** | **4** | **17** | 6 | 12.4 s | restarts |
| 4,000 | 13 | 28 | 6 | 23.6 s | clock |
| 8,000 | 13 | 28 | 6 | 25.8 s | clock |
| 20,000 (today) | 13 | 28 | 6 | 25.8 s | clock |

The curve is **non-monotonic**: 6 -> 4 -> 4 -> 4 -> 13 -> 10 -> 13.

The obvious explanation — that the cliff is the 5 s wall clock truncating a
sweep mid-flight — is **wrong, and was tested**:

| restarts | budget | completes? | clusterWorst |
|---|---|---|---|
| 2,000 | 5 s | yes | 4 |
| 4,000 | 5 s | cut off | 13 |
| 4,000 | **60 s** | **yes** | **13** |
| 8,000 | **60 s** | **yes** | 10 |

Given all the time it wants, the longer search still returns the worse schedule.
More search genuinely produces worse clustering.

**The mechanism (a reading of the code, not a measurement):** Phase S runs five
`SLOT_CANDIDATES` and keeps the winner by `compareIceOutcome`, which ranks on ice
share, weekday spread and streaks — **clustering is not in it**. The night-order
post-pass then repairs clustering, but only accepts a permutation that worsens
*nothing* ranked above it (`assignNights.ts`, the `noWorse` gate). A
better-searched candidate wins its own comparator while sitting in a basin the
post-pass cannot move. Search quality and clustering quality are decoupled, and
in this region anti-correlated.

**Consequence for the fix's status:** changing the restart count is **tuning into
a measured-good basin, not a mechanism fix.** It is safe and it is a large real
win for this league shape, and a different shape could land anywhere on that
curve. §6 records the structural fix this defers.

---

## 3. Decision 1 — align the restart count, and remove the divergence

`SLOT_RESTARTS` default **20,000 -> 1,000**, and **delete** the
`OBHL_SLOT_RESTARTS` line from `vitest.config.ts` so the suite exercises the
production default.

1,000 is the geometric centre of the measured-good band [500, 2,000]: 2x above
the lower cliff (250 degrades back-to-backs 6 -> 8), 4x below the upper one. All
three of 500/1,000/2,000 return identical schedules on both leagues, so the value
is chosen for margin, not for a result.

Measured effect:

| | worst-team clustering | total windows | generate |
|---|---|---|---|
| 6 teams / 1 weeknight / 3 sheets | **13 -> 4** | **28 -> 17** | **25.8 s -> 6.8 s** |
| 8 teams / Mon+Thu / 3 sheets (reference) | 17 -> 17 | 94 -> 94 | 27.9 s -> 26.3 s |

**The reference league cannot regress.** Measured at 500, 1,000, 2,000 and
20,000 restarts, its output is byte-identical on every metric — weekday split
18/18 for all eight teams, ice share 12/12/12 for all eight, `slotWeekdaySpread`
0, every bye and rematch term 0, `minRematchGapNights` 2, `pairingWeekdayExcess`
0. It is budget-bound at every setting above 500, so the restart cap never binds
there.

### The determinism promise, which is currently false

`assignNights.ts:223-230` says the schedule "stays deterministic for a given
input", and explains that a clock-bounded sweep breaks that because "the same
league would generate different schedules on a faster and a slower box."

At 20,000 restarts Phase S is **clock-bound on both leagues** (25.8 s and 27.9 s
against a 5 candidates x 5 s budget), so the promise is already false in
production. At 1,000 the 6-team league finishes its restarts (6.8 s in the §2
sweep, 6.5 s in the §4 seed runs — same configuration, run-to-run jitter on an
unloaded machine) and the promise holds for it. The 8-team league remains clock-bound at 1,000 (26.3 s);
its output is insensitive to the restart count across a 40x range, so this costs
nothing measurable, but it is **not** fixed and §6 records it.

### An open question this does not answer

The 8-team reference league gets **nothing** from the clustering pass —
worst-team 17 and 94 windows, with the pass running and unconstrained, identical
at every restart count. `SCHEDULE_HANDOFF.md` §5 lists this league as "unmeasured";
it is now measured, and the answer is "no benefit". The likely reason (a reading)
is that permuting nights in a Mon+Thu league moves games between weekdays, which
breaks the 18/18 split ranked far above clustering, so almost no permutation is
admissible. Not addressed here.

---

## 4. Decision 2 — variations

### The problem it solves

Generation is deterministic by design and by explicit comment. A manager who
dislikes a schedule and regenerates gets the byte-identical schedule, forever.
`AssignOptions` carries only `{ constraints }` — there is no seed. Their only
real levers are changing dates or ice times, and reaching for a manager request
instead makes it worse: any stored request makes `resolved.empty` false, which
**switches the night-order clustering pass off entirely**.

### Seeds move the output, measured

A throwaway patch threading one `seed` through Phase P's plateau sweep, Phase M,
the five `SLOT_CANDIDATES`, and `improveNightOrder`, run at 1,000 restarts on the
reporting league's shape:

| variation | clusterWorst | clusterTotal | back-to-back | minRematchGap |
|---|---|---|---|---|
| 1 | **4** | 17 | 6 | 2 |
| 2 | 10 | 20 | 4 | 2 |
| 3 | 13 | 28 | 6 | 4 |
| 4 | 11 | 19 | 5 | 2 |
| 5 | **4** | 14 | 6 | 2 |
| 6 | 10 | 23 | 7 | 2 |

Six distinct schedules from six seeds, at both 1,000 and 20,000 restarts. The
lever works.

**It also shows a blind reroll is the wrong product.** Variations 3 and 6 are
worse than variation 1 on the thing the manager is trying to fix. Handing a
manager a "try another" button that can quietly downgrade them is how they end
up hand-editing, which is what they said they did not want to do.

### The design: a variation is the best of a block of seeds

`assignNights` gains `seed?: number` and `variations?: number` on
`AssignOptions`. A *variation* `v` is generated by running seeds
`(v-1)*N + 1 .. v*N` and keeping the best by `rankSchedule` — the existing
lexicographic comparator, which already ends with the two clustering terms, so
clustering is the tiebreaker it never was inside Phase S.

**The loop lives inside `assignNights`, not in the caller.** `rankSchedule` is
module-private and needs `meta`, which `assignNights` already builds; hoisting
either into `lib/actions/schedule.ts` would export the generator's internals to
its caller for no gain. This is also the one place clustering can enter selection
cheaply: `rankSchedule` runs on the **finished** schedule, after the night-order
pass, so it sees what the manager sees.

**Two gates bound the cost**, and both are needed:

1. **`N` collapses to 1 unless `resolved.empty`.** A constrained season gets no
   night-order repair on any seed (§4, *What this does NOT do*), so selecting on
   clustering buys it nothing and would multiply its generate time for no
   product change.
2. **`N` collapses to 1 after the first iteration of the caller's retry loop.**
   `generateSchedule` already calls `assignNights` up to 8 times, stepping games
   -per-team down until everything fits. Nesting best-of-4 inside that is up to
   32 generations — several minutes, and past Vercel's function timeout on a
   large league. The first iteration is the one that succeeds in the ordinary
   case; a retry is already a degraded path where placing the games at all
   matters more than which of four draws is prettiest.

`N` is keyed on game count, the same signal `ilsRestartsFor` already uses, so it
is a function of the input and never of the clock:

| games | N | measured generate |
|---|---|---|
| <= 80 | 4 | 6-team league: 4 x ~6.6 s ~= 26 s |
| 81-120 | 2 | |
| > 120 | 1 | 8-team league: 26.3 s, unchanged |

The 6-team league lands at ~26 s — **the same wall clock it waits today** — and
gets the best of four instead of an arbitrary one. The 8-team league is
unchanged in both time and output: it gets no benefit from clustering (§3), so
spending 4x the time to select on it would buy nothing.

### The UI

A second button beside Generate: **"Try a different schedule"**. It submits the
same form with `variation` incremented; Generate itself resets it to 1.

`variation` is a hidden form field, held across submits the way the other inputs
already are (see the `key={publish.liveScheduleKey}` note in
`schedule-builder-panel.tsx`). **It is deliberately not persisted and not
labelled with a number.** Persisting it needs a migration on `seasons` for a
counter, which is disproportionate; labelling it without persisting it would
print a stale number after any page reload. The cost of not persisting is that
after a reload, "try a different schedule" starts from variation 2 again and may
re-show a schedule the manager already rejected. Accepted.

Because generation is deterministic given `(inputs, variation)`, a manager who
goes one variation too far gets the previous one back exactly — at the cost of
another generate — only while the form holds the counter.

### What this does NOT do

- It does not help a **constrained** season. Any stored manager request gates the
  night-order pass off, so every variation of a constrained season differs only
  in Phase P/M/S draws, with no clustering repair on any of them. Unmeasured.
- It does not surface the clustering metric in the builder panel. The panel's
  metric list still ends at "Back-to-back games in the same ice time"
  (`schedule-builder-panel.tsx`, the `[label, count]` tuple array), so a manager
  cannot see the number that varies most between variations. Tracked separately.

---

## 5. Scope

**In:**
1. `SLOT_RESTARTS` 20,000 -> 1,000; remove the `OBHL_SLOT_RESTARTS` override from
   `vitest.config.ts`.
2. `AssignOptions.seed`, threaded to Phase P's plateau sweep, Phase M, the five
   `SLOT_CANDIDATES`, and `improveNightOrder`.
3. Best-of-N variation selection by `rankSchedule`, N keyed on game count.
4. `variation` through the `generateSchedule` server action and a "Try a
   different schedule" button, with `variations: 1` forced on every retry
   iteration of that action's step-down loop.
5. A test that fails if the suite's Phase S search ever diverges from
   production's again (§7).

**Out:** the Phase M compound pass; clustering in `compareIceOutcome`; making the
8-team league benefit; the builder-panel clustering row; persisting the variation.

---

## 6. Deferred, with the evidence that motivates it

- **Clustering is invisible to Phase S's own candidate selection**
  (`compareIceOutcome`). Best-of-N works around it at the outer level. The
  structural fix is to let Phase S rank its five candidates partly on
  post-pass clustering — which requires running the night-order pass per
  candidate (~1.4 s each, affordable now that restarts dropped). Not attempted.
- **The 8-team league is clock-bound at every restart count** and its
  determinism promise stays false. Its output is insensitive across 40x of
  search, so nothing measurable is at stake today.
- **The 8-team league gets no clustering benefit at all** (17 / 94, unchanged).
- **Constrained seasons still get no clustering repair.**

---

## 7. Acceptance

1. `npx vitest run src/lib/schedule` green with **no** `OBHL_SLOT_RESTARTS` in
   the environment or in `vitest.config.ts`.
2. The 6-team clustering test asserts `slotClusterWorstTeam <= 6` and passes
   against the production default — the thing that is false today.
3. A regression test asserting the reference league's invariants (weekday 18/18,
   ice share 12/12/12, spreads and bye/rematch terms 0) still holds.
4. A test proving variations differ: two variations of one input produce
   different `scheduledAt` sets.
5. A test proving best-of-N selects: the chosen variation's `rankSchedule` is
   `<=` every candidate in its block.
6. Full `npm test` green.
