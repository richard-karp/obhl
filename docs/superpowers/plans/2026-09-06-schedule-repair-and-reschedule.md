# Schedule — keep the form, move a night, pin a team, repair around it

**Protocol — read this and nothing else to resume.**

1. ⛔ **The steps are NOT in this file.** They are §6 of
   `docs/superpowers/specs/2026-09-06-schedule-repair-and-reschedule-design.md`
   (276 lines), which is self-contained and is the only file to read. This file is
   the index row and the record: what was asked, what state it is in, and — once
   the work lands — what was actually built and measured.
   ⚠️ Deliberately no second copy of the steps here. A duplicated hazard goes
   stale on one side, and the hazards are the load-bearing part of that spec.
2. ⛔ **The standing hazard, restated because nobody should have to open the spec
   to meet it:** `season_is_started` (`0026`) permanently blocks
   `generateSchedule`, `replace_published_schedule` and `removeSchedule` once the
   season starts — **2026-09-10**, with 144 games published. Everything in this
   work has to survive that, which is why repair goes through the one-off
   planner's engine and an in-place `games` upsert by id, **never** through
   `generateSchedule`. Spec §3 is the decision; do not relitigate it in code.
3. Claims are marked. **Watched** means a command was run and its output read.
   **A reading** means it follows from the code and has not been executed.
4. Verify with `npm run typecheck && npm test`, then `PORT=<yours> npm run test:e2e`.
   ⚠️ Re-measure the baseline; do not quote one.

**Status: IN FLIGHT as of 2026-09-06.** Built by a subagent in its own worktree on
`PORT=3101`, against spec `19adb22`. Not merged, no PR.

## The four items, one line each

Detail, traps and acceptance for every one of these is in spec §6.

- [ ] **1 — the form keeps its fields on generate; publish clears them.** ⚠️ Step 1
      REPRODUCES before it fixes: the React 19 auto-reset mechanism is a
      hypothesis, not a measurement, and a different failure shape means a
      different fix.
- [ ] **2 — `rescheduleNight`.** Move a whole night, preserving slot order. Refuses
      a locked source night and a non-empty target.
- [ ] **3 — pin a team to a night (or night + time), then repair around it.**
      Ranked plans, per-night diff shown before applying, in-place upsert.
- [ ] **4 — repair with no pin.** Same engine, empty constraint set; must be able
      to answer "nothing to improve".

## What was built

**Status: BUILT 2026-09-06** on branch `worktree-agent-a984c7aff0e5b2c5b`
(worktree `.claude/worktrees/agent-a984c7aff0e5b2c5b`, `PORT=3101`), against spec
`19adb22`. **Not merged, no PR, and no migration** — zero files under
`supabase/migrations`, as §3 predicted.

| Step | SHA | What |
|---|---|---|
| 1 — form keeps fields on generate, clears on publish | `4cf737e` | reproduced first, then fixed |
| 2 — `rescheduleNight` | `51f417e` | move a whole night on a live season |
| 3 — pin a team to a night or ice time | `94b5ff3` | ranked plans, repair around the pin |
| 4 — repair with no pin | `cff7366` | same engine, empty constraint set |

### Step 1: the hypothesis held, and here is the measurement that settled it

Measured on Fall 2026, before and after one generate:

| field | before | after generate |
|---|---|---|
| `games_per_team` | 4 | **10** (its default) |
| `slot_times` | `18:45, 20:00` | **`19:00, 20:15, 21:30`** (default) |
| Tue checkbox | checked | **unchecked** |
| skip chip / `excluded_dates` | `2026-09-24` | survived |
| `length_mode` | games | survived |

Uncontrolled inputs reset; React state survived. That is exactly the spec's
discriminator, so it is the React 19 form auto-reset and **not** a remount. Then
confirmed in the installed `react-dom@19.2.4`: `startHostTransition` calls
`requestFormReset` unconditionally before running a `<form action>`'s action, and
the only escape is the `defaultPrevented` branch. Fix: the form dispatches its own
action from `onSubmit` inside `startTransition`.
⚠️ **The submitter check in that listener is load-bearing** — the constraints
card's "Add request" posts via `formAction` through the same listener, and a bare
`preventDefault` would disarm it. The same React 19 reset then bit the *new*
night-move form on every refusal (the correction went in blank, came back refused
for a different reason); caught by e2e, fixed the same way.

### Measured

- Unit baseline **before** any change: 30 files / **374 tests**, typecheck clean.
- Unit now: 30 files / **396 tests** (+22 — `nights.test.ts` 11→21,
  `oneOff.test.ts` 45→56).
- `oneOff.test.ts` run **3×** (Phase S is wall-clock bounded): 56 / 56 / 56.
- New e2e: `26-schedule-form-state` (2 tests), `27-schedule-repair` (5 tests).
  `27-schedule-repair` run **3×** end to end: 5 passed each time.
- All schedule e2e in one pass (`11, 14, 23, 26, 27`): **32 passed**, including the
  three specs the agent did not write. Lint clean over `src` and `e2e`.
- The repair was verified to have genuinely applied rather than short-circuited, by
  reading the audit log after a run: `repair_schedule {games_rewritten: 1}` and a
  `reschedule_night` with a DST-correct `-04:00` on a June date.

### Where the spec was wrong about the code

1. **Step 2.3 is wrong.** It claims a new exported action that resolves a league
   and is not registered fails `league-guards.test.ts`. It does not:
   `targetSeasonForManager(` is already in that file's `GUARD_CALLS` list, so an
   action using `schedule.ts`'s own wrapper passes unregistered. Nothing was
   changed there and the suite is green. ⚠️ Worth correcting, because the
   instruction as written invites reflexively adding a name to the allowlist —
   which that file explicitly warns against.
2. **§2's line reference is off.** The uncontrolled inputs in
   `schedule-generate-form.tsx` are at ~500–620, not 460–570.
3. **§4 item 3 overstates the plan count.** Repair drops the zero-change baseline
   from what it offers (still built, as the `worseThan` reference), so it returns
   1–3 plans, or none plus "nothing to improve". A do-nothing plan beside real ones
   reads as two answers.

### Deliberately not done

- **No change to `season_is_started`, `replace_published_schedule`, or the publish
  guard.** Repair goes through `planOneOff`'s engine and an upsert by id
  throughout; id stability is asserted in unit tests and against the real
  before/after id set in e2e, for both the night move and the repair apply.
- **Phase P is not re-run**, so `slot_bias` still has no effect on a repair (§7).
- Night merging, participation changes and a past-date publish guard: all §7
  out of scope.
- ⚠️ **The no-pin e2e lands on the "nothing to improve" branch** in the current
  fixture order, because the pin test has just repaired that season. That is the
  branch item 4 requires and it asserts the explanatory copy; the apply path is the
  same `applyScheduleRepair` the pin test exercises. Exercising both branches
  applied needs the two tests on separate seasons.

### Spec numbering

The agent renamed its first e2e spec from `25-` to `26-` when the parallel session
took `25-team-logo-ink`. ⚠️ **Both branches still carry a `26-` and a `27-`** —
different filenames, so git will not conflict, but the numbering needs settling
when they merge.
