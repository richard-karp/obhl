# Schedule — keep the form, move a night, pin a team, repair around it

**Protocol — read this and nothing else to resume.**

1. This file is self-contained: the ask, the measurements, the one architectural
   decision, the hazards, the four steps and the acceptance bars are all below.
   ⛔ **Do NOT read `LAUNCH_READINESS_HANDOFF.md` (867 lines)** — it covers
   launching production; nothing in it blocks this work. ⚠️ **`SCHEDULE_HANDOFF.md`
   (411 lines) is worth ONE targeted read** before step 3: the phase order and what
   each phase is allowed to trade. Do not read it front to back.
2. ⛔ **Hazards, before any instruction:**
   - ⛔ **THE SEASON LOCKS ON 2026-09-10.** `season_is_started` (`0026`) returns
     true once any non-draft game's `scheduled_at` is in the past, or its status is
     not `scheduled`, or it has goals. From that moment `generateSchedule`,
     `replace_published_schedule` and `removeSchedule` **all refuse, permanently**.
     144 games are published with the first on that date. **Everything in this spec
     must work AFTER that**, which is the whole reason for the decision in §3.
   - ⛔ **A scorekeeper touching any game closes the window early.** The lock also
     trips on `status <> 'scheduled'` or any goals — not just the date.
   - `supabase db reset --linked` **wipes production**. Use `db push`. ⚠️ This
     change needs **no migration**; if you find yourself writing one, re-read §3.
   - **Mutating `gh` and `vercel env` are denied to an agent.** Read-only `gh`
     works (`run list`, `run view`, `run download`).
   - ⚠️ **Never bare `git stash`** — the tree is shared with other sessions. Use
     `git stash push -u -m "<tag>"`, and `apply`, not `pop`. A WIP commit is better.
   - **Re-check the branch before every git write.** Other sessions commit here.
3. Claims are marked. **Watched** means a command was run and its output read.
   **A reading** means it follows from the code and has not been executed.
4. Verify with `npm run typecheck && npm test`, then `PORT=<yours> npm run test:e2e`.
   ⚠️ **Re-measure the baseline, do not quote one.** Export a distinct `PORT` and
   check `lsof -ti:$PORT` before believing a red run — `reuseExistingServer` will
   otherwise hand your suite another branch's dev server. Worktrees share ONE
   Supabase database, so serialize e2e. CI runs the full suite; locally run only
   the specs covering your step.

---

## 1. The ask, in the user's words

> - When the button to generate the schedule is clicked, do not clear all the
>   fields or reset them to defaults. When a schedule is published then reset all
>   fields to default including weeks off and manager requests.
> - There should be a mechanism to reschedule a game/entire night at any point in
>   time.
> - It should be possible to move a team/game to a specific night and have the
>   schedule repair around it. For example I should be able to say X team needs to
>   play on a specific night or on a specific night at a given time and the
>   schedule should repair around it.
> - It should also be possible to repair a schedule.

## 2. Measured facts — do not re-derive

Watched on 2026-09-06 by reading the files named:

