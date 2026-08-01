# Scheduling Is Future-Only — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Scope every schedule operation to games that are future and untouched, so a played game falls outside by definition and a past-dated draft can no longer lock a season permanently.

**Architecture:** One SQL predicate — `season_schedulable_games(season, is_draft)` — defines what a scheduling operation may touch. `remove_published_schedule` and `replace_published_schedule` drop their `season_is_started` gate and scope their deletes to it. A new `season_schedule_counts` RPC gives the builder a single-snapshot view (remaining / played / cancelled / lineups) replacing six independent PostgREST reads. `publishMode`'s `locked` state narrows to "could not read this season".

**Tech Stack:** Next.js (App Router, server actions), Supabase/Postgres (plpgsql RPCs, PostgREST), TypeScript, Vitest (unit), Playwright (e2e).

## Global Constraints

- **Spec:** `docs/superpowers/specs/2026-08-01-scheduling-is-future-only-design.md`. Read §3 before writing any SQL.
- **Read `node_modules/next/dist/docs/` before writing Next.js code.** This Next.js has breaking changes vs. training data (`AGENTS.md`).
- **The predicate is defined exactly once**, in `season_schedulable_games`. No TypeScript copy, no second SQL copy. `0026`'s header explains why.
- **Never remove either `for update` line.** `perform 1 from games where season_id = p_season for update;` stays in both RPCs, covering every game in the season (drafts included). `0028` exists because it did not.
- **Never remove `0028`'s `v_published = 0` raise.**
- **`now()`, never `statement_timestamp()`.** `now()` is transaction-start time, so the lock, the count, the delete and the returned numbers provably see one set.
- **Migration file:** all SQL goes in `supabase/migrations/0029_scheduling_is_future_only.sql`, appended across Tasks 1–3. `0026`–`0028` are applied to production and must not be edited.
- **Every new function gets both directions of grant:** `revoke execute ... from public, anon, authenticated;` then `grant execute ... to service_role;`. `CREATE FUNCTION` grants EXECUTE to PUBLIC by default — omitting the revoke is not the same as not granting. See `0026`'s grant block.
- **Reset between SQL tasks:** `npm run db:reset` re-applies migrations and seed.
- **Commands:** `npm test` (vitest), `npm run test:e2e` (playwright), `npm run lint`, `npm run gen-types`.
- **Commit messages:** lower-case conventional prefix, imperative, explain *why* in the body. End with `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>`.

---

### Task 1: The predicate and the counts RPC

**Files:**
- Create: `supabase/migrations/0029_scheduling_is_future_only.sql`
- Test: manual psql (no vitest harness exists for SQL in this repo)

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `public.season_schedulable_games(p_season uuid, p_draft boolean default false) returns table (id uuid)`
  - `public.season_schedule_counts(p_season uuid) returns table (remaining int, played int, cancelled int, undated_remaining int, draft_count int, first_remaining timestamptz, last_remaining timestamptz, lineups_at_risk int)`

- [ ] **Step 1: Create the migration with the predicate function**

```sql
-- Scheduling concerns the future.
--
-- 0026's season_is_started counts a past date as played -- correctly, since a
-- game played last night that nobody has scored is indistinguishable from an
-- untouched fixture. But it read published games only, so a past-dated DRAFT
-- was invisible to it right up until publish, at which point the season became
-- permanently started: replace refused, remove refused, generate refused, and
-- the builder rendered a locked card with no way out.
--
-- Loosening that gate is the trap: it would delete games that really were
-- played. Instead every scheduling operation now scopes itself to games that
-- are future and untouched. A played game is then outside the operation by
-- definition rather than by a rule, which covers the scored case and the
-- played-but-unentered case with the same test -- exactly what status and score
-- could not do.
--
-- See docs/superpowers/specs/2026-08-01-scheduling-is-future-only-design.md.

-- The rule, defined once. Four consumers: season_schedule_counts, the delete in
-- remove_published_schedule, the delete in replace_published_schedule, and that
-- function's past_draft guard (via p_draft). A second copy in TypeScript or in
-- another statement would be free to drift -- the same reasoning 0026 gives for
-- season_is_started.
--
--   status = 'postponed'   awaiting rescheduling. Carries scheduled_at = NULL
--                          by design (0025), so no date comparison can reach
--                          it and it must be named. It was never played -- a
--                          postponement is why the game did not happen -- so it
--                          is the most in-scope row there is.
--   scheduled_at >= now()  future. This is what makes played games unreachable,
--                          and it is the only clause doing that work.
--   status = 'scheduled'   catches a game finalized early while still carrying
--   goals = 0              a future date. NOT how "played" is detected.
--
-- game_status is ('scheduled','in_progress','final','postponed','cancelled'),
-- so in_progress and final fall out without being named.
create or replace function public.season_schedulable_games(
  p_season uuid,
  p_draft boolean default false
)
returns table (id uuid)
language sql stable security invoker set search_path = public as $$
  select g.id from games g
   where g.season_id = p_season
     and g.is_draft = p_draft
     and (g.status = 'postponed'
          or (g.status = 'scheduled'
              and g.home_goals = 0 and g.away_goals = 0
              and g.scheduled_at >= now()));
$$;

comment on function public.season_schedulable_games(uuid, boolean) is
  'Games a scheduling operation may touch: future and untouched, plus postponed. The scope that replaced season_is_started as the gate.';
```

- [ ] **Step 2: Verify the predicate against the seed**

Run:
```bash
npm run db:reset
psql "$(supabase status -o env | grep DB_URL | cut -d= -f2- | tr -d '"')" -c "
  select s.name,
         (select count(*) from season_schedulable_games(s.id)) as schedulable,
         (select count(*) from games g where g.season_id = s.id and not g.is_draft) as live
    from seasons s order by s.name;"
```
Expected: Spring 2026 (all games in the past) shows `schedulable = 0` with `live > 0`. Fall 2026 shows `0 / 0` — it has no games yet.

- [ ] **Step 3: Append the counts RPC**

```sql
-- Everything the builder needs about a season's games, in one snapshot.
--
-- Replaces six independent PostgREST reads in getPublishState. Those were six
-- separate requests with six separate snapshots, so they could disagree with
-- each other -- a season could report a live count from one instant and a
-- lineup count from another. One function, one now(), one consistent answer.
--
-- The three sets are disjoint and exhaustive over live games:
--   remaining  schedulable -- what a replace or remove deletes
--   played     not schedulable and not cancelled -- what survives AND counts
--              as played. Seeds the generator in the follow-on spec.
--   cancelled  did not happen. In neither of the above on purpose: folding it
--              into `played` would later compensate a team for a game nobody
--              played. So remaining + played does NOT equal the live count, and
--              nothing may present them as though it does.
--
-- undated_remaining is the postponed rows. They are in scope and will be
-- deleted, but carry no date, so first/last_remaining cannot see them -- the
-- one case where the range and the count legitimately disagree.
create or replace function public.season_schedule_counts(p_season uuid)
returns table (
  remaining int,
  played int,
  cancelled int,
  undated_remaining int,
  draft_count int,
  first_remaining timestamptz,
  last_remaining timestamptz,
  lineups_at_risk int
)
language sql stable security invoker set search_path = public as $$
  with sched as (
    select id from season_schedulable_games(p_season)
  ),
  live as (
    select g.id, g.status, g.scheduled_at,
           exists (select 1 from sched s where s.id = g.id) as schedulable
      from games g
     where g.season_id = p_season and not g.is_draft
  )
  select
    (select count(*) from live where schedulable)::int,
    (select count(*) from live where not schedulable and status <> 'cancelled')::int,
    (select count(*) from live where status = 'cancelled')::int,
    (select count(*) from live where schedulable and scheduled_at is null)::int,
    (select count(*) from games where season_id = p_season and is_draft)::int,
    (select min(scheduled_at) from live where schedulable),
    (select max(scheduled_at) from live where schedulable),
    -- game_rosters cascades on game delete (0004_games.sql), so a captain's
    -- lineup goes with the game. Scoped to schedulable rows only: counting
    -- every live game's rosters overstates what a replace destroys, and it
    -- overstates in the direction that gets the warning ignored.
    (select count(*) from game_rosters r
       join live l on l.id = r.game_id
      where l.schedulable)::int;
$$;

comment on function public.season_schedule_counts(uuid) is
  'One-snapshot view of a season''s games for the schedule builder: what is still schedulable, what has been played, and what a replace would destroy.';

revoke execute on function public.season_schedulable_games(uuid, boolean) from public, anon, authenticated;
revoke execute on function public.season_schedule_counts(uuid) from public, anon, authenticated;
grant execute on function public.season_schedulable_games(uuid, boolean) to service_role;
grant execute on function public.season_schedule_counts(uuid) to service_role;
```

