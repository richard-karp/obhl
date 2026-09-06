# The schedule-write RPC — one transaction instead of compensation

**Protocol — read this and nothing else to resume.**

1. This file is self-contained. ⛔ Do NOT read `LAUNCH_READINESS_HANDOFF.md`
   (896 lines) — its §5 points here and carries nothing else you need.
   `SCHEDULE_HANDOFF.md` is not needed either: this changes how writes land, not
   how schedules are computed. The one file to read alongside it is
   `supabase/migrations/0026_replace_published_schedule.sql`, in full, because it
   is the precedent and it already answers four of the questions below.
2. ⛔ **Hazards, before any instruction — all four are ways to look right and be
   wrong. They are stated in full in §2. Read that section before writing SQL.**
3. Claims are marked. **Watched** means a command was run and its output read.
   **A reading** means it follows from the code and has not been executed. Every
   line reference was re-checked on 2026-09-06 against
   `feat/schedule-repair-and-reschedule` at `2aa03fe`.
4. Verify with `npm run typecheck && npx vitest run`, `npx eslint src e2e`,
   `npx prettier --check src e2e supabase/migrations`, then the schedule e2e
   (specs 11, 14, 23, 26, 27) under `scripts/e2e-locked.sh`. **And the two-psql
   race in §6, which is the only thing that actually tests the lock.**

**Status: NOT STARTED. This is the first post-launch job**, decided 2026-09-06
after four review rounds. ⛔ **Do not start it before both leagues are running
live.** The whole reason it was deferred is that new SQL against production days
before a permanent season lock is a larger risk than the thing it fixes.

---

## 1. Why this exists

`src/lib/schedule/gameWrites.ts` (**360 lines, watched**) rewrites published games
in place for three callers: `rescheduleNight`, `applyScheduleRepair` and
`applyOneOffGame`. It has no transaction. What it has instead is compensation: a
pre-flight read, a conditional `UPDATE` per row so it cannot clobber a concurrent
edit, and — when a write fails partway — an attempt to undo the ones that already
landed.

That machinery is careful and it is now well tested. It is also the wrong shape,
and the review history is the evidence rather than an opinion:

| Round                | What it found in this code                                                                                                                                                                                                            |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1                    | both write paths were read-then-write with no serialization                                                                                                                                                                           |
| 2                    | the compensator was **itself a lost-update writer** — its undo did not condition on the columns it had written, so it silently reverted another manager's completed apply                                                             |
| 3 (mutation testing) | only the **first** failure in each 25-way chunk was kept; the rest were never re-read, never compensated, never reported — so an ordinary multi-request network fault left games half-changed while the UI said "Nothing was written" |

Each fix was correct. The next layer down is where the next bug was. **The
remaining hole cannot be fixed in TypeScript at all:** if the runtime dies between
a write and its compensation, the written rows stay written, and the public
schedule page, both iCal feeds and the CSV all read `games` live.

A second hole has been open since round 1 and was never closed: two managers
applying different repair plans concurrently each pass their own checks and
interleave. Games-played, byes and weekday survive (that is `checkOneOffWrite`'s
invariant) but pair balance can drift with no drift report.

**One `plpgsql` function with an advisory lock closes both.**

## 2. ⛔ The four hazards

### 2.1 DO NOT COPY 0026'S `season_is_started` GATE

`replace_published_schedule` refuses once the season has started. That is
deliberate there — it is the one-way door.

⛔ **This function must NOT have that check.** The entire point of repair and night
moves is that they work on a live, locked season; that is why they exist and why
they go through an in-place `UPDATE` rather than the generator. Copying 0026's
lock pattern and dragging its gate along would silently disable the feature the
moment the first game is played — **and every test would still pass**, because
tests run on unstarted seasons. This is the single most likely way to get this
wrong, because 0026 is the file you will have open.

### 2.2 TAKE THE ROW LOCKS BEFORE THE CHECKS READ THEM

0026:59 does `perform 1 from games where … for update` **before** its gate, and
its comment explains why at length: under `READ COMMITTED` a check and a write are
separate statements with separate snapshots, so a scorekeeper committing
`status='final'` in between is invisible to the check and fatal to the game.