| Fact | Where |
|---|---|
| `generateSchedule`, `publishSchedule`, `removeSchedule` are gated on `season_is_started`; **`publishSchedule` itself is not date-guarded** | `src/lib/actions/schedule.ts`; `supabase/migrations/0026_replace_published_schedule.sql` |
| `applyOneOffGame` writes with `.from("games").upsert(rows, { onConflict: "id" })` — **in place, NOT through `replace_published_schedule`** | `src/lib/actions/schedule.ts`, ~line 1112 |
| `rescheduleGame` already exists and is guarded only by `requireGameRole(…, "scorekeeper", "league_manager")` — **no season-lock check** | `src/lib/actions/games.ts:444` |
| `postponeGame` moves the date to `postponed_from`; `restoreGame` puts it back | `src/lib/actions/games.ts:419`, `:434` |
| The repair engine already exists: `planOneOff` re-runs Phase M, Phase S and `assignHomeAway` over the **unlocked** part of a season with played games pinned | `src/lib/schedule/oneOff.ts` |
| Churn is a **tiebreaker**, never a reason to leave a constraint unrepaired: `CHURN_W = { FEWEST: 5_000, SPACING: 1, SOONEST: 200 }`, all far below Phase M's `MULT_W` (50_000) | `src/lib/schedule/oneOff.ts` |
| Six constraint kinds exist and are stored per season: `bye_on`, `bye_week`, `bye_in_week`, `play_on`, `slot_on`, `slot_bias` | `src/lib/schedule/constraints.ts`; `schedule-generate-form.tsx:87` |
| The repair honours `slot_on` but **takes no view on `slot_bias`** — it does not re-run Phase P, so `biasCost: 0` for every plan it compares | `src/lib/schedule/oneOff.ts`, `outcomeOf` |
| The generate form's inputs are **uncontrolled** (`defaultValue`); `skips` and `mode` are React state | `schedule-generate-form.tsx:460-570` |
| Versions: **next 16.2.7, react 19.2.4** | `package.json` |
| The locked-season card already points at the one-off planner and at per-game Reschedule/Postpone/Cancel | `schedule-builder-panel.tsx:294-340` |

⚠️ **A reading, NOT a measurement — and step 1 must prove it before fixing it.**
The likeliest cause of the fields clearing is React 19's automatic form reset:
`<form action={fn}>` resets uncontrolled inputs once the action resolves. **It is
not documented in the installed Next guides** — `grep -rn 'requestFormReset' node_modules/next/dist/docs/`
returns nothing, and `forms.md` says nothing about reset (both watched). So it is
a hypothesis with a plausible mechanism, not a fact. ⛔ Do not skip the
reproduction: if the real cause is a remount from `revalidatePath`, the fix in
step 1 is the wrong fix and will appear to work locally.

## 3. ⛔ The one architectural decision — repair goes through `oneOff`, never `generateSchedule`

**Everything in items 2–4 must keep working after 2026-09-10.** There are exactly
two write paths onto `games`, and only one of them survives:

| Path | Survives the lock? |
|---|---|
| `generateSchedule` → `replace_published_schedule` | ❌ **No.** `season_is_started` refuses both, permanently and with no UI undo |
| `planOneOff` → `games` upsert by id (what `applyOneOffGame` does) | ✅ **Yes.** It is an ordinary authenticated update on rows, with no gate |

So **pin-and-repair (item 3) and repair (item 4) are new callers of the existing
repair engine, not new generators.** They compute a plan with `planOneOff`'s
machinery, show it, and apply it as an in-place upsert of the affected rows.

⛔ **Two consequences that look like tidying and are not.**

- **Do not "unify" this with `generateSchedule` for symmetry.** The moment repair
  reaches `replace_published_schedule`, it stops working on exactly the seasons it
  exists to serve, and the failure arrives four days from now rather than in test.
- **Do not relax `season_is_started` to let generate through.** It is what stops a
  manager destroying a season already being played. `EXPORTS_HANDOFF.md` §4
  describes the corruption shape that lives next door to this.

⚠️ **Repair may only touch UNLOCKED nights.** A night is locked when any of its
games has been played, has a non-`scheduled` status, or has goals — the same
predicate `season_is_started` uses, applied per night rather than per season.
`planOneOff` already takes `locked: boolean` per night; feed it honestly.

## 4. What changes, item by item

### Item 1 — the generate form keeps its fields; publish clears them

Generate is **iterative** — the manager regenerates repeatedly, tweaking one
field. Publish is **terminal**. Today both leave the form in the same state,
which is wrong at both ends.

- **After generate:** every field holds what was submitted, including the weekday
  checkboxes, ice-time slots, first-night date, length mode and its value, the
  skip-date chips, and the manager requests.
- **After a successful publish:** everything returns to defaults — the skip chips
  empty, and **the stored manager requests are deleted for that season** (they are
  server state in `schedule_constraints`, not form state, so this is a delete, not
  a re-render).

