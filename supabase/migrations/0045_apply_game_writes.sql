-- Rewrite a batch of a season's games in ONE transaction.
--
-- Replaces the compensation machinery in `src/lib/schedule/gameWrites.ts`: a
-- pre-flight read, a conditional UPDATE per row, and — when one failed partway
-- — an attempt to undo the ones that had already landed. That code was correct
-- as far as TypeScript can be, and three review rounds each found the next bug
-- one layer down (read-then-write with no serialization; a compensator that was
-- itself a lost-update writer; only the first failure in each 25-way chunk
-- kept). The remaining hole cannot be closed in TypeScript at all: if the
-- runtime dies between a write and its compensation, the written rows stay
-- written, and the public schedule page, both iCal feeds and the CSV all read
-- `games` live.
--
-- A transaction rolls back for free. That is the whole idea.
--
-- ⛔ THIS FUNCTION MUST NOT REFUSE A STARTED SEASON, AND THE ABSENCE OF THAT
-- CHECK IS DELIBERATE. `0026_replace_published_schedule.sql` — the file you
-- almost certainly have open, because this borrows its lock and grant pattern —
-- calls `season_is_started()` and refuses. That is right THERE: publish/replace
-- is the one-way door. It is wrong here. Repair, night moves and the manual
-- schedule edits exist precisely to work on a live, locked season; that is why
-- they rewrite rows in place instead of going through the generator. Adding
-- `season_is_started` here would silently disable every one of them the moment
-- the first game is played — AND EVERY TEST WOULD STILL PASS, because every
-- spec seeds an unstarted season. Do not "fix" its absence.

create or replace function public.apply_game_writes(
  p_season uuid,
  p_writes jsonb,
  -- Which statuses a row may hold and still be rewritten. The default is the
  -- historical behaviour: generate, repair and the one-off planner all rewrite
  -- fixtures nobody has touched. The manual edit actions pass their own set.
  p_statuses text[] default array['scheduled'],
  -- One side of the draft/published divide, or null for both. A season holds a
  -- published schedule and a draft AT THE SAME TIME — that is what `publishMode`
  -- "replace" IS — and an unscoped write lets a caller pair a published game
  -- with a draft one, leaving each set separately unbalanced.
  p_is_draft boolean default null
) returns table (applied int, refused uuid, reason text)
language plpgsql security invoker set search_path = public as $$
declare
  v_ids uuid[];
  v_bad uuid;
  v_bad_count int := 0;
  v_applied int := 0;
