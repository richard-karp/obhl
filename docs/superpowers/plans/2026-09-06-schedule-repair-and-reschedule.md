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
   planner's engine and an in-place `games` write by id, **never** through
   `generateSchedule`.
   ⚠️ *Written as "upsert" here and in step 3, and that turned out to be the
   wrong verb.* It shipped as an **UPDATE**: an upsert INSERTs when the id is
   gone, resurrecting a deleted game as a live fixture. `EXPORTS_HANDOFF.md` §2
   carries the decision. Spec §3 is the decision; do not relitigate it in code.
3. Claims are marked. **Watched** means a command was run and its output read.
   **A reading** means it follows from the code and has not been executed.
4. Verify with `npm run typecheck && npm test`, then `PORT=<yours> npm run test:e2e`.
   ⚠️ Re-measure the baseline; do not quote one.

**Status: SHIPPED — merged to `main` 2026-09-06 as `c87764e`, PR #38.** Built by
a subagent in its own worktree on `PORT=3101`, against spec `19adb22`.

## The four items, one line each

Detail, traps and acceptance for every one of these is in spec §6.

- [x] **1 — the form keeps its fields on generate; publish clears them.** ⚠️ Step 1
      REPRODUCES before it fixes: the React 19 auto-reset mechanism is a
      hypothesis, not a measurement, and a different failure shape means a
      different fix.
- [x] **2 — `rescheduleNight`.** Move a whole night, preserving slot order. Refuses
      a locked source night and a non-empty target.
- [x] **3 — pin a team to a night (or night + time), then repair around it.**
      Ranked plans, per-night diff shown before applying, in-place UPDATE.
- [x] **4 — repair with no pin.** Same engine, empty constraint set; must be able
      to answer "nothing to improve".

## What was built

**Status: MERGED to `main` 2026-09-06 as `c87764e` (PR #38).** Built by a subagent
in its own worktree (`PORT=3101`) against spec `19adb22`. **No migration** — zero
files under `supabase/migrations`, as §3 predicted, so there is nothing to
`db push` for this work.

| Step | SHA | What |
|---|---|---|
| 1 — form keeps fields on generate, clears on publish | `4cf737e` | reproduced first, then fixed |
| 2 — `rescheduleNight` | `51f417e` | move a whole night on a live season |
| 3 — pin a team to a night or ice time | `94b5ff3` | ranked plans, repair around the pin |
| 4 — repair with no pin | `cff7366` | same engine, empty constraint set |
| review — every failure in a chunk kept | `2aa03fe` | found by mutation testing, round 3 |
| the e2e read-failed guard | `af62f33` | see *Still open* below |
| merge `main` in | `dcd10b1` | #39 landed mid-review; see below |

⛔ **CI tested a state that never existed locally, and this is the reusable part.**
#39 (one chrome) merged to `main` while this was in review, and CI builds the PR
*merged with `main`* rather than the branch head. So its counts — 444 unit / 214
e2e — never matched the 439 / 202 measured on the branch, and its one failure had
never been reproduced here. The fix was to merge `main` in for real (`dcd10b1`)
and re-run: **213 passed, 1 skipped, 0 failed (4.8 min)**, watched 2026-09-06.
⚠️ A green local suite on a branch whose base has moved is evidence about nothing.
Check `git log --oneline $(git merge-base HEAD origin/main)..origin/main` before
trusting one.

⚠️ **The CI failure that prompted all this was not ours** — `03-seasons.spec.ts`
racing a redirect. Mechanism, evidence and fix are in
`LAUNCH_READINESS_HANDOFF.md` §5, under the final pre-launch pass.

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

### Still open: three other specs seed the builder unguarded

`getPublishState` fails closed — any of its parallel reads erroring sets
`readFailed`, `publishMode` returns `locked`, and the panel renders "This season's
games couldn't be read" with **no generate form on the page at all**. This branch
added `expectGenerateFormUsable` to `26-` and `27-` so that state fails in seconds
naming the card. Three specs still fill that form with no such guard:

| Spec | Seeding shape | What a read failure costs |
|---|---|---|
| `11-schedule-builder` | bare `fill` | waits out the test's 150s budget, reporting only `waiting for getByLabel('First game night')` |
| `23-schedule-constraints` | bare `fill` | the same, 150s |
| `14-one-off-game` | `if (count("No draft schedule") > 0)` | does **not** hang — the branch is skipped and the test fails later on an unrelated assertion |

⛔ **The polarity of the seeding condition decides which of those two you get, and
neither is legible.** `27-` gated on `count("Published: N games") === 0`, which is
*true* while the card is showing, so it entered the branch and waited out the whole
budget. `14-`'s condition is *false* while the card is showing, so it skips the seed
and misreports the failure one assertion later. A guarded seed is not optional just
because a spec happens to have the safer polarity.

**The fix is two parts, neither done here** — all three specs predate this branch,
and widening it days before a merge buys nothing.

1. **The blanket net, one line in `playwright.config.ts`.** `use` sets no
   `actionTimeout`, so every `fill` / `click` / `check` on a locator that never
   resolves falls back to the whole test budget. `actionTimeout: 20_000` — above
   `expect`'s 15s and below the 60s default test budget, keeping the layering that
   config's own comment already argues for — caps every never-resolving action in
   the suite, including specs nobody has written yet. ⚠️ **A reading, not a
   measurement.** It is one line, and it changes the budget of every action in 202
   tests; run the full suite before believing it.
2. **The precise net.** `expectGenerateFormUsable` before the first `fill` in each
   of the three, so the failure names the card rather than the locator. Copy it —
   `e2e/` has no shared helper module and no spec imports another, so duplication
   is the house style here, not an oversight.

**Measured 2026-09-06**, CI run `34055032836` attempt 1: the trigger was
`[WebServer] publish state read failed: An invalid response was received from the
upstream server` — one upstream 502, six seconds after the preceding test's publish,
logged once in a 202-test run. Not a bad query, and not something this branch
introduced. The `720000ms` in that log is `test.slow()` tripling `27-`'s 240s
describe budget; `11-` and `23-` are 150s, `14-` is 60s.
