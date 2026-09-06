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

*Filled in when the work lands: branch, commit shas, measured test counts, what
the spec turned out to be wrong about, and anything deliberately not done.*

⚠️ **Also add the back-link then.** The spec does not yet point at this file — it
was committed before this plan existed and is checked out in a worktree right now,
so editing it would collide. One-way link until the work merges.