The same applies here. This function checks `status = 'scheduled'` and that each
row still matches the values the plan was computed against. Lock the target rows
`FOR UPDATE` first, then check, then write — so the check and the act are one
decision rather than two.

### 2.3 `CREATE FUNCTION` GRANTS `EXECUTE` TO `PUBLIC`

Omitting a grant is not the same as denying access. 0026:118-127 revokes from
`public, anon, authenticated` **and then** grants to `service_role`, and its
comment explains that while `auto_expose_new_tables` is still on, an ungranted
function is still reachable by `authenticated` through `PUBLIC`.

Through PostgREST, this function is a one-call "rewrite these games". Do exactly
what 0026 does: `security invoker`, `set search_path = public`, revoke from
`public, anon, authenticated`, grant to `service_role` only. Every caller reaches
it through `createAdminClient()`.

### 2.4 `= NULL` IS NEVER TRUE, AND `label` IS NULL ON MOST GAMES

`writeGames` currently works around this in TypeScript
(`src/lib/actions/schedule.ts:955-961`): it uses `.is(col, null)` for null and
`.eq(col, want)` otherwise, with a ⛔ comment saying an unconditioned `.eq` would
make every forward write match zero rows and turn the feature into a permanent
"the schedule changed" refusal.

In SQL the idiom is `is not distinct from`, which is null-safe in both directions.
Use it for every expected-value comparison. **This is a simplification the move to
SQL buys you — do not port the two-branch dance.**

## 3. What exists now, and what survives

**Read `src/lib/schedule/gameWrites.ts` and `writeGames` in
`src/lib/actions/schedule.ts:922-1000` before designing anything.**

| Piece                                                                                                        | Fate                                                                    |
| ------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------- |
| `GameWrite`, `GameFields`, `MAX_GAME_WRITES`                                                                 | **keep** — the payload shape is unchanged                               |
| `WriteResult` / `WriteFailure`                                                                               | **keep the type, shrink the union** — see §4.3                          |
| pre-flight read, conditional `UPDATE` per row                                                                | **replaced** by the function                                            |
| `CHUNK`, parallel chunks, `Promise.allSettled`                                                               | **delete** — one statement, no window                                   |
| the whole compensation half: `applied`, `written()`, re-read-after-failure, `indeterminate`, undo-in-reverse | **delete** — a transaction rolls back for free                          |
| `GameWriteDeps` (`read` / `update`)                                                                          | **delete** — the injection existed to make compensation testable        |
| `logAudit` + `console.error` of stuck ids in `writeGames`                                                    | **keep the audit, delete the stuck half** — see §4.3                    |
| the three call sites                                                                                         | **unchanged.** They all call `writeGames`; the swap happens behind them |

⚠️ **This job is mostly deletion.** Expect `gameWrites.ts` to end near 100 lines
and roughly half of its 29 unit tests to go with the code they cover. That is the
measure of success, not a warning sign — but see §6 on what must replace them.

## 4. The design

### 4.1 Signature

```sql
create or replace function public.apply_game_writes(
  p_season uuid,
  p_writes jsonb
) returns table (applied int, refused uuid, reason text)
language plpgsql security invoker set search_path = public as $$
```

`p_writes` is a JSON array, one object per game:

```json
{
  "id": "…",
  "expect": {
    "scheduled_at": "…",
    "home_team_id": "…",
    "away_team_id": "…",
    "label": null
  },
  "next": { "home_team_id": "…", "away_team_id": "…", "label": null }
}
```

`next` carries only the columns being written — `{scheduled_at}` for a night move,
`{home_team_id, away_team_id, label}` for a repair or one-off. `expect` carries
the same columns **plus** `scheduled_at` always, which is how a concurrent
`rescheduleGame` or postpone is detected on the repair path.

### 4.2 Body, in order

1. `perform pg_advisory_xact_lock(hashtext(p_season::text));` — serializes every
   writer on this season. Released at commit.
2. Lock the target rows: `perform 1 from games where season_id = p_season and
id = any(<ids from p_writes>) for update;` — §2.2.
3. Refuse if any id is missing, `status <> 'scheduled'`, or any `expect` column
   `is distinct from` the row's current value. Return
   `(0, <that id>, 'conflict')` and stop. **Refusing is a return, not an
   exception** — an exception would roll back but gives the caller nothing to
   name in its message.