- [ ] **Step 4: Verify the counts against a straddling fixture**

Run:
```bash
npm run db:reset
psql "$(supabase status -o env | grep DB_URL | cut -d= -f2- | tr -d '"')" -c "
  select s.name, c.* from seasons s,
         lateral season_schedule_counts(s.id) c order by s.name;"
```
Expected: Spring 2026 reports `remaining = 0` and `played > 0`. Every season's `remaining + played + cancelled` equals its live game count.

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/0029_scheduling_is_future_only.sql
git commit -m "feat: define the set a scheduling operation may touch

A played game cannot be told from an untouched fixture by status or
score -- 0026's own comment says so. But it can be told by its date, and
that single test covers the scored case and the played-but-unentered
case together.

season_schedulable_games is that test, defined once so the two deletes,
the past-draft guard and the builder's counts cannot drift apart.
season_schedule_counts collapses six independent reads into one
snapshot, so the numbers on the screen agree with each other.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 2: Scope `remove_published_schedule` to the future

**Files:**
- Modify: `supabase/migrations/0029_scheduling_is_future_only.sql` (append)

**Interfaces:**
- Consumes: `season_schedulable_games(uuid, boolean)` from Task 1.
- Produces: `remove_published_schedule(p_season uuid) returns table (deleted int, kept int, refused text)` — **signature change**: `kept` is new. `refused` values are now `'nothing_to_remove'` or null. `'started'` and `'no_games'` are gone.

- [ ] **Step 1: Append the rewritten function**

```sql
-- Remove what is left to schedule, not "the published schedule".
--
-- The started-gate is gone. It was protecting played games by refusing the
-- whole operation, which is why one past-dated game froze an entire season
-- including games months away. Scope does that job now, and does it per-game:
-- played games are not excluded by a rule, they are outside the delete's WHERE.
create or replace function public.remove_published_schedule(p_season uuid)
returns table (deleted int, kept int, refused text)
language plpgsql security invoker set search_path = public as $$
declare
  v_deleted int := 0;
  v_kept int := 0;
begin
  -- Same key as replace_published_schedule, so a remove and a replace on one
  -- season cannot interleave. Released at commit.
  perform pg_advisory_xact_lock(hashtext(p_season::text));

  -- Every game in the season, drafts included -- unchanged from 0028, and now
  -- load-bearing for a second reason.
  --
  -- 0026/0027's reason still holds: without it a scorekeeper committing
  -- status='final' between the guard and the delete is invisible to the guard
  -- and fatal to the game, because the delete re-evaluates its WHERE against
  -- the new row version on waking.
  --
  -- The new reason: the scope below is time-dependent. now() is fixed for the
  -- transaction so it cannot drift mid-call, but the ROWS can -- a game
  -- finalized concurrently would leave the schedulable set computed for the
  -- guard and the set computed for the delete describing different rows. The
  -- lock makes them the same set by making the rows unable to move.
  perform 1 from games where season_id = p_season for update;

  -- Nothing left to schedule. Reported rather than silently succeeding, so a
  -- stale tab's second submit does not come back as "removed 0 games" and read
  -- as success. Note what this no longer means: a started season is not
  -- refused, it simply has less in scope.
  if not exists (select 1 from season_schedulable_games(p_season)) then
    return query select 0, 0, 'nothing_to_remove'::text;
    return;
  end if;

  delete from games
   where id in (select id from season_schedulable_games(p_season));
  get diagnostics v_deleted = row_count;

  -- Counted after the delete: every live game left behind, which is history
  -- AND cancelled games. Deliberately not the same number as the caller's
  -- "played" count -- a cancelled game was not played and must never be
  -- described as such.
  select count(*)::int into v_kept
    from games where season_id = p_season and not is_draft;

  return query select v_deleted, v_kept, null::text;
end;
$$;

comment on function public.remove_published_schedule(uuid) is
  'Delete a season''s remaining schedule -- future and untouched games, plus postponed ones. Played games are outside its scope rather than protected by a gate.';
```

- [ ] **Step 2: Verify it refuses a fully-elapsed season and keeps played games**

Run:
```bash
npm run db:reset
psql "$(supabase status -o env | grep DB_URL | cut -d= -f2- | tr -d '"')" -c "
  select r.* from seasons s, lateral remove_published_schedule(s.id) r
   where s.name = 'Spring 2026' limit 1;"
```
Expected: `deleted = 0, kept = 0, refused = nothing_to_remove` — Spring 2026 is entirely in the past, so nothing is in scope.

- [ ] **Step 3: Verify it deletes only the future half of a straddling season**

Run:
```bash
npm run db:reset
psql "$(supabase status -o env | grep DB_URL | cut -d= -f2- | tr -d '"')" <<'SQL'
begin;
-- Build a straddling season by hand: take Spring 2026 and push half its
-- games into the future.
with s as (select id from seasons where name = 'Spring 2026' limit 1),
     half as (select g.id from games g, s
               where g.season_id = s.id and not g.is_draft
               order by g.scheduled_at desc limit 4)
update games set scheduled_at = now() + interval '30 days'
 where id in (select id from half);
select 'before', * from seasons s, lateral season_schedule_counts(s.id)
 where s.name = 'Spring 2026';
select 'removed', r.* from seasons s, lateral remove_published_schedule(s.id) r
 where s.name = 'Spring 2026';
select 'after', * from seasons s, lateral season_schedule_counts(s.id)
 where s.name = 'Spring 2026';
rollback;
SQL
```
Expected: `before` shows `remaining = 4`; `removed` shows `deleted = 4` with `kept` equal to the earlier `played + cancelled`; `after` shows `remaining = 0` and `played` unchanged from `before`.

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/0029_scheduling_is_future_only.sql
git commit -m "feat: scope schedule removal to what is left to schedule

The started-gate refused the whole season when any one game had been
played, so a schedule generated from a past start date froze games
months away with no way out through the UI.

Scope replaces it. Played games are outside the delete's WHERE rather
than protected by a refusal, so removing works on a season under way and
still cannot reach a game that happened.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 3: Scope `replace_published_schedule`, and refuse a past-dated draft

**Files:**
- Modify: `supabase/migrations/0029_scheduling_is_future_only.sql` (append)

**Interfaces:**
- Consumes: `season_schedulable_games(uuid, boolean)` from Task 1.
- Produces: `replace_published_schedule(p_season uuid) returns table (deleted int, kept int, published int, refused text)` — **signature change**: `kept` is new. `refused` values are `'no_draft'`, `'past_draft'`, or null. `'started'` is gone.

- [ ] **Step 1: Append the rewritten function**

