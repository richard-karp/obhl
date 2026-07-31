-- Close a TOCTOU in replace_published_schedule that could empty a season and
-- report it as a success.
--
-- 0026 locked `not is_draft` rows before the started-gate, which correctly
-- protects a concurrently-finalized game. But the *second* guard — "is there a
-- draft to promote?" — reads draft rows, and those were never locked. Under
-- READ COMMITTED each statement in a plpgsql function takes a fresh snapshot,
-- so the promotion UPDATE runs on a later snapshot than the guard that
-- authorised it. Anything deleting drafts in between wins.
--
-- Reproduced against 0026: hold the draft rows with `select ... for update`,
-- call replace_published_schedule (its guard is a plain SELECT, which does not
-- block on row locks, so it sees the drafts and proceeds), then delete the
-- drafts and commit while the promotion waits on them. The call returned
-- `deleted=4, published=0, refused=null` and left the season with ZERO games —
-- and publishSchedule maps a null `refused` to a success toast reading
-- "removed 4 games, published 0".
--
-- That is the exact outcome 0026's own header says the function exists to
-- prevent. Both paths that delete drafts (discardSchedule, generateSchedule)
-- are plain PostgREST deletes that take no advisory lock, and in `replace` mode
-- the builder renders Generate, Replace and Discard on the same screen.
--
-- Two changes, one belt and one braces:
--
--   1. The lock now covers every game in the season, drafts included, so a
--      concurrent draft delete blocks until we commit — after which it
--      re-evaluates and matches nothing, because those rows are live now.
--
--   2. Promoting zero drafts raises instead of returning. It should be
--      unreachable with (1) in place, but the cost of being wrong is a season
--      with no games, and a raise rolls the delete back rather than committing
--      the emptiness. An error the manager can retry beats a green toast over
--      a deleted schedule.
create or replace function public.replace_published_schedule(p_season uuid)
returns table (deleted int, published int, refused text)
language plpgsql security invoker set search_path = public as $$
declare
  v_deleted int := 0;
  v_published int := 0;
begin
  -- Serialize publishes per season. Without it two managers publishing at once
  -- can both observe drafts present without either's snapshot seeing the other,
  -- and the second deletes what the first just promoted. Released at commit.
  perform pg_advisory_xact_lock(hashtext(p_season::text));

  -- Every game in the season, not just the live ones.
  --
  -- The live rows are locked for the reason 0026 gives: the gate and the delete
  -- are separate statements, so without the lock a game finalized between them
  -- is deleted while the gate reports the season unstarted. That reasoning is
  -- unchanged and still load-bearing.
  --
  -- The draft rows are locked because the no_draft guard below reads them and
  -- the promotion at the end writes them, with the live DELETE in between. See
  -- this migration's header for the reproduction.
  perform 1 from games where season_id = p_season for update;

  if season_is_started(p_season) then
    return query select 0, 0, 'started'::text;
    return;
  end if;

  -- Nothing to promote. Now actually true when it says so: the drafts it reads
  -- are locked above, so nothing can remove them before the promotion runs.
  if not exists (select 1 from games where season_id = p_season and is_draft) then
    return query select 0, 0, 'no_draft'::text;
    return;
  end if;

  delete from games where season_id = p_season and not is_draft;
  get diagnostics v_deleted = row_count;

  update games set is_draft = false where season_id = p_season and is_draft;
  get diagnostics v_published = row_count;

  -- Unreachable while the lock above holds. Kept because the failure it guards
  -- is a season with no games at all, and rolling back is strictly better than
  -- reporting that as a successful replace.
  if v_published = 0 then
    raise exception
      'replace_published_schedule: deleted % live games but promoted no drafts; rolling back',
      v_deleted
      using hint = 'A concurrent write removed the drafts after the no_draft guard passed.';
  end if;

  return query select v_deleted, v_published, null::text;
end;
$$;

comment on function public.replace_published_schedule(uuid) is
  'Replace a season''s published schedule with its drafts, in one transaction. Refuses once the season has started. Locks every game in the season so neither the started gate nor the no_draft guard can be invalidated between check and act.';