4. `update games set … from a lateral join over p_writes where id = … and
season_id = p_season`, one statement.
5. Return `(row_count, null, null)`.

⛔ **No `season_is_started` check anywhere in this function** (§2.1). Put a comment
saying so, naming 0026, so the next reader does not "fix" its absence.

⚠️ Keep `MAX_GAME_WRITES` enforced **in TypeScript** before the call. Its stated
rationale changes — it is no longer bounding a publicly-visible window, since
there isn't one any more — so rewrite that comment rather than leaving it making a
claim that has stopped being true. It stays as a sanity bound on a client-supplied
payload.

### 4.3 What the TypeScript returns

`WriteFailure.kind` is currently `"conflict" | "failed" | "stuck" |
"indeterminate"`. After this, **`stuck` and `indeterminate` become unreachable** —
that is the entire point. Delete them from the union and let the compiler find
every branch that handled them (`schedule-repair-form.tsx` and
`reschedule-night-form.tsx` both render copy for the half-applied case; that copy
goes too, and its absence is a user-visible improvement worth noting in the commit).

Keep the audit entry on a `failed` return. Delete the `stuck` ids branch and its
`console.error` — there can no longer be half-changed rows to record.

## 5. Rollback

The migration is **additive**: a new function, nothing dropped, nothing altered.
Applying it changes no behaviour until the TypeScript calls it. Do them as **two
commits** — the migration, then the swap — so the swap can be reverted on its own
without touching the database. ⚠️ `supabase db push` is the user's to run
(`db reset --linked` wipes production and must never appear in this work).

## 6. Testing — the unit tests cannot see the thing being fixed

**A lock only means something against a real Postgres.** Vitest with an injected
fake proves nothing about serialization, which is exactly why the compensation
code passed three rounds of unit tests with a lost-update bug in it.

1. **Two `psql` sessions, the repo's established technique.** Session A: `begin;`
   then `select apply_game_writes(…)` and hold. Session B: the same call on the
   same season — **watched to block**, not to interleave. Commit A; B then either
   refuses with `conflict` (its `expect` no longer matches) or applies cleanly.
   Run the mirror case on two _different_ seasons and watch them **not** block.
2. **The interleaving case from round 1**, which nothing has ever tested: two
   different repair plans on one season, concurrently. Before: both apply and pair
   balance drifts. After: the second refuses.
3. **A deliberate mid-batch failure** — inject a constraint violation on the 40th
   row of 60 — and assert **all 60** rows are unchanged. This is the case
   compensation could only approximate.
4. Keep the unit tests that cover payload shape, the ceiling, and the mapping from
   the function's return to `WriteResult`. Delete the compensation tests with the
   compensation.
5. Re-run the schedule e2e (11, 14, 23, 26, 27) — **33 green is the current
   baseline, watched 2026-09-06.** Spec 14 exercises `applyOneOffGame`, which is
   the shipped path and the one with the least new-code coverage.

## 7. Acceptance

- [ ] `0045_apply_game_writes.sql` exists, `--local` applied, **never** pushed by an agent.
- [ ] No `season_is_started` reference in it, and a comment saying why (§2.1).
- [ ] Row locks precede every check (§2.2).
- [ ] `revoke` from `public, anon, authenticated`; `grant` to `service_role` only (§2.3).
- [ ] Every expected-value comparison uses `is not distinct from` (§2.4).
- [ ] `gameWrites.ts` no longer contains the words `compensat`, `indeterminate`, `stuck` or `CHUNK`.
- [ ] `WriteFailure.kind` is `"conflict" | "failed"`, and the UI copy for half-applied batches is gone.
- [ ] The three call sites are **unchanged**.
- [ ] Two-psql: same season blocks, different seasons do not (§6.1) — watched, pasted into the plan record.
- [ ] Mid-batch failure leaves all rows unchanged (§6.3).
- [ ] typecheck, vitest, eslint, prettier clean; 33 schedule e2e green under the lock.

## 8. Out of scope

- Anything that changes what a repair _decides_ — this is about how the decision
  lands, not how it is computed.
- `replace_published_schedule`, `postpone_game`, `restore_game`: already
  transactional, already locked, not touched.
- The `season_is_started` one-way door itself.
- Batching or bounding differently: the ceiling stays where it is.