```sql
-- Replace what is left to schedule, and never promote a draft into the past.
create or replace function public.replace_published_schedule(p_season uuid)
returns table (deleted int, kept int, published int, refused text)
language plpgsql security invoker set search_path = public as $$
declare
  v_deleted int := 0;
  v_kept int := 0;
  v_published int := 0;
begin
  perform pg_advisory_xact_lock(hashtext(p_season::text));

  -- Every game in the season, drafts included. Unchanged from 0028 and still
  -- load-bearing in both of its directions: the live rows because the delete
  -- and the guards are separate statements, and the draft rows because the
  -- no_draft guard reads them and the promotion writes them with the live
  -- DELETE in between. 0028's header carries the reproduction that returned
  -- deleted=4, published=0, refused=null and emptied a season.
  perform 1 from games where season_id = p_season for update;

  if not exists (select 1 from games where season_id = p_season and is_draft) then
    return query select 0, 0, 0, 'no_draft'::text;
    return;
  end if;

  -- Every draft must itself be schedulable, or nothing is promoted.
  --
  -- This is what makes the defect unreachable rather than merely unlikely.
  -- generateSchedule clamps a past start date, but a stale tab, a clock skew,
  -- or a draft left unpublished across its own first game night can all still
  -- present a past-dated draft -- and promoting one recreates exactly the
  -- permanent lock this migration exists to remove.
  --
  -- Refusing the whole call rather than promoting the schedulable subset is
  -- deliberate: a partial promotion publishes a schedule with holes in it and
  -- reports success. In practice drafts are always 'scheduled' at 0-0 (nothing
  -- in the app postpones, finalizes or scores a draft), so this reduces to the
  -- date -- but it is written as the full predicate so the guard cannot
  -- silently become wrong if that stops being true.
  if exists (
    select 1 from games d
     where d.season_id = p_season and d.is_draft
       and not exists (
         select 1 from season_schedulable_games(p_season, true) s where s.id = d.id
       )
  ) then
    return query select 0, 0, 0, 'past_draft'::text;
    return;
  end if;

  delete from games
   where id in (select id from season_schedulable_games(p_season));
  get diagnostics v_deleted = row_count;

  -- Before the promotion, or it would count the drafts we are about to make
  -- live. This is the live games left behind: history AND cancelled.
  select count(*)::int into v_kept
    from games where season_id = p_season and not is_draft;

  update games set is_draft = false where season_id = p_season and is_draft;
  get diagnostics v_published = row_count;

  -- Unreachable while the lock above holds. Kept from 0028 because the failure
  -- it guards is a season with no games at all, and rolling back is strictly
  -- better than reporting that as a successful replace.
  if v_published = 0 then
    raise exception
      'replace_published_schedule: deleted % live games but promoted no drafts; rolling back',
      v_deleted
      using hint = 'A concurrent write removed the drafts after the no_draft guard passed.';
  end if;

  return query select v_deleted, v_kept, v_published, null::text;
end;
$$;

comment on function public.replace_published_schedule(uuid) is
  'Replace a season''s remaining schedule with its drafts, in one transaction. Played games are out of scope; a draft dated in the past is refused outright.';
```

- [ ] **Step 2: Verify `past_draft` refuses and rolls nothing back**

Run:
```bash
npm run db:reset
psql "$(supabase status -o env | grep DB_URL | cut -d= -f2- | tr -d '"')" <<'SQL'
begin;
-- Give Fall 2026 a live game in the future and a draft dated in the past.
with s as (select id from seasons where name = 'Fall 2026' limit 1),
     t as (select array_agg(team_id) tids from season_teams, s
            where season_id = s.id)
insert into games (season_id, home_team_id, away_team_id, scheduled_at, status, is_draft)
select s.id, t.tids[1], t.tids[2], now() + interval '40 days', 'scheduled', false from s, t
union all
select s.id, t.tids[1], t.tids[2], now() - interval '5 days', 'scheduled', true from s, t;

select 'replace', r.* from seasons s, lateral replace_published_schedule(s.id) r
 where s.name = 'Fall 2026';
select 'live_after', count(*) from games g, seasons s
 where g.season_id = s.id and s.name = 'Fall 2026' and not g.is_draft;
rollback;
SQL
```
Expected: `replace` returns `deleted = 0, kept = 0, published = 0, refused = past_draft`, and `live_after` is still `1` — the live game was not deleted.

- [ ] **Step 3: Verify a future draft replaces only the remaining games**

Run:
```bash
npm run db:reset
psql "$(supabase status -o env | grep DB_URL | cut -d= -f2- | tr -d '"')" <<'SQL'
begin;
-- Fall 2026 with one past live game, one future live game, and a future draft.
with s as (select id from seasons where name = 'Fall 2026' limit 1),
     t as (select array_agg(team_id) tids from season_teams, s
            where season_id = s.id)
insert into games (season_id, home_team_id, away_team_id, scheduled_at, status, is_draft)
select s.id, t.tids[1], t.tids[2], now() - interval '10 days', 'scheduled', false from s, t
union all
select s.id, t.tids[3], t.tids[4], now() + interval '40 days', 'scheduled', false from s, t
union all
select s.id, t.tids[1], t.tids[3], now() + interval '50 days', 'scheduled', true from s, t;

select 'replace', r.* from seasons s, lateral replace_published_schedule(s.id) r
 where s.name = 'Fall 2026';
select 'survivor', g.scheduled_at::date, g.is_draft
  from games g, seasons s
 where g.season_id = s.id and s.name = 'Fall 2026'
 order by g.scheduled_at;
rollback;
SQL
```
Expected: `replace` returns `deleted = 1, kept = 1, published = 1, refused = null`. `survivor` lists exactly two rows, both `is_draft = false`: the past-dated game (untouched) and the promoted draft. The future live game is gone.

- [ ] **Step 4: Append the `season_is_started` comment rewrite**

```sql
-- Retained, but nothing calls it any more.
--
-- It gated replace, remove, generateSchedule and the builder's locked mode.
-- All four now derive from scope instead, and "the season is under way" is the
-- `played` count from season_schedule_counts -- which says it better and comes
-- from the same snapshot as every other number on the screen.
--
-- Kept rather than dropped because 0026 and 0027 are applied to production and
-- a rollback to their code has to find this function still here. Dropping it
-- belongs in a later migration, once no deployed code path can want it.
comment on function public.season_is_started(uuid) is
  'DEPRECATED and unused. Superseded by season_schedulable_games / season_schedule_counts in 0029; retained only so a rollback to 0026-0028 code still resolves. Do not add callers.';
```

- [ ] **Step 5: Run the full unit suite to confirm nothing regressed yet**

Run: `npm test`
Expected: `publishMode.test.ts` still passes (it is unchanged until Task 5); everything else passes. If any test touches the RPC signatures it will fail here — note it and fix in the owning task.

- [ ] **Step 6: Commit**

```bash
git add supabase/migrations/0029_scheduling_is_future_only.sql
git commit -m "feat: scope replacing a schedule, and refuse a past-dated draft

Replacing now deletes only what is still schedulable, so a season under
way can have its remaining games regenerated without the delete ever
reaching a game that happened.

The past_draft refusal is what closes the original defect for good. The
form's min and the server-side clamp stop a manager creating one by
accident; this stops a stale tab or a draft left sitting across its own
start date from recreating the permanent lock.

Both for-update lines and 0028's zero-promotion raise are unchanged.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 4: Reproduce the races with two psql sessions

No code. This is the verification the spec's §10 requires and the brief's §7 explains: the `0028` TOCTOU sat in code an agent reviewed twice and passed both times. Reasoning is not evidence in this function.

**Files:**
- Create: `docs/superpowers/plans/2026-08-01-concurrency-notes.md` (findings)

- [ ] **Step 1: Open two psql sessions**

```bash
export DBURL="$(supabase status -o env | grep DB_URL | cut -d= -f2- | tr -d '"')"
# Terminal A
psql "$DBURL"
# Terminal B
psql "$DBURL"
```

- [ ] **Step 2: Reproduce the finalize-during-remove race WITHOUT the lock**

Temporarily comment out `perform 1 from games where season_id = p_season for update;` in `remove_published_schedule`, apply with `psql "$DBURL" -f supabase/migrations/0029_scheduling_is_future_only.sql`, then:

Session A:
```sql
begin;
-- Hold a future game, about to be finalized.
select id from games where season_id = '<season>' and not is_draft
   and scheduled_at >= now() limit 1 for update;
```
Session B:
```sql
select * from remove_published_schedule('<season>');   -- blocks on the delete
```
Session A:
```sql
update games set status = 'final', home_goals = 3 where id = '<the id>';
commit;
```
Expected WITHOUT the lock: session B deletes the now-finalized game. Record the returned `deleted`/`kept` and the game's absence.

- [ ] **Step 3: Restore the lock and repeat**

Uncomment the `for update`, re-apply, repeat Steps 2's sequence.
Expected WITH the lock: session B blocks *before* computing the scope, so on waking the finalized game fails `status = 'scheduled'` and is kept. `deleted` is one lower and the game still exists.

- [ ] **Step 4: Repeat both directions for `replace_published_schedule`**

Same sequence against `replace_published_schedule`, plus `0028`'s draft-deletion race: hold the drafts with `select ... for update` in session A, call replace in session B, delete the drafts in A and commit. Expected with the lock: B blocks and the drafts survive to be promoted.

- [ ] **Step 5: Write the findings up**

Record, for each race: the exact sequence, the observed result without the lock, the observed result with it, and the returned row in both cases. This is the artifact that makes the lock comments true rather than asserted.

- [ ] **Step 6: Commit**

```bash
git add docs/superpowers/plans/2026-08-01-concurrency-notes.md
git commit -m "test: reproduce the schedule RPC races in both directions