⚠️ **The requests are shared state.** Deleting them on publish is what the user
asked for and is right — they described one season's setup — but it is a real
delete of rows another manager may have added. Log it: `deleteScheduleConstraint`
already has an audit path; the publish-time clear must write one entry per removed
row, or one entry naming the count. ⛔ Do not silently truncate the table.

### Item 2 — reschedule a whole night

Per-game reschedule exists (`rescheduleGame`). What is missing is the night.

- **New action `rescheduleNight`**: given a season, a source date and a target
  date, move every game on the source night to the target night, **preserving
  ice-time order and the gaps between slots**. A game at 19:00 stays first.
- It is an in-place `games` update, so it works on a live season. ⛔ It must
  **refuse to move a locked night** — one whose games have been played — and say
  which game locked it, rather than silently moving the unplayed remainder.
- ⚠️ **Merging two nights is out of scope.** If the target date already has games,
  refuse with a message naming the count. Combining nights changes how many games
  run in an evening, which is an ice-booking question the app cannot answer.

### Item 3 — pin a team to a night (or a night and a time), then repair

This is the constraint vocabulary the generator already speaks, applied to a
**published** season:

- `play_on` — team X plays on night N.
- `slot_on` — team X plays on night N at time T.

The flow is the one `planOneOff` already establishes and the manager already
knows: **state the pin → see a plan → apply or discard.** Reuse it.

1. The manager picks a team, a night, and optionally a time.
2. The server builds the season's nights with `locked` set honestly, applies the
   pin as a `NightConstraint`, and runs the repair.
3. It returns **two or three ranked plans**, exactly as the one-off planner does —
   they differ by churn weighting, so the manager can choose between "touch the
   fewest nights" and "best spacing".
4. Each plan shows, per changed night, what moves. ⛔ **Show the diff before the
   apply, never after.** This is the screen that stops a manager wrecking a live
   schedule, and the one-off planner already sets that precedent.
5. Apply upserts the changed rows by id.

⚠️ **What repair cannot change, and the UI must say so.** Participation is frozen:
who plays on which night is fixed by the published schedule, so games played,
byes and per-weekday counts cannot move. Repair moves **who plays whom**, **ice
time** and **home/away** — that is it. A pin that would require a team to play on
a night it currently byes is **not satisfiable by repair** and must be reported
unmet with that reason, not silently dropped.

⛔ **That last sentence is the most likely thing to be got wrong.** The obvious
reading of "X team needs to play on a specific night" is that repair will *add*
them to that night. It will not — that changes participation, which changes byes,
which unbalances the season. If the manager wants a team on a night it byes,
the honest answer is that this needs a regenerate (impossible after the lock) or a
manual per-game reschedule. **Say that in the UI when it happens.**

### Item 4 — repair a schedule

The same engine with **no new pin** — re-run Phase M, Phase S and `assignHomeAway`
over the unlocked nights, honouring the season's stored constraints, and offer the
result as a plan. This is what a manager reaches for after a run of manual
reschedules has left the ice-time share lopsided.

- Same plan-then-apply flow, same diff, same in-place upsert.
- ⚠️ **It must be able to return "nothing to improve"** and say so, rather than
  offering a plan that churns nights for a score that did not move.

## 5. Hazards specific to this work

- ⛔ **Every changed game gets no new id** — that is the point of upserting by id,
  and it is what keeps calendar subscriptions intact. A regenerate mints new ids
  and replaces all 144 subscribers' events; repair must not. **Assert it in a
  test**: apply a repair, and check the id set before and after is identical.
- ⚠️ **`postponed_from` interacts with repair.** A postponed game has a null
  `scheduled_at` and its old date in `postponed_from`; the one-off planner reads
  that to keep the night discoverable, and `leagueTimeKey` renders `--:--` for it.
  Decide explicitly whether repair may move a postponed game — the recommendation
  is **no**, treat it as locked, because restoring it later must land somewhere
  predictable.
