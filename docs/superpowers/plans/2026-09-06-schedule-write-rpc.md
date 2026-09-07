# Schedule-write RPC — one transaction instead of compensation

**Protocol — read this and nothing else to resume.**

1. ⛔ **The design is NOT in this file.** It is
   `docs/superpowers/specs/2026-09-06-schedule-write-rpc-design.md` (~290 lines),
   which is self-contained and is the only other file to read. This file is the
   working record: the pre-flight, the steps, and what was measured.
   ⚠️ Deliberately no second copy of the four hazards here. A duplicated hazard
   goes stale on one side, and they are the load-bearing part of that spec.
2. ⛔ **The standing hazard, restated because nobody should have to open the spec
   to meet it: `0026_replace_published_schedule.sql` REFUSES ONCE A SEASON HAS
   STARTED, AND THIS FUNCTION MUST NOT.** Repair and night moves exist precisely
   to work on a live, locked season. `0026` is the file you will have open all
   day; copying its lock pattern and dragging its gate along disables the feature
   the moment the first game is played, **and every test still passes**, because
   tests run on unstarted seasons. Spec §2.1.
3. Claims are marked. **Watched** means a command was run and its output read.
   **A reading** means it follows from the code and has not been executed.
4. Verify with `npm run typecheck && npx vitest run`, `npx eslint src e2e`,
   `npx prettier --check src e2e supabase/migrations`, then the schedule e2e
   under `scripts/e2e-locked.sh`. ⚠️ **None of those tests the lock.** Only the
   two-psql race in spec §6 does; the compensation this replaces passed three
   rounds of unit tests with a lost-update bug in it.

**Status: STARTED 2026-09-07.**

⚠️ **THE "BOTH LEAGUES LIVE" PRECONDITION IS NOT MET, AND IS BEING OVERRIDDEN
DELIBERATELY.** One league is live; `LAUNCH.md` steps 5-6 are still deferred for
want of a second. The gate's stated REASON was that new SQL days before a
permanent season lock is a larger risk than the thing it fixes — and the user
removed exactly that on 2026-09-07: "Forget about the launch. The season is ready
to go. It's no longer a consideration." The risk the gate was pricing is gone; the
gate itself is therefore stale rather than unmet. Recorded here rather than
quietly ignored.

---

## 0. Pre-flight — fill this in BEFORE any code, then get the go-ahead

⛔ **This section is a gate.** Spec §0 says why: this was written on 2026-09-06,
before the season locked and before either league went live, and a spec ages
against the tree it was written for. Four commands and a paragraph.

- [x] **Re-measure.** `wc -l src/lib/schedule/gameWrites.ts` (was **360**, watched
      2026-09-06 at `2aa03fe`). Re-check the line references in spec §3
      (`schedule.ts:922-1000`) and §2.4 (`schedule.ts:955-961`). ⚠️ If any drifted,
      fix the SPEC in the same commit — do not work around a stale reference.

      Measured: **`gameWrites.ts` is still 360 lines — unchanged, matches.** ⛔
      **But §3's `schedule.ts:922-1000` and §2.4's `schedule.ts:955-961` are
      STALE.** That block — `writeGames`, the Supabase binding and its failure
      audit — was extracted to `src/lib/schedule/writeGames.ts` (118 lines) in
      `c541019` on `feat/manual-schedule-edits`, because `schedule-edits.ts`
      needed it and a `"use server"` module cannot export it. Per the
      instruction above, the SPEC is corrected in the same commit rather than
      worked around. The adapter also gained a `statuses` parameter there, which
      the RPC must carry forward — see the note under step 1.