begin
  -- ⛔ A NULL OR EMPTY `p_statuses` WOULD DISABLE THE STATUS CHECK ENTIRELY,
  -- NOT TIGHTEN IT. `g.status = any(null)` is NULL, `not NULL` is NULL, and a
  -- NULL disjunct never selects a row — so the whole batch would sail past the
  -- one check that keeps a played game from being rewritten. Measured before
  -- this guard existed: `p_statuses => null` rewrote a `final` game and
  -- returned applied=1. Raising rather than defaulting, because a caller that
  -- sent nothing did not mean "anything goes"; it has a bug.
  if p_statuses is null or cardinality(p_statuses) = 0 then
    raise exception 'apply_game_writes requires a non-empty p_statuses';
  end if;
  -- Serialize every writer on this season. Released at commit.
  --
  -- This is the interleaving case that has been open since review round 1 and
  -- that nothing in TypeScript could ever have closed: two managers applying
  -- different repair plans concurrently each pass their own checks against
  -- their own snapshot and then interleave. Games-played, byes and weekday
  -- survive — that is `checkOneOffWrite`'s invariant — but pair balance drifts
  -- with no drift report anywhere.
  perform pg_advisory_xact_lock(hashtext(p_season::text));

  -- ⛔ AN ENTRY WITH NO `id` USED TO DISABLE CONFLICT DETECTION FOR THE WHOLE
  -- BATCH, AND THAT WAS THE WORST BUG IN THIS FUNCTION. The refusal below
  -- selected an id INTO a scalar and fired on `v_bad is not null`; a null id
  -- made that scalar null, so `if v_bad is not null` did not fire and NOTHING
  -- was refused. Measured: a batch of [entry with no id, entry with a stale
  -- `expect`] applied the stale one and returned success — a lost update
  -- written over a mismatched expectation, which is the exact failure this
  -- function exists to make impossible. Rejected here, before anything else
  -- looks at the payload.
  -- ⚠️ ALSO CATCHES A MALFORMED ID. Without this, `(w->>'id')::uuid` fails at
  -- the cast with a raw "invalid input syntax for type uuid", which `writeGames`
  -- then puts in front of a manager verbatim. It fails closed either way; this
  -- makes it fail closed with a sentence about the payload rather than about
  -- Postgres.
  --
  -- ⚠️ A REGEX, NOT `pg_input_is_valid`. That function is Postgres 16+, and this
  -- migration has to run on a production instance whose version is not knowable
  -- from this checkout. Not worth a version dependency for a validation.
  if exists (
    select 1 from jsonb_array_elements(p_writes) w
     where (w->>'id') is null
        or (w->>'id') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  ) then
    raise exception 'apply_game_writes got a write with a missing or malformed id';
  end if;

  -- ⚠️ Also refuses a duplicate id. `update … from` joins each row ONCE, so two
  -- entries for one game apply one arbitrary write and report row_count 1 —
  -- a silently discarded write, and no defined answer to which one won.
  if (select count(*) from jsonb_array_elements(p_writes)) <>
     (select count(distinct (w->>'id')) from jsonb_array_elements(p_writes) w) then
    raise exception 'apply_game_writes got the same game id twice';
  end if;

  select array_agg((w->>'id')::uuid) into v_ids
    from jsonb_array_elements(p_writes) w;

  -- An empty batch is a success, matching `applyGameWrites`' early return.
  if v_ids is null then
    return query select 0, null::uuid, null::text;
    return;
  end if;

  -- ⛔ LOCK THE ROWS BEFORE ANYTHING READS THEM FOR A DECISION. 0026:59 does
  -- the same thing and its comment explains why at length: under READ COMMITTED
  -- a check and a write are separate statements with separate snapshots, so a
  -- scorekeeper committing `status='final'` in between is invisible to the check
  -- and fatal to the game. Taking the locks first moves that wait to before the
  -- check — the concurrent writer either commits before us and we see it, or
  -- waits behind us. The check and the act become one decision instead of two.
  perform 1 from games
   where season_id = p_season
     and id = any(v_ids)
     and (p_is_draft is null or is_draft = p_is_draft)
   for update;

  -- Refuse the whole batch if ANY row is missing, holds a status this caller may
  -- not rewrite, or no longer matches what the plan was computed against.
  --
  -- ⛔ `is distinct from`, NEVER `<>`. SQL's `= NULL` is never true and `label`
  -- is null on most games, so `<>` here would report every unlabelled game as a
  -- mismatch and turn the feature into a permanent refusal. The TypeScript this
  -- replaces worked around the same trap with a two-branch `.is()`/`.eq()`
  -- dance; the null-safe operator is the simplification the move to SQL buys.
  --
  -- ⚠️ A key ABSENT from `expect` is not checked — `next` and `expect` name the
  -- same columns by construction, and a caller that omits one is declaring it
  -- does not care. `jsonb_exists` rather than the `?` operator purely for
  -- legibility.
  -- ⛔ COUNT FIRST, NAME SECOND. The refusal fires on `v_bad_count > 0`, never
  -- on `v_bad is not null` — see the null-id note above for what that cost.
  -- `v_bad` is only for the message, and a null one is now impossible anyway.
  -- ⚠️ `min(w->>'id')` on TEXT, then cast. Postgres has no `min(uuid)` — writing
  -- `min((w->>'id')::uuid)` compiles fine and fails at RUNTIME, on the conflict
  -- path only, turning every clean refusal into an unhandled exception.
  select count(*), min(w->>'id')::uuid into v_bad_count, v_bad
    from jsonb_array_elements(p_writes) w
    left join games g
      on g.id = (w->>'id')::uuid
     and g.season_id = p_season
     and (p_is_draft is null or g.is_draft = p_is_draft)
   where g.id is null
      or not (g.status::text = any(p_statuses))
      or (jsonb_exists(w->'expect', 'scheduled_at')
          and g.scheduled_at is distinct from (w->'expect'->>'scheduled_at')::timestamptz)
      or (jsonb_exists(w->'expect', 'home_team_id')
          and g.home_team_id is distinct from (w->'expect'->>'home_team_id')::uuid)
      or (jsonb_exists(w->'expect', 'away_team_id')
          and g.away_team_id is distinct from (w->'expect'->>'away_team_id')::uuid)
      or (jsonb_exists(w->'expect', 'label')
          and g.label is distinct from (w->'expect'->>'label'));

  if v_bad_count > 0 then
    -- ⛔ A REFUSAL IS A RETURN, NOT AN EXCEPTION. Raising would roll back just
    -- the same, but gives the caller nothing to name in its message — and the
    -- message is the entire user-facing behaviour of a conflict.
    return query select 0, v_bad, 'conflict'::text;
    return;
  end if;

  -- One statement. `case … end` per column rather than `coalesce`, because
  -- `label` is legitimately set to NULL and coalesce would silently keep the old
  -- value instead of clearing it.
  update games g set
    home_team_id = case when jsonb_exists(w.next, 'home_team_id')
                        then (w.next->>'home_team_id')::uuid else g.home_team_id end,
    away_team_id = case when jsonb_exists(w.next, 'away_team_id')
                        then (w.next->>'away_team_id')::uuid else g.away_team_id end,
    label        = case when jsonb_exists(w.next, 'label')
                        then (w.next->>'label') else g.label end,
    scheduled_at = case when jsonb_exists(w.next, 'scheduled_at')
                        then (w.next->>'scheduled_at')::timestamptz else g.scheduled_at end
    from (
      select (e->>'id')::uuid as id, e->'next' as next
        from jsonb_array_elements(p_writes) e
    ) w
   where g.id = w.id
     and g.season_id = p_season
     and (p_is_draft is null or g.is_draft = p_is_draft);
  get diagnostics v_applied = row_count;

  return query select v_applied, null::uuid, null::text;
end;
$$;

comment on function public.apply_game_writes(uuid, jsonb, text[], boolean) is
  'Rewrite a batch of a season''s games in one transaction, refusing the whole batch if any row has moved. Deliberately does NOT check season_is_started — see 0026 and the comment above.';

-- service_role only, stated in both directions.
--
-- ⛔ THE REVOKE IS NOT REDUNDANT WITH OMITTING THE GRANT. `create function`
-- grants EXECUTE to PUBLIC by default, so while `auto_expose_new_tables` is
-- still on (supabase/config.toml), "we never granted it to authenticated" does
-- not mean authenticated cannot call it — it reaches it through PUBLIC. Through
-- PostgREST this function is a one-call "rewrite these games", so that
-- distinction is the whole of its access control. Every caller reaches it
-- through `createAdminClient()`. Exactly what 0026:118-127 does, for exactly
-- the same reason.
revoke execute on function public.apply_game_writes(uuid, jsonb, text[], boolean) from public, anon, authenticated;
grant execute on function public.apply_game_writes(uuid, jsonb, text[], boolean) to service_role;
