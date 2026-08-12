# G2 — drive `pairingWeekdayExcess` from 8 to 0

**Protocol — read this and nothing else to resume.**

1. **Read scope.** This file is self-contained. Then read `matchups.ts` — the weights
   (lines 15–56) and the seed/descent/restart block (366–455) are the whole surface,
   ~130 lines. Read the full 477 only once you are implementing. **Budget ~250 lines
   to decide, ~600 to build.**
2. ⛔ **Rematch spacing is protected and outranks this goal.** All four rematch metrics
   are 0 today and must stay 0. A perfect weekday split bought with even one
   `rematchConsecWeek` violation is a **rejected** trade — locked with the manager, do
   not relitigate. This is the one way to "succeed" here and have the work thrown out.
3. ⛔ **`WD_SPLIT_W` is not the lever. Do not tune it.** Values 1, 5 and 8 all land on
   the identical schedule (excess 8, rematch 0); at 10 the descent buys a perfect split
   for 2 `rematchConsecWeek` violations. Recorded in the weight's own comment at
   `matchups.ts:27-33` — *a prior session's measurement, not re-measured here.*
4. ⛔ **Do not rescale `MULT_W` or the `SPACING_W` rematch weights** without rescaling
   `oneOff.ts`'s `nightPenalty` churn in the **same** change. No test covers this; it
   fails silently. Also in `SCHEDULE_HANDOFF.md` §5.
5. **Measurements vs readings.** Every number under *Resolved* was watched appear on
   2026-08-12 at production budgets. Claims about how the code is *shaped* say
   "reading" in those words.
6. **Verify with:** `npx vitest run && npm run lint && npx tsc --noEmit`.
   Baseline: **222 pass**, lint clean, tsc clean. The suite takes ~30 s.
7. ⚠️ **Phase S is nondeterministic — G2 is not.** Phase S is wall-clock budgeted, so
   its ice-time numbers move between identical runs and one green suite is not proof.
   Phases P and M are unaffected, so every G2 number below is stable and repeatable.
   Do not let a flaky-looking ice-time assertion make you distrust your own G2 readings.

**Status: not started.** Everything below is analysis, no code written. G2 is the one
goal left short of its ideal, deliberately. Branch `feat/schedule-goals` — 16 commits,
**unpushed** — carries two completed pieces of work: the original five-step generator
plan, and Phase S best-of-k weight selection (2026-08-12). Neither touched Phase M, so
nothing below was invalidated by them; the numbers here were re-checked afterwards.

---

## Resolved — do not re-derive

Reference season: 8 teams, Mon + Thu, 3 ice times, 48 nights (24 Mon / 24 Thu),
36 games/team, opens Thu 2026-09-10, excluding 2026-12-21/24/28/31 and 2027-03-04.

`pairingWeekdayExcess = 8`, which is **2 of 28** pairings off their ideal split:

| Pairing | Mon | Thu | Meetings | Ideal |
|---|---|---|---|---|
| `t1｜t3` | 4 | 1 | 5 | 3/2 or 2/3 |
| `t1｜t6` | 1 | 4 | 5 | 3/2 or 2/3 |

All 28 splits: `3/3`×4 (the six-meeting pairs, at ideal), `3/2`×11, `2/3`×11, plus the
two above. Every other goal metric is at its floor — all bye rules 0, all four rematch
metrics 0, `byesAdjNight` 0, weekday balance 18/18 every team, season ice share
12/12/12. Generate time **~20.8 s** (was 5.74 s before Phase S best-of-k; the extra
~15 s is Phase S running four candidates and is nothing to do with G2).

⚠️ **Two different units.** The report metric is **8**. `weekdayExcessScaled()` returns
**9216** for each of these pairings — it is a raw scaled cost, not the reported number.
Assert on `report.spacing.pairingWeekdayExcess`.

⚠️ **G2 is budget-independent.** Phases P and M read identically at any
`OBHL_SLOT_BUDGET_MS` — only Phase S differs. So `vitest.config.ts` measures G2
correctly and **you do not need a measure harness.** (This is why the existing test can
assert 8 directly.) The config now sets the budget to **5000**, matching production; it
was 400 when this brief was written, and that change is what makes the suite ~30 s. It
does not move any G2 number.

## Why the residual is exactly 2, and why the descent cannot fix it