- [x] **The state of the season.** Which seasons are live, whether
      `season_is_started` is true for them, and how many games have been played.
      This is what makes §2.1 a live hazard rather than a theoretical one, and it
      names what a mistake would damage.

      Measured (local stack, 2026-09-07 — ⚠️ PRODUCTION IS NOT READABLE FROM
      THIS CHECKOUT; `.env.local` points at the local stack, so production's
      state is taken on the user's report, not measured):

      | Season | started | live games | played |
      | --- | --- | --- | --- |
      | Spring 2026 (league A) | **true** | 15 | 10 |
      | Spring 2026 (league B) | **true** | 6 | 4 |
      | Edit/One-Off/Repair test seasons | false | 18 each | 0 |

      ✅ Two started seasons holding played games means §2.1 is a LIVE hazard in
      the fixture, not a theoretical one: if the new function inherits `0026`'s
      started-season gate, repair and night moves die on exactly these two and
      the e2e still passes, because every spec seeds an unstarted season.

- [x] **What is NOT changing** — in your own words, not copied from spec §8. At
      minimum: the three call sites, what a repair decides, the one-way door.

      Stated: The three callers — `rescheduleNight`, `applyScheduleRepair` and
      `applyOneOffGame` — keep their signatures and keep deciding what to write;
      this changes only HOW those writes land. A repair still chooses its own
      plan, and nothing here re-ranks or re-computes one. Publish/replace stays
      the one-way door it is, in `replace_published_schedule`, untouched. No
      `season_is_started` check goes anywhere near the new function. The new
      `schedule-edits.ts` actions become a fourth caller and are the reason the
      function must accept a widened status set and an `is_draft` scope.

- [x] **Rollback rehearsal.** Confirm the two-commit split still applies
      (migration first, then the TypeScript swap) and write the exact revert
      command for the swap commit here, before you need it.

      Command: Two commits, migration first. Revert the swap alone with
      `git revert --no-edit <swap-sha>`, which restores the TypeScript
      compensation path and leaves `0045` in the database unused and harmless —
      no down-migration, and nothing to undo on the database side.

- [x] **User's go-ahead**, dated. ⚠️ Also confirm who runs `supabase db push` —
      it is the user's, never an agent's, and `db reset --linked` wipes
      production and must not appear anywhere in this work.

      Given: **2026-09-07, by the user** — "A+B+C all in one PR", with the
      launch explicitly removed as a consideration (quoted above).
      ⛔ **`supabase db push` is the USER'S to run, never an agent's.** Every
      migration here is applied `--local` only from this checkout.
      `supabase db reset --linked` appears nowhere in this work and must not.
      ⚠️ And the standing rule this triggers: the migration must reach production
      BEFORE the code that calls it merges, or the deploy is the outage.

## The steps, one line each

Detail, traps and acceptance for every one of these are in the spec. ⚠️ Two
commits, in this order, so the swap can be reverted without touching the database.

- [x] **1 — the migration.** `0045_apply_game_writes.sql`: advisory lock, row
      locks before the checks, `is not distinct from` for every expected value,
      revoke/grant exactly as `0026` does. ⛔ No `season_is_started` anywhere, with
      a comment saying so. Applied `--local` only. Spec §4.
- [x] **2 — the two-psql race.** Same season must **block**, different seasons
      must **not**. Paste both transcripts into §"What was built" below. Spec §6.1.
      ⚠️ Do this BEFORE the TypeScript swap — if the lock does not behave, the
      design is wrong and step 3 is wasted work.
- [ ] **3 — the swap, and the deletions.** `gameWrites.ts` calls the function;
      `CHUNK`, the chunking, `GameWriteDeps`, and the whole compensation half go.
      `WriteFailure.kind` shrinks to `"conflict" | "failed"` and the compiler finds
      the UI copy for half-applied batches, which goes too. Spec §3, §4.3.
- [ ] **4 — the tests that replace the deleted ones.** The round-1 interleaving
      case (two repair plans, one season, concurrently) and a deliberate failure on
      row 40 of 60 asserting all 60 unchanged. Spec §6.2-6.3.
- [ ] **5 — close the scorekeeper column hole.** ⛔ **FOLDED IN HERE 2026-09-07,
      NOT PART OF THE ORIGINAL RPC DESIGN.** `0032`'s `"scorekeeper update games"`
      policy is `for update` over the WHOLE ROW, and RLS cannot restrict columns —
      so a scorekeeper of that league can write `status`, `scheduled_at`,
      `home_team_id` and `away_team_id` from their own session as freely as they
      write goals. Proven, not theorised: `e2e/30-schedule-edits.spec.ts` holds a
      `test.fixme` that cancels a published game with a signed-in anon-key client
      and no error.

      ⚠️ **The policy is pre-existing and WAS correct.** It dates from `0009` and
      was right while scorekeepers were legitimate cancellers. What changed is the
      user's rule of 2026-09-07 — scorekeepers "can only score games" — which
      `feat/manual-schedule-edits` implemented by removing them from the four
      action guards in `games.ts`. That left the guards with nothing behind them.

      **It belongs to this plan and not to that branch** because the fix is a
      migration against production, this is the next thing to touch that write
      path, and shipping a second migration first only to rewrite it here is the
      same doubled work that deferred the status widening.

      Shape: a `BEFORE UPDATE` trigger on `games` that raises when a non-manager
      changes any schedule column. ⚠️ **A `with check` cannot do this** — it
      cannot see `OLD`, so it cannot tell "scorekeeper edited goals" from
      "scorekeeper moved the game". Acceptance: flip that `test.fixme` back to
      `test` and it passes; `05-scoring` still green, since a scorekeeper writing
      goals must stay unaffected.

## What was built

_Filled in as the work lands: commit shas, the two-psql transcripts pasted
verbatim, measured test counts before and after, what the spec turned out to be
wrong about, and anything deliberately not done._

### Step 1 — `0045_apply_game_writes.sql`, applied `--local` only

⛔ **NOT pushed to production.** `supabase db push` is the user's to run, and the
standing rule applies: **the migration must reach production BEFORE the swap
commit merges**, or the deploy is the outage.

**The spec's signature was wrong, and this is the correction.** §4.1 gives
`apply_game_writes(p_season, p_writes)`. The shipped function takes four
arguments:

```
apply_game_writes(p_season uuid, p_writes jsonb,
                  p_statuses text[] default array['scheduled'],
                  p_is_draft boolean default null)
```

The two extra parameters are not scope creep — they are the pre-flight's finding
carried through. `writeGames` gained `statuses` and `isDraft` on
`feat/manual-schedule-edits` (`c541019` and the round-2 scoping fix), because a
season holds a published schedule and a draft at the same time and the manual
edit actions must not pair one with the other. A two-argument function would
have silently dropped both scopes on the way into SQL.

Catalog checks, **watched**:

| Acceptance (§7) | Result |
| --- | --- |
| `security invoker` | `prosecdef = f` ✅ |
| `set search_path = public` | `{search_path=public}` ✅ |
| revoked from public/anon/authenticated | grantees are `postgres` (owner) + `service_role` only ✅ |
| no `season_is_started` reference | ✅, with a comment naming 0026 and saying why |
| row locks precede the checks | ✅ `for update` before the refusal select |
| `is not distinct from` everywhere | ✅ — and see the null test below |

Behaviour, **watched**, each inside a rolled-back transaction:

| # | Case | Result |
| --- | --- | --- |
| 1 | happy path, two rows trade home teams | `applied=2`, both rows changed |
| 2 | `expect {label: null}` against a NULL label | **matches** — `applied=1`. This is §2.4; `<>` here would have refused every unlabelled game |
| 3 | `next {label: null}` against a set label | **clears it** — `coalesce` would have kept the old value, which is why the body uses `case … end` |
| 4 | one stale `expect` in a batch of 3 | `applied=0 reason=conflict`, names the row, **zero** rows written |
| 5 | a `final` game, default statuses | refused |
| 6 | the same batch with `p_statuses = {scheduled,final}` | `applied=3` |
| 7 | an id belonging to another season | refused — not silently skipped |
| 8 | an id that does not exist | refused |
| 9 | empty batch | `applied=0`, success, matching `applyGameWrites`' early return |

### Step 2 — the two-psql race, **watched**

⚠️ **Each case uses two DIFFERENT ROWS**, deliberately. If both sessions touched
the same row, the row lock would block and the test would prove nothing about
`pg_advisory_xact_lock`. Different rows means the advisory lock is the only thing
that *can* block. Session A holds for 5s; B starts 1.5s in.

```
=============== CASE 1: SAME season, different rows — must BLOCK ===============
applied=1 reason=none
  >>> session B (same season) took 3.54s

=============== CASE 2: DIFFERENT seasons — must NOT block ===============
applied=1 reason=none
  >>> session B (other season) took 0.04s
```

3.54s is exactly the remaining hold (5.0 − 1.5). **~88× separation between the
two cases**, which is not a number a flaky measurement produces.

⚠️ **First run of CASE 2 returned `applied=0`** and was re-run. The cause was the
fixture, not the lock: the row picked from the live season was not `scheduled`,
so the function correctly refused it. Timing was already right at 0.05s; the
re-run just makes the transcript unambiguous by using a scheduled row.

### Step 2b — mid-batch failure (spec §6.3), **watched**

A batch of all 18 published games with an unresolvable `home_team_id` on row 10.
The FK violation aborts the single `UPDATE`, the exception propagates, and a
fresh session afterwards finds **0 rows** carrying the batch's label. All 18
unchanged. This is the case compensation could only approximate — and the one
that could not be fixed in TypeScript at all.

⚠️ **Every previous spec in this directory was wrong about something** — the
schedule spec named a guard test that does not fail, the chrome spec claimed a
column a view does not carry. Recording that here is the point of the file, not an
embarrassment.

## Why this exists at all — the short version

`gameWrites.ts`'s compensation is damage control for a missing transaction, and
three review rounds each found the next bug in it: the write paths raced; then the
compensator was itself a lost-update writer; then only the first failure in each
25-way chunk was kept, so an ordinary network fault left games half-changed while
the UI reported "Nothing was written". Each fix was correct. The next layer down
was where the next bug was. Spec §1 has the table.