- ⚠️ **`slot_on` resolves against two different slot lists** depending on the path
  in — `generateSchedule` matches pins against the FORM's `slot_times`, while
  `planOneOff`'s caller builds its list from the season **as published**. This is
  deliberate and documented, but item 3 introduces a third caller. **Use the
  published list**, like the one-off planner, and say so in a comment.
- ⚠️ **Phase S is wall-clock bounded** (`OBHL_SLOT_BUDGET_MS`, default 5s), so a
  repair's quality varies run to run. Do not pin exact spacing numbers in tests —
  bound them. One green run proves nothing; run any timing-sensitive test 3×.
- ⚠️ **Playwright's `expect` timeout is 15s and must stay above the generator's
  budget.** If a repair runs the solver, a bare default-timeout assertion will
  flake. Raise `OBHL_SLOT_BUDGET_MS` in the e2e env if needed; **never loosen the
  balance assertion.**

## 6. Steps

TDD throughout: write the failing test, **watch it fail for the right reason**,
then the minimal code. Commit per step.

### Step 1 — reproduce the form reset, then fix it
1. Write an e2e test that fills every field on the generate form with non-default
   values, submits, and asserts each field still holds what was typed. **Watch it
   fail**, and read the failure: which fields reset tells you the mechanism.
2. ⛔ If the uncontrolled inputs reset but React state (`skips`, `mode`) survives,
   the cause is React's form reset and the fix is at the form. If **everything**
   resets, it is a remount and the fix is elsewhere — re-diagnose before coding.
3. Fix, keeping the inputs' current uncontrolled shape if possible.
4. Add the publish-clears-everything half, including the `schedule_constraints`
   delete with its audit entry. Test both directions in one spec.

### Step 2 — `rescheduleNight`
1. Unit-test the pure part: given a night's games and a target date, produce the
   new timestamps preserving slot order and inter-slot gaps. Cover DST.
2. Action with `requireLeagueManager`, refusing a locked source night and a
   non-empty target night, each with its own message.
3. Register it in `league-guards.test.ts` — ⛔ **a new exported action that
   resolves a league and is not registered fails that suite**, with
   `expected [ 'schedule.ts:rescheduleNight' ] to deeply equal []`.
4. UI on the schedule builder and on the season's schedule view.

### Step 3 — pin and repair
1. Unit-test `planOneOff`'s machinery driven by a bare pin with no one-off game:
   a satisfiable `play_on`, an unsatisfiable one (team byes that night), and a
   `slot_on`. Assert the unsatisfiable case reports **unmet with a reason**.
2. Assert the id-stability property from §5.
3. Server action returning ranked plans; apply action upserting by id, with audit.
4. UI: pin form → ranked plans → per-night diff → apply. Reuse the one-off
   planner's components where they fit.

### Step 4 — repair with no pin
1. Mostly the same path with an empty constraint set. Test the
   "nothing to improve" branch explicitly.
2. UI entry point on the builder, available in `published` **and** `locked` mode —
   ⛔ `locked` is the mode this feature exists for. The locked card currently
   offers only per-game edits and the one-off planner; add repair beside them.

## 7. Out of scope — raised, deliberately excluded

- Merging or splitting nights (§4 item 2).
- Changing participation — adding a team to a night it byes (§4 item 3).
- Re-running Phase P, so `slot_bias` still has no effect on a repair.
- Any change to `season_is_started`, `replace_published_schedule`, or the publish
  guard. ⛔ If a step seems to need one, stop and re-read §3.
- A past-date guard on publish. It is a known gap (item 9 in the readiness
  handoff) and is not this work.

## 8. Acceptance

- `npm run typecheck && npm test` clean; `npm run test:e2e` green, run 3× for the
  timing-sensitive specs.
- A manager can regenerate five times without retyping a field, and one publish
  returns the form to defaults with the stored requests gone and audited.
- A whole night moves in one action; a locked night refuses and names its blocker.
- A `play_on` pin against a live, **started** season produces ranked plans, shows a
  per-night diff before applying, and applying changes no game ids.
- An unsatisfiable pin says why, in the UI, in terms a manager can act on.
- Repair with no pin either improves the schedule or says there is nothing to do.
