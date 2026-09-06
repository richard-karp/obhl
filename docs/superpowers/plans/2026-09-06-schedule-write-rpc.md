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

**Status: NOT STARTED — blocked on launch, deliberately.** ⛔ Do not begin before
both leagues are running live. Written 2026-09-06; decided the same day, after
four review rounds, that shipping without the transaction and building it
afterwards beat pushing new SQL days before a permanent season lock.

---

## 0. Pre-flight — fill this in BEFORE any code, then get the go-ahead

⛔ **This section is a gate.** Spec §0 says why: this was written on 2026-09-06,
before the season locked and before either league went live, and a spec ages
against the tree it was written for. Four commands and a paragraph.

- [ ] **Re-measure.** `wc -l src/lib/schedule/gameWrites.ts` (was **360**, watched
      2026-09-06 at `2aa03fe`). Re-check the line references in spec §3
      (`schedule.ts:922-1000`) and §2.4 (`schedule.ts:955-961`). ⚠️ If any drifted,
      fix the SPEC in the same commit — do not work around a stale reference.

      Measured: ______

- [ ] **The state of the season.** Which seasons are live, whether
      `season_is_started` is true for them, and how many games have been played.
      This is what makes §2.1 a live hazard rather than a theoretical one, and it
      names what a mistake would damage.

      Measured: ______

- [ ] **What is NOT changing** — in your own words, not copied from spec §8. At
      minimum: the three call sites, what a repair decides, the one-way door.

      Stated: ______

- [ ] **Rollback rehearsal.** Confirm the two-commit split still applies
      (migration first, then the TypeScript swap) and write the exact revert
      command for the swap commit here, before you need it.

      Command: ______

- [ ] **User's go-ahead**, dated. ⚠️ Also confirm who runs `supabase db push` —
      it is the user's, never an agent's, and `db reset --linked` wipes
      production and must not appear anywhere in this work.

      Given: ______

## The steps, one line each

Detail, traps and acceptance for every one of these are in the spec. ⚠️ Two
commits, in this order, so the swap can be reverted without touching the database.

- [ ] **1 — the migration.** `0045_apply_game_writes.sql`: advisory lock, row
      locks before the checks, `is not distinct from` for every expected value,
      revoke/grant exactly as `0026` does. ⛔ No `season_is_started` anywhere, with
      a comment saying so. Applied `--local` only. Spec §4.
- [ ] **2 — the two-psql race.** Same season must **block**, different seasons
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

## What was built

_Filled in as the work lands: commit shas, the two-psql transcripts pasted
verbatim, measured test counts before and after, what the spec turned out to be
wrong about, and anything deliberately not done._

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