*(A reading of the code plus the table above, not a separate measurement.)*

Both offenders involve **t1**, and they are mirror images — one Mon-heavy, one Thu-heavy.
That is not coincidence, and it is the whole problem:

- Phase P fixes *which nights each team plays*. t1's 18 Mon / 18 Thu is frozen before
  Phase M starts and cannot change.
- `MULT_W = 50_000` makes each pairing's meeting count non-tradeable, so t1｜t3 must stay
  at 5 meetings.
- Therefore moving one t1｜t3 meeting off a Monday *requires* adding one on a Thursday,
  which means re-pairing t1 on some Thursday — which perturbs whoever t1 played there.

So the fix is a **paired exchange across two nights of opposite weekdays**, and the
excess necessarily appears in twos. `descend()` (`matchups.ts:401-432`) re-chooses **one
night's matching with every other night held fixed** — it structurally cannot represent
this move, at any weight. That is why raising `WD_SPLIT_W` only ever buys the split by
breaking something else.

## Route 1 — a compound pass in Phase M (recommended)

Exactly the move `slots.ts` already needed and got: `const compoundPass` (`slots.ts:496`,
called at `585` only when the single-move descent stalls) changes two nights at once so
the constraint is restored in the same step. Phase S had the structurally identical
problem and this fixed it.

**It is cheap on this shape.** 6 of 8 teams play each night (3 games, 2 bye), so a night
has at most `5!! = 15` perfect matchings — `options[n].length ≤ 15`, well under
`MAX_MATCHINGS = 1000`. Restricted to opposite-weekday night pairs that is
24 × 24 = 576 pairs × 15 × 15 = ~130k joint evaluations. Restricted further to pairs
where both nights already involve an off-split team, far less. **This is not the
expensive route** — contrast route 2 below.

Follow `compoundPass`'s shape: run it only when `descend()` reports no improvement, and
accept only a strict gain, or restarts will loop.

## Route 2 — a Phase-M-aware `plateauScore` (not recommended first)

`plateauScore` in `assignNights.ts` selects among bye-optimal participation matrices
knowing nothing about how they will pair up, so some residual may be baked in before
Phase M ever runs. But it ranks ~8 sampled matrices at 10–30 ms each, and scoring them on
Phase M means running Phase M per candidate. Recorded as an unexplored option in
`SCHEDULE_HANDOFF.md` §5. Only worth it if route 1 stalls.

## The test that pins the current answer

`assignNights.test.ts:287-315`, *"goal 2: splits all but two of the 28 matchups evenly
across weekdays"* — asserts `off.length === 2` **and**
`report.spacing.pairingWeekdayExcess === 8`. Both must change if this succeeds. Its
comment block carries the history (9/42 before Step 1, 16/94 after it, 12 of 28 from a
weekday-blind seed) and should be updated, not deleted.

Also update `SCHEDULE_HANDOFF.md` §1's G2 row (currently `42 (9 of 28)` → `8 (2 of 28)`)
and `matchups.ts:46`'s "it is 2 of 28 with rematch at 0".

## Do not read

- `~/.claude/plans/sharded-beaming-ocean.md` (171) and `-archive.md` (377) — outside the
  repo; the five-step plan that produced this state. Complete, committed, spent.
  Everything still binding is above.
- `EXPORTS_HANDOFF.md` (264) — exports, unrelated.
- `docs/superpowers/specs/` (1,494 over 5 files) — none covers the generator.
- `slots.ts` (623) in full — you want `compoundPass` at 496–585 as a **pattern**, ~90
  lines. Phase S is otherwise irrelevant to G2.
- `docs/superpowers/plans/2026-08-12-phase-s-best-of-k.md` (581) — Phase S best-of-k,
  built and committed on this branch. Different phase, independent work; it changed no
  Phase M behaviour. Its results are already folded into the numbers above.

## Provenance

Written 2026-08-12 from the session that finished the plan's Step 4; moved into the repo
the same day so it is discoverable from a clone. The living document
for this area is `SCHEDULE_HANDOFF.md` (`AGENTS.md` points at it); §5 holds the standing
limits, §1 the outcome table.

Refreshed 2026-08-12 by the session that shipped Phase S best-of-k, which is why the
baseline, the generate time and the `slots.ts` line numbers moved. Only those changed —
no G2 analysis was revised, and Phase M was not touched.