The 0028 TOCTOU passed self-review twice, including once right after a
different race in the same function had been reproduced. Reasoning is
not evidence here, so both for-update lines are now backed by an
observed failure with them removed and an observed pass with them in.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 5: Narrow `publishMode`'s locked state

**Files:**
- Modify: `src/lib/schedule/publishMode.ts`
- Test: `src/lib/schedule/publishMode.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `publishMode(state: { remainingCount: number; draftCount: number; readFailed: boolean }): PublishMode`. The `liveCount` and `started` fields are gone.

- [ ] **Step 1: Write the failing tests**

Replace the whole body of `publishMode.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { publishMode } from "./publishMode";

describe("publishMode", () => {
  it("is empty with nothing to schedule and no draft", () => {
    expect(publishMode({ remainingCount: 0, draftCount: 0, readFailed: false })).toBe("empty");
  });

  it("is draft-only when a draft exists and nothing is in scope", () => {
    expect(publishMode({ remainingCount: 0, draftCount: 40, readFailed: false })).toBe("draft-only");
  });

  it("is published when games remain to schedule and there is no draft", () => {
    expect(publishMode({ remainingCount: 40, draftCount: 0, readFailed: false })).toBe("published");
  });

  it("is replace when a draft would displace the remaining games", () => {
    expect(publishMode({ remainingCount: 40, draftCount: 42, readFailed: false })).toBe("replace");
  });

  it("locks only when the season could not be read", () => {
    expect(publishMode({ remainingCount: 40, draftCount: 42, readFailed: true })).toBe("locked");
  });

  it("offers a one-click publish mid-season once the remainder is removed", () => {
    // The case the old `started` flag got wrong. A season under way whose
    // remaining games have been removed has nothing in scope, so publishing a
    // fresh draft destroys nothing — the same reasoning that makes a season's
    // first publish one click with no confirm.
    expect(publishMode({ remainingCount: 0, draftCount: 60, readFailed: false })).toBe("draft-only");
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm test -- publishMode`
Expected: FAIL — TypeScript rejects `remainingCount`/`readFailed`, which are not on the parameter type.

- [ ] **Step 3: Rewrite the implementation**

```ts
/**
 * Which of the builder's five states a season is in.
 *
 * `locked` used to mean "season under way" and outranked everything, which is
 * what kept the delete in `replace_published_schedule` away from played games.
 * Scope does that now — a played game is outside the delete's WHERE — so this
 * locks for one reason only: the season's games could not be read, and every
 * count here is unknown rather than zero. See getPublishState's fail-closed
 * comment for why that locks rather than guesses.
 */
export type PublishMode =
  | "empty" // nothing in scope, nothing drafted
  | "draft-only" // publishing destroys nothing — one click, no confirm
  | "published" // games left to schedule, no draft to replace them with
  | "replace" // a draft would displace games still in scope — needs confirming
  | "locked"; // the season's games could not be read

export function publishMode(state: {
  /** Games still in scope for a scheduling operation — future and untouched. */
  remainingCount: number;
  draftCount: number;
  readFailed: boolean;
}): PublishMode {
  if (state.readFailed) return "locked";
  if (state.remainingCount === 0) return state.draftCount === 0 ? "empty" : "draft-only";
  return state.draftCount === 0 ? "published" : "replace";
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npm test -- publishMode`
Expected: PASS, 6 tests. The panel will not compile yet — that is Task 9.

- [ ] **Step 5: Commit**

```bash
git add src/lib/schedule/publishMode.ts src/lib/schedule/publishMode.test.ts
git commit -m "refactor: lock the builder only when its reads fail

'Started' no longer decides anything: a played game is outside a
scheduling operation's scope rather than a reason to refuse it. The one
remaining reason to offer no publish path is not knowing what the season
holds.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 6: Read the counts through one RPC

**Files:**
- Modify: `src/lib/queries/schedule.ts:170-291` (`SchedulePublishState`, `getPublishState`)
- Modify: `src/lib/db/types.ts` (regenerated)

**Interfaces:**
- Consumes: `season_schedule_counts(uuid)` from Task 1.
- Produces:
```ts
export type SchedulePublishState = {
  remainingCount: number;
  playedCount: number;
  draftCount: number;
  firstRemainingDate: string | null;  // league-local YYYY-MM-DD
  lastRemainingDate: string | null;
  undatedRemaining: number;
  lineupsAtRisk: number;
  readFailed: boolean;
};
export async function getPublishState(seasonId: string, opts?: { client?: DbClient }): Promise<SchedulePublishState>;
```

- [ ] **Step 1: Regenerate the database types**

Run: `npm run gen-types`
Expected: `src/lib/db/types.ts` gains `season_schedule_counts` and `season_schedulable_games`, and the two rewritten RPCs' return rows change shape.

- [ ] **Step 2: Replace the type**

```ts
/**
 * Everything the schedule builder needs to decide what it may offer.
 *
 * Read through one RPC rather than six PostgREST requests. Those were six
 * snapshots that could disagree with each other, and the predicate behind
 * `remainingCount` is time-dependent — computing it here in TypeScript would be
 * a second copy of the rule that guards the delete, free to drift from it.
 */
export type SchedulePublishState = {
  /** Future and untouched, plus postponed. What a replace or remove deletes. */
  remainingCount: number;
  /**
   * Live, not schedulable, not cancelled. Survives every operation, and counts
   * as played. Cancelled games are in neither count on purpose — they did not
   * happen — so these two do not sum to the season's live game count.
   */
  playedCount: number;
  draftCount: number;
  /** League-local YYYY-MM-DD of the first/last *dated* schedulable game. */
  firstRemainingDate: string | null;
  lastRemainingDate: string | null;
  /**
   * Schedulable games with no date — the postponed ones. They are in scope and
   * will be deleted, but no date range can show them, so any copy quoting a
   * range has to state this separately or it understates what is going.
   */
  undatedRemaining: number;
  /**
   * `game_rosters` rows on *schedulable* games. They cascade on game delete
   * (0004_games.sql), so a replace discards lineups a captain set in advance.
   * Scoped to schedulable rows: counting every live game's rosters overstates
   * the damage, in the direction that gets the warning ignored.
   */
  lineupsAtRisk: number;
  /**
   * True when the read failed. Every count here is then *unknown*, not zero —
   * anything rendering them has to say so instead of stating them.
   */
  readFailed: boolean;
};
```

- [ ] **Step 3: Replace the implementation**

```ts
export async function getPublishState(
  seasonId: string,
  opts: { client?: DbClient } = {},
): Promise<SchedulePublishState> {
  const supabase = opts.client ?? (await createClient());

  const { data, error } = await supabase.rpc("season_schedule_counts", {
    p_season: seasonId,
  });
  const row = data?.[0];

  // Fail closed, for the same reason the six separate reads did.
  //
  // Every decision the builder makes comes from these numbers — whether to
  // offer the generate form, whether publishing confirms first, and what the
  // confirmation says will be destroyed. Absorbing an error is the dangerous
  // one: it reads as remainingCount 0, which is publishMode's "draft-only", and
  // the manager gets a one-click publish with no dialog and no lineup warning
  // while the RPC behind that button still deletes everything in scope.
  //
  // Locking is the only honest way to fail closed. A count has no "unknown"
  // value publishMode could branch on, and inventing a non-zero one would put a
  // fabricated number in front of the manager on the one screen in this app
  // that deletes data. `readFailed` travels with the zeros so the card can say
  // the counts are unknown rather than state them.
  if (error || !row) {
    if (error) console.error("publish state read failed:", error.message);
    return {
      remainingCount: 0,
      playedCount: 0,
      draftCount: 0,
      firstRemainingDate: null,
      lastRemainingDate: null,
      undatedRemaining: 0,
      lineupsAtRisk: 0,
      readFailed: true,
    };
  }

  return {
    remainingCount: row.remaining,
    playedCount: row.played,
    draftCount: row.draft_count,
    firstRemainingDate: row.first_remaining ? leagueDateKey(row.first_remaining) : null,
    lastRemainingDate: row.last_remaining ? leagueDateKey(row.last_remaining) : null,
    undatedRemaining: row.undated_remaining,
    lineupsAtRisk: row.lineups_at_risk,
    readFailed: false,
  };
}
```

- [ ] **Step 4: Verify it type-checks**

Run: `npm run lint`
Expected: `schedule-builder-panel.tsx` errors on the removed `liveCount`/`started` fields. That is Task 9. No errors inside `src/lib/queries/schedule.ts` itself.

- [ ] **Step 5: Commit**

```bash
git add src/lib/queries/schedule.ts src/lib/db/types.ts
git commit -m "feat: read the builder's counts from one snapshot

Six independent PostgREST requests meant six snapshots that could
disagree — a live count from one instant beside a lineup count from
another. One RPC settles that, and keeps the time-dependent predicate in
the one place that also guards the delete.

lineupsAtRisk now counts rosters on schedulable games only. Counting
every live game's overstates what a replace destroys, which is the
direction that gets a warning ignored.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 7: Stop the generator producing a past-dated draft

**Files:**
- Modify: `src/lib/actions/schedule.ts:69-120` (`generateSchedule`)
- Modify: `src/components/manage/schedule-generate-form.tsx:106-125`

**Interfaces:**
- Consumes: `leagueDateKey` from `@/lib/format`.
- Produces: no new exports. `generateSchedule` no longer calls `season_is_started`.

- [ ] **Step 1: Remove the started guard from `generateSchedule`**

Delete this block (`src/lib/actions/schedule.ts:75-89`) entirely — the comment and the RPC call:

```ts
  // A started season can't publish, so it shouldn't accept a draft either —
  // ... (through) ...
  if (startedError || startedGuard !== false) return;
```

- [ ] **Step 2: Clamp a past start date**

Replace the `startDate` assignment (currently line 100):

```ts
  // Scheduling concerns the future, so a first game night in the past is not a
  // request this can honour — it is clamped to today rather than rejected.
  //
  // Rejecting would mean a seventh silent `return` in a function whose six
  // existing guards all fail silently, and the manager would get a form that
  // appears to do nothing. Clamping is also the forgiving reading of the rule:
  // you asked for the past, the past is not schedulable, here is the earliest
  // thing that is. `enumerateNights` then finds the first night from here that
  // matches the chosen weekdays and skip dates.
  //
  // This is ergonomics, not the guarantee. `replace_published_schedule` refuses
  // a past-dated draft outright (migration 0029) — that is what makes a
  // past-dated schedule unpublishable however it came to exist.
  const today = leagueDateKey(new Date().toISOString());
  const requested = String(formData.get("start_date") ?? "") || season?.starts_on || "";
  const startDate = requested && requested < today ? today : requested;
```

Add `leagueDateKey` to the existing `@/lib/format` import (it currently imports `leagueOffset, formatGameTime`).

- [ ] **Step 3: Give the date input a floor**

In `schedule-generate-form.tsx`, add a `todayKey` helper beside `dateKey` and use it for both `min` and the default:

```tsx
/** Today in the browser's local zone, as a YYYY-MM-DD key. */
function todayKey(): string {
  return dateKey(new Date());
}
```

```tsx
        <div className="space-y-1">
          <Label htmlFor="start_date">First game night</Label>
          <Input
            id="start_date"
            name="start_date"
            type="date"
            required
            // A season whose start date has already passed used to pre-fill a
            // past date here, and the generator honoured it — which is how a
            // draft became unpublishable the moment it went live. The floor and
            // the default are what a manager sees; the server clamps anything
            // that gets past them.
            min={todayKey()}
            defaultValue={
              seasonStart && seasonStart > todayKey() ? seasonStart : todayKey()
            }
          />
        </div>
```

- [ ] **Step 4: Also floor the skip-date calendar**

The calendar's `disabled` matcher uses `seasonStart`, which can now be behind the floor. Replace lines 105-107:

```tsx
  const disabled: Matcher[] = [];
  // Same floor as the start-date input: a skip date before today can only
  // exclude a night that was never going to be scheduled.
  const floor = seasonStart && seasonStart > todayKey() ? seasonStart : todayKey();
  disabled.push({ before: parseKey(floor) });
  if (seasonEnd) disabled.push({ after: parseKey(seasonEnd) });
```

- [ ] **Step 5: Verify**

Run: `npm run lint && npm test`
Expected: lint clean apart from the panel errors from Task 6; unit tests pass.

- [ ] **Step 6: Commit**

```bash
git add src/lib/actions/schedule.ts src/components/manage/schedule-generate-form.tsx
git commit -m "fix: never pre-fill or accept a first game night in the past

The form defaulted to the season's start date with no floor, so setting
up a season that had already begun produced a past-dated draft by
default — invisible to the old started-gate right up until publish, at
which point the season locked permanently.

The generator no longer consults season_is_started either: a season
under way can be drafted against, because publishing now touches only
what is still schedulable.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 8: Map the new refusals to what the manager is told

**Files:**
- Modify: `src/lib/actions/schedule.ts:236-358` (`publishSchedule`, `removeSchedule`)

**Interfaces:**
- Consumes: the RPC return rows from Tasks 2 and 3 (`kept` is new; `started`/`no_games` are gone).
- Produces: unchanged `PublishState` / `RemoveState` shapes.

- [ ] **Step 1: Rewrite `publishSchedule`'s refusal branches**

Replace the `row.refused === "started"` branch with:

```ts
  if (row.refused === "past_draft") {
    revalidateAfterPublish(seasonId);
    return {
      ok: false,
      message:
        "This draft has games dated in the past. Generate it again from today or later, then publish.",
    };
  }
```

Keep the `no_draft` branch as it is.

- [ ] **Step 2: Report what was kept**

Replace the success return:

```ts
  return {
    ok: true,
    message:
      row.deleted > 0
        ? `Replaced the remaining schedule — removed ${row.deleted} games, published ${row.published}.${
            row.kept > 0 ? ` ${row.kept} already-played games were left alone.` : ""
          }`
        : `Published ${row.published} games.`,
  };
```

- [ ] **Step 3: Rewrite `removeSchedule`'s refusal branch**

Replace both the `started` and `no_games` branches with one:

```ts
  if (row.refused === "nothing_to_remove") {
    revalidateAfterPublish(seasonId);
    return { ok: false, message: "There's nothing left to remove — every remaining game has been played or cancelled." };
  }
```

- [ ] **Step 4: Report what was kept, and audit it**

```ts
  await logAudit({
    user_id: user.id,
    action: "remove_schedule",
    entity_type: "season",
    entity_id: seasonId,
    old_data: { published_games: row.deleted + row.kept },
    new_data: { published_games: row.kept },
  });

  revalidateAfterPublish(seasonId);

  return {
    ok: true,
    message: `Removed the remaining schedule — ${row.deleted} games deleted.${
      row.kept > 0 ? ` ${row.kept} played or cancelled games were left alone.` : ""
    }`,
  };
```

Leave the `await` on `logAudit` and its comment exactly as they are — `c46f864` fixed that deliberately.

- [ ] **Step 5: Verify**

Run: `npm run lint && npm test`
Expected: clean apart from the panel (Task 9).

- [ ] **Step 6: Commit**

```bash
git add src/lib/actions/schedule.ts
git commit -m "feat: tell the manager what a schedule change kept

Both operations now leave played games behind rather than refusing when
any exist, so the toast has to name what survived — otherwise 'removed
154 games' reads as the whole season on a season that still holds 18.

'The season is under way' is gone as a refusal; the only way to be
refused now is asking for something that is not there.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 9: Show the split, and stop calling a season locked

**Files:**
- Modify: `src/components/manage/schedule-builder-panel.tsx`
- Modify: `src/components/manage/publish-controls.tsx:26-43,102-112`
- Modify: `src/components/manage/remove-controls.tsx:16-44,73-89`

**Interfaces:**
- Consumes: `SchedulePublishState` (Task 6), `publishMode` (Task 5).
- Produces: `PublishControls` gains `keptCount: number` and `undatedRemaining: number`; `liveCount` is renamed `remainingCount` and `liveRange` to `remainingRange`. `RemoveControls` gains `keptCount: number` and `undatedRemaining: number`.

- [ ] **Step 1: Rewire the panel's state derivation**

Replace lines 63-80:

```tsx
  const readFailed = publish.readFailed || !!draftsError;
  if (draftsError) console.error("draft read failed:", draftsError.message);

  const mode = publishMode({
    remainingCount: publish.remainingCount,
    draftCount: publish.draftCount,
    readFailed,
  });

  const hasDraft = !readFailed && publish.draftCount > 0;
```

Note the simplification: `readFailed` now feeds `publishMode` directly, so the old `started: publish.started || !!draftsError` dance and its comment go away.

- [ ] **Step 2: Replace the locked card with the read-failure card**

Replace the whole `mode === "locked" ? (...)` card with the read-failure copy alone — the "season is under way" branch is deleted:

```tsx
      {mode === "locked" ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">
              This season&apos;s games couldn&apos;t be read
            </CardTitle>
          </CardHeader>
          <CardContent className="text-muted-foreground space-y-2 text-sm">
            <p>
              Something went wrong reading this season&apos;s games, so the
              builder is locked rather than acting on counts it doesn&apos;t
              have. The schedule itself is untouched — reload to try again.
            </p>
          </CardContent>
        </Card>
      ) : (
```

- [ ] **Step 3: State the split above the generate form**

Immediately inside the non-locked branch, before the "Generate a balanced schedule" card:

```tsx
          {publish.playedCount > 0 ? (
            <div className="text-muted-foreground space-y-2 text-sm">
              <p>
                <span className="text-foreground font-medium">
                  {publish.playedCount} games played
                </span>{" "}
                · {publish.remainingCount} remaining
              </p>
              <p>
                Scheduling only affects the {publish.remainingCount} remaining
                games. Games that have been played stay as they are — to change
                one, use Reschedule, Postpone or Cancel on its score page.
              </p>
            </div>
          ) : null}
```

- [ ] **Step 4: Update the published/replace block**

Replace the `Published: {publish.liveCount} games` paragraph:

```tsx
              <p>
                <span className="text-foreground font-medium">
                  Remaining: {publish.remainingCount} games
                </span>
                {publish.firstRemainingDate && publish.lastRemainingDate
                  ? ` · ${formatLongDate(publish.firstRemainingDate)} → ${formatLongDate(publish.lastRemainingDate)}`
                  : ""}
              </p>
```

- [ ] **Step 5: Pass the new props**

`RemoveControls` call site — key on `remainingCount`, which still drops to 0 on success:

```tsx
                  <RemoveControls
                    key={publish.remainingCount}
                    seasonId={seasonId}
                    lineupsAtRisk={publish.lineupsAtRisk}
                    keptCount={publish.playedCount}
                    undatedRemaining={publish.undatedRemaining}
                  />
```

`PublishControls` call site:

```tsx
              <PublishControls
                key={publish.draftCount}
                seasonId={seasonId}
                draftCount={publish.draftCount}
                remainingCount={publish.remainingCount}
                keptCount={publish.playedCount}
                undatedRemaining={publish.undatedRemaining}
                remainingRange={
                  publish.firstRemainingDate && publish.lastRemainingDate
                    ? `${formatLongDate(publish.firstRemainingDate)} – ${formatLongDate(publish.lastRemainingDate)}`
                    : null
                }
                lineupsAtRisk={publish.lineupsAtRisk}
                destructive={mode === "replace"}
              />
```

- [ ] **Step 6: Update the two dialogs**

`publish-controls.tsx` — rename the props in the signature (`liveCount` → `remainingCount`, `liveRange` → `remainingRange`, plus `keptCount` and `undatedRemaining`), change `const range = remainingRange ? ...`, and replace the description body:

```tsx
                <p>
                  This deletes {remainingCount} remaining games{range} and
                  publishes the {draftCount}-game draft in their place.
                </p>
                {undatedRemaining > 0 ? (
                  <p>
                    {undatedRemaining} of those are postponed games with no date,
                    so they aren&apos;t in the range above.
                  </p>
                ) : null}
                {keptCount > 0 ? (
                  <p>
                    {keptCount} games that have already been played will be left
                    exactly as they are.
                  </p>
                ) : null}
                <p>Team calendar feeds will change.</p>
                {lineupsAtRisk > 0 ? (
                  <p>
                    {lineupsAtRisk} lineup entries already set for those games
                    will be deleted with them.
                  </p>
                ) : null}
```

`remove-controls.tsx` — add `keptCount` and `undatedRemaining` to the signature and replace the description body:

```tsx
                <p>
                  {keptCount > 0
                    ? "The season will keep its played games and have nothing scheduled until you generate and publish a new schedule."
                    : "The season will have no games until you generate and publish a new one."}
                </p>
                {undatedRemaining > 0 ? (
                  <p>
                    This includes {undatedRemaining} postponed games waiting to
                    be rescheduled.
                  </p>
                ) : null}
                {lineupsAtRisk > 0 ? (
                  <p>
                    {lineupsAtRisk} lineup entries captains have already set will
                    be deleted. The games can be regenerated; those cannot.
                  </p>
                ) : null}
```

Replace `remove-controls.tsx`'s third and fourth header paragraphs (the ones starting "The panel renders this only in "published" mode" and "The dialog is short on purpose") with:

```
 * The panel renders this only in "published" mode — games still in scope, no
 * draft. Deliberately not in "replace": a draft survives a removal, so the
 * dialog below would be telling a manager who already has one that the season
 * has nothing scheduled until they generate another. Replace is the operation
 * for that case.
 *
 * The dialog is short on purpose, and the reason changed without the copy
 * needing to. It used to be that removal was reachable only before a season
 * started, so nothing had been played. Now removal is reachable at any time —
 * but it deletes only games that are still schedulable, which by definition
 * have not been played. Either way nothing unrecoverable goes except lineups:
 * `game_rosters` cascades on game delete, and a captain's lineup does not come
 * back when the schedule is regenerated. That is still the one detail here.
```

- [ ] **Step 7: Verify**

Run: `npm run lint && npm test && npm run build`
Expected: all clean.

- [ ] **Step 8: Commit**

```bash
git add src/components/manage/
git commit -m "feat: show what a season has played and what is left to schedule

The locked card was the mid-season experience, and it was wrong twice
over: it said the schedule could never be regenerated, which is no
longer true, and it said so on seasons that had merely been generated
from a past date.

In its place the builder states the split, and both dialogs now name
what survives — including postponed games, which are deleted but carry
no date and so never appear in the range.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 10: A seed fixture that straddles now

**Files:**
- Modify: `supabase/seed.sql:170-186`

The existing fixtures are date literals: Spring 2026 (May–June 2026, entirely past) and Fall 2026 (no games). Neither exercises the mixed case this feature is *about*, and a literal-dated fixture would silently stop straddling as real time passes.

**Interfaces:**
- Consumes: nothing.
- Produces: a season named `Winter 2026` in the Oceanview league with games on both sides of `now()`.

- [ ] **Step 1: Add the straddling season after the Fall 2026 block**

```sql
  -- A season under way: games on both sides of now(), so the schedule builder
  -- has a fixture for the case it exists to handle.
  --
  -- Dated relative to now() rather than by literal, deliberately. A literal
  -- straddling season stops straddling as real time passes, and it does so
  -- silently -- the tests keep running and quietly stop testing the thing.
  declare
    v_winter uuid;
    v_n int;
  begin
    insert into seasons (league_id, name, starts_on, ends_on, is_active, point_system)
      values (v_league, 'Winter 2026',
              (now() - interval '21 days')::date,
              (now() + interval '90 days')::date,
              false, '{"win":2,"tie":1,"loss":0}'::jsonb)
      returning id into v_winter;

    for i in 1 .. array_length(v_team_ids, 1) loop
      insert into season_teams (season_id, team_id) values (v_winter, v_team_ids[i]);
    end loop;

    -- Three past nights and three future ones, two games each.
    for v_n in -3 .. 3 loop
      continue when v_n = 0;
      insert into games (season_id, home_team_id, away_team_id, scheduled_at, status, round, is_draft)
        values
          (v_winter, v_team_ids[1], v_team_ids[2],
           now() + (v_n * interval '7 days'),
           case when v_n < 0 then 'final' else 'scheduled' end,
           abs(v_n), false),
          -- The load-bearing row: a past game still sitting at 'scheduled' with
          -- no score. Indistinguishable from an untouched fixture by status or
          -- score, and the reason the rule is a date test rather than either.
          (v_winter, v_team_ids[3], v_team_ids[4],
           now() + (v_n * interval '7 days'),
           'scheduled', abs(v_n), false);
    end loop;

    -- Scores for the finals, so `played` is not derivable from status alone.
    update games set home_goals = 3, away_goals = 2
     where season_id = v_winter and status = 'final';

    -- One postponed game: in scope for a scheduling operation, but with no date
    -- for any range to show.
    insert into games (season_id, home_team_id, away_team_id, scheduled_at, postponed_from, status, round, is_draft)
      values (v_winter, v_team_ids[5], v_team_ids[6], null,
              now() + interval '14 days', 'postponed', 2, false);

    -- One cancelled game: survives every operation and counts as neither
    -- remaining nor played.
    insert into games (season_id, home_team_id, away_team_id, scheduled_at, status, round, is_draft)
      values (v_winter, v_team_ids[5], v_team_ids[6], now() + interval '21 days',
              'cancelled', 3, false);

    -- A game finalized early while still carrying a future date. The date test
    -- alone would hand this to the delete; the status and score clauses exist
    -- for exactly this row and nothing else.
    insert into games (season_id, home_team_id, away_team_id, scheduled_at, status, home_goals, away_goals, round, is_draft)
      values (v_winter, v_team_ids[1], v_team_ids[5], now() + interval '28 days',
              'final', 4, 1, 3, false);
  end;
```

- [ ] **Step 2: Verify the fixture reports the shape the tests need**

Run:
```bash
npm run db:reset
psql "$(supabase status -o env | grep DB_URL | cut -d= -f2- | tr -d '"')" -c "
  select c.* from seasons s, lateral season_schedule_counts(s.id) c
   where s.name = 'Winter 2026';"
```
Expected: `remaining = 7` (6 future scheduled + 1 postponed), `played = 7` (3 past finals + 3 past-scheduled + 1 early-finalized future game), `cancelled = 1`, `undated_remaining = 1`.

- [ ] **Step 3: Verify the whole scope matrix against the fixture**

This is the spec §10 case list, run in one place now that a fixture exists with every row type in it.

Run:
```bash
npm run db:reset
psql "$(supabase status -o env | grep DB_URL | cut -d= -f2- | tr -d '"')" <<'SQL'
begin;
-- Give one schedulable game and one played game a lineup row each, so
-- lineups_at_risk can be shown to count only the schedulable one.
with w as (select id from seasons where name = 'Winter 2026' limit 1),
     picks as (
       select (select g.id from games g, w
                where g.season_id = w.id and g.status = 'scheduled'
                  and g.scheduled_at > now() limit 1) as future_id,
              (select g.id from games g, w
                where g.season_id = w.id and g.status = 'final' limit 1) as played_id
     ),
     p as (select team_id, player_id from game_rosters limit 1)
insert into game_rosters (game_id, team_id, player_id)
select picks.future_id, p.team_id, p.player_id from picks, p
union all
select picks.played_id, p.team_id, p.player_id from picks, p;

select 'counts', c.* from seasons s, lateral season_schedule_counts(s.id) c
 where s.name = 'Winter 2026';

select 'removed', r.* from seasons s, lateral remove_published_schedule(s.id) r
 where s.name = 'Winter 2026';

select 'survivors', g.status, count(*)
  from games g, seasons s
 where g.season_id = s.id and s.name = 'Winter 2026' and not g.is_draft
 group by g.status order by g.status;
rollback;
SQL
```

Expected, and each line is a spec §10 case:
- `counts.lineups_at_risk = 1` — the played game's lineup is not counted.
- `removed.deleted = 7` — the 6 future `scheduled` games **and the postponed one**.
- `survivors` contains **no** `postponed` row — postponed games are in scope and were deleted.
- `survivors` shows `cancelled = 1` — a cancelled game survives and was never counted as played.
- `survivors` shows `final = 4` — the 3 past finals **and the early-finalized future game**, which the date test alone would have deleted.
- `survivors` shows `scheduled = 3` — the past-dated, unscored games. This is the row the whole rule exists for: indistinguishable from a fixture by status or score, kept by its date.

- [ ] **Step 4: Commit**

```bash
git add supabase/seed.sql
git commit -m "test: seed a season with games on both sides of now

Every existing fixture is entirely past or entirely empty, so nothing
covered the case this feature is about. Dated relative to now() because
a literal straddling season stops straddling as time passes, and does it
without failing a test.

Includes the two rows that make the rule necessary: a past game still
sitting at 'scheduled' with no score, and a postponed game with no date
at all.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 11: End-to-end — regenerate a season under way

**Files:**
- Modify: `e2e/11-schedule-builder.spec.ts:188-200` (replace the locked test)

**Interfaces:**
- Consumes: the `Winter 2026` fixture from Task 10.

- [ ] **Step 1: Replace the "a started season locks the builder" test**

```ts
  test("a season under way offers to regenerate what is left", async ({ page }) => {
    // The defect this feature exists for: one played game used to freeze the
    // whole season, including games months away, with no way out through the
    // UI. Winter 2026 straddles now(), so it is the fixture for the rule.
    await page.goto("/seasons");
    await page
      .getByRole("row", { name: /Winter 2026/ })
      .getByRole("link", { name: "Setup" })
      .click();
    await page.waitForURL(/\/seasons\//);

    await expect(page.getByText(/\d+ games played/)).toBeVisible();
    await expect(page.getByText(/\d+ remaining/)).toBeVisible();
    // The locked card is gone; the form is on the page.
    await expect(page.getByText("The season is under way")).toHaveCount(0);
    await expect(page.getByText("Generate a balanced schedule")).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Generate schedule" }),
    ).toBeVisible();
  });

  test("the first game night cannot be set in the past", async ({ page }) => {
    // The pre-filled default was the whole cause: a season whose start date had
    // passed handed the manager a past-dated draft without them doing anything
    // unusual.
    const input = page.getByLabel("First game night");
    const today = new Date().toISOString().slice(0, 10);
    await expect(input).toHaveAttribute("min", today);
    const value = await input.inputValue();
    expect(value >= today).toBe(true);
  });

  test("replacing a season under way keeps its played games", async ({ page }) => {
    await page.goto("/seasons");
    await page
      .getByRole("row", { name: /Winter 2026/ })
      .getByRole("link", { name: "Setup" })
      .click();
    await page.waitForURL(/\/seasons\//);

    const playedText = await page.getByText(/\d+ games played/).textContent();
    const played = Number(playedText!.match(/\d+/)![0]);

    await page.getByLabel("Games per team").fill("4");
    await page.locator('label:has-text("Tue") input[name="weekdays"]').check();
    await page.getByRole("button", { name: "Generate schedule" }).click();

    await page.getByRole("button", { name: "Replace published schedule" }).click();
    await expect(page.getByText("Replace the published schedule?")).toBeVisible();
    // The dialog has to say what survives, or "deletes N games" reads as the
    // whole season on a season that keeps most of it.
    await expect(
      page.getByText(new RegExp(`${played} games that have already been played`)),
    ).toBeVisible();
    await page.getByRole("button", { name: "Replace", exact: true }).click();

    // Same count as before: nothing the replace did touched them.
    await expect(page.getByText(`${played} games played`)).toBeVisible();
  });
```

- [ ] **Step 2: Fix the remaining assertions in this file**

Three literal replacements, all because `Published: N games` became `Remaining: N games`:

- Line ~142 and ~162 (republish test): `page.getByText(\`Published: ${published} games\`)` → `page.getByText(\`Remaining: ${published} games\`)`, three occurrences.
- Line ~166 (replace dialog): `This deletes ${published} live games` → `This deletes ${published} remaining games`.
- Line ~184 (after discard): same `Published:` → `Remaining:` rename.
- Line ~211 and ~245 (removal test): the `/Published: \d+ games|No draft schedule/` matcher → `/Remaining: \d+ games|No draft schedule/`, and `page.getByText(/Published: \d+ games/)` → `/Remaining: \d+ games/`.

The removal test's dialog body assertion (`/The season will have no games until you generate/`) is unchanged: Fall 2026 has no played games, so `keptCount` is 0 and the dialog takes the same branch it always did. That is worth keeping as-is rather than loosening — it is the assertion that proves an unstarted season still behaves exactly as before.

- [ ] **Step 3: Run the e2e suite**

Run: `npm run test:e2e -- 11-schedule-builder`
Expected: all pass. Then `npm run test:e2e` for the full suite — `01-public` and `05-scoring` read game lists and may see the new Winter 2026 season.

- [ ] **Step 4: Commit**

```bash
git add e2e/11-schedule-builder.spec.ts
git commit -m "test: cover regenerating a season that is already under way

The old test asserted the builder locks once a season starts, which was
the defect rather than the requirement. It now asserts the thing that
replaced it: the split is stated, the form is offered, and a replace
leaves the played games at exactly the count they had.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 12: Correct the handoffs

**Files:**
- Modify: `EXPORTS_HANDOFF.md` §3
- Modify: `AGENTS.md` (only if it names the started-gate)

This is bigger than one paragraph. §3 carries **six** consecutive blocks about the schedule gate, and one of them prohibits precisely what this branch built:

> Don't "improve" this by adding a partial replace that keeps played games and drops the rest — that reintroduces exactly the class of bug the gate was written to make unreachable, and it needs the generator seeded with games-played and home/away already accrued or the back half of the season won't balance against the front.

Leaving that in place would have the handoff telling the next agent to undo this work. It has to be answered, not deleted — and the answer is that the warning was right about the mechanism and wrong about the alternative, which is worth saying out loud.

- [ ] **Step 1: Read the whole affected region**

Run: `awk '/^## 3\./,/^## 4\./' EXPORTS_HANDOFF.md`

The blocks that change all sit between "**Publishing replaces; a started season refuses.**" and "**Why there is no bulk cancel for a started season.**", plus the `locked`-mode paragraph at the end of §3.

- [ ] **Step 2: Replace the "Publishing replaces" block through the `game_rosters` paragraph**

```markdown
**Publishing replaces; scheduling touches only the future.** `publishSchedule`
calls `replace_published_schedule`, which deletes the season's *schedulable*
games and promotes the drafts in one transaction. Schedulable is defined once,
in `season_schedulable_games` (0029): future and untouched, plus postponed.

Protecting played games is a *consequence* of that scope, not a rule anything
applies. No code walks a set of games deciding which to keep — a played game is
simply not in the delete's WHERE. That is a stronger guarantee than the gate it
replaced, because the gate was all-or-nothing: one played game removed the
delete path for the entire season, including games months away, which is how a
schedule generated from a past start date could lock a season permanently with
no way out through the UI.

**This supersedes a warning that used to live here.** Until 0029 this section
said: don't add a partial replace that keeps played games and drops the rest,
because it reintroduces the class of bug the gate made unreachable, and it needs
the generator seeded with games-played and home/away or the back half won't
balance against the front.

The first half was right about the mechanism and wrong about the alternative.
The bug it feared is *selecting* which live games to delete by asking whether
each was played — a question `status` and `home_goals` cannot answer, since a
game played last night that nobody scored looks exactly like an untouched
fixture. 0029 never asks it. It selects by date, and a played game is
necessarily in the past, so the same test covers the scored case and the
played-but-unentered case together. Nothing judges.

The second half was simply correct, and is being paid: seeding the generator
from played games is a follow-on spec, and neither ships alone. If you are
reading this and a mid-season regeneration produces a draft blind to what was
played, that spec did not land — say so rather than working around it.

The row locks are still load-bearing, for a narrower reason than before. The
guard and the delete are separate statements, so under READ COMMITTED they see
separate snapshots; without the locks a game finalized *between* them is deleted,
because the delete re-evaluates its WHERE against the new row version. `now()` is
transaction-scoped and so cannot drift mid-call, but the rows can — the locks are
what make "the set the guard checked" and "the set the delete acts on" the same
set. Reproduced in both directions; see
`docs/superpowers/plans/2026-08-01-concurrency-notes.md`. Don't drop them.

The locks cover games that already exist. A played game *inserted* concurrently
in the same window cannot be locked and would still be deleted — though it would
now also have to be inserted with a future date to be in scope at all. Nothing
does that today (the esportsdesk import writes finals only into a season it
creates itself, and the one-off planner only inserts future `scheduled` rows), so
if you add a path that bulk-inserts games into a live season, this is the
assumption you are breaking.

`game_rosters` cascades on game delete, so a replace also discards lineups a
captain set in advance — but only for games still in scope, which is what
`lineups_at_risk` counts and what the confirm dialog states.
```

- [ ] **Step 3: Replace the "Removing is the same gate" block**

```markdown
**Removing is the same scope without the promotion.** `removeSchedule` calls
`remove_published_schedule`, which deletes the season's schedulable games and
leaves the played ones alone — the case `replace_published_schedule` cannot
serve, because it needs a draft standing ready. It carries 0026's advisory lock
and the same `for update`, needed here for exactly the same reason: the hazard is
in the guard reading a stale snapshot, not in the promotion that follows it.
Don't drop it on the grounds that this function promotes nothing.

It no longer empties a season. On a season with nothing played it does, which is
why the dialog's original copy still holds there; on a season under way it leaves
the played games and reports both numbers.

Removal is offered in `published` mode only, not `replace`. The RPC filters
`not is_draft`, so a draft survives a removal, and the dialog's "nothing
scheduled until you generate and publish" would be false in front of a manager
who already has one. If you add removal to replace mode, the copy has to branch.

Its dialog is deliberately shorter than the replace dialog: no game count, no
calendar-feed line. What it deletes has not been played — that is what
schedulable means — and the games regenerate from the form directly above, so
only the cascading lineups are a real loss and they are the only thing it
mentions.
```

- [ ] **Step 4: Correct the two trailing claims**

The "no bulk cancel" block ends with: *"Leaving it unbuilt is what keeps the played-game guarantee above structural: nothing selects which live games to delete."* That sentence is now false — 0029 selects. Replace its last sentence with:

```markdown
Its predicate is close to `season_schedulable_games`, and 0029 has now accepted
the principle behind it. If it is ever built it should be built as an
implementation of that scope rather than as a new rule — and its warning about
`.ics` subscribers losing a season of events at once still needs settling first.
```

Then the final `locked`-mode paragraph: `locked` no longer means "season under way", so the instruction to suppress the publish control on a started season describes a state that cannot occur. Replace with:

```markdown
The builder renders five modes off `publishMode`. `locked` now means only that
the season's games could not be read — every count is unknown rather than zero,
so the card must say so instead of stating them. A season under way is not
locked; it renders the generate form with a played/remaining split above it.
```

- [ ] **Step 5: Check the other two docs**

Run: `grep -n "started\|season_is_started\|locked" AGENTS.md SCHEDULE_HANDOFF.md`
`SCHEDULE_HANDOFF.md`'s only hit is the word "started" in its opening sentence, unrelated. Correct anything that describes the gate as live; skip if there is nothing.

- [ ] **Step 6: Full verification**

Run: `npm run lint && npm test && npm run build && npm run test:e2e`
Expected: all green. Record the actual counts (`N passed`), do not assert them from memory. The pre-branch baseline was unit 177/177 and e2e 66 passed / 1 skipped / 0 failed; this branch adds tests, so the numbers should rise rather than match.

- [ ] **Step 7: Commit**

```bash
git add EXPORTS_HANDOFF.md AGENTS.md
git commit -m "docs: record that scope, not a gate, protects played games

EXPORTS_HANDOFF §3 credited the row locks with the played-game
guarantee. They are still load-bearing, but for a narrower reason: they
hold the schedulable set still between the guard and the delete. What
makes a played game unreachable is that it is outside the scope, not
that anything refuses on its behalf.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Notes for the reviewer

**Get a fresh-context reviewer on `0029` specifically.** The brief's §7 and the
`self-review-misses-sql-races` memory both say the same thing: the `0028` TOCTOU
passed self-review twice in this exact function. Task 4's reproduction artifact
is the evidence to review against, not the reasoning in the comments.

**Deliberately deferred to the follow-on spec:** seeding the generator from
played games (spec §9). Until that lands, a mid-season regeneration produces a
draft balanced within the remaining window and blind to what was played. Neither
spec ships to production alone.
