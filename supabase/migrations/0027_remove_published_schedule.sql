-- Remove a season's published schedule, leaving it with no games.
--
-- 0026's replace_published_schedule can only delete a live schedule when a draft
-- is standing ready to take its place. is_draft is one-way and every other
-- delete against games in the app is filtered is_draft = true, so a season whose
-- published schedule was simply wrong could be overwritten but never emptied.
--
-- Same gate as the replace, deliberately: protecting played games stays a
-- consequence of "a started season refuses" rather than a rule this function
-- applies, so no code here walks a set of games deciding which to keep.
create or replace function public.remove_published_schedule(p_season uuid)
returns table (deleted int, refused text)
language plpgsql security invoker set search_path = public as $$
declare
  v_deleted int := 0;
begin
  -- Same key as replace_published_schedule, so a remove and a replace on one
  -- season cannot interleave. Released at commit.
  perform pg_advisory_xact_lock(hashtext(p_season::text));

  -- Lock the rows the delete will remove, BEFORE the gate reads them.
  --
  -- Not redundant just because nothing is promoted afterwards — the hazard is in
  -- the gate, not the promotion. Under READ COMMITTED the gate and the delete are
  -- separate statements with separate snapshots, so without this lock a
  -- scorekeeper committing status='final' between them is invisible to the gate
  -- and fatal to the game: the gate reads the pre-finalize snapshot and returns
  -- false, the delete then blocks on the scorekeeper's row lock and on waking
  -- re-evaluates its WHERE against the NEW row version, which still matches
  -- `season_id = ? and not is_draft`. The finalized game is deleted, game_rosters
  -- cascades with it, and the call reports a clean success. 0026 carries the full
  -- reproduction; it was found by review, not by a test, and no test catches its
  -- removal here either.
  perform 1 from games where season_id = p_season and not is_draft for update;

  -- Evaluated inside the transaction, like 0026's. The rule is time-based, so a
  -- check in TypeScript followed by a separate write would let a game 30 seconds
  -- from its start time tick past while the removal is in flight.
  if season_is_started(p_season) then
    return query select 0, 'started'::text;
    return;
  end if;

  -- Nothing live. Reported rather than silently succeeding, so a stale tab's
  -- second submit does not come back as "removed 0 games" and read as a success.
  if not exists (select 1 from games where season_id = p_season and not is_draft) then
    return query select 0, 'no_games'::text;
    return;
  end if;

  delete from games where season_id = p_season and not is_draft;
  get diagnostics v_deleted = row_count;

  return query select v_deleted, null::text;
end;
$$;

comment on function public.remove_published_schedule(uuid) is
  'Delete a season''s published schedule, leaving it with no games. Refuses once the season has started.';

-- service_role only, stated in both directions.
--
-- Reached exclusively through createAdminClient() (removeSchedule in
-- src/lib/actions/schedule.ts). The revoke is not redundant with omitting a
-- grant: CREATE FUNCTION grants EXECUTE to PUBLIC by default, so an un-revoked
-- function is a one-call "delete this season's published schedule" through
-- PostgREST for any authenticated user. See 0026's grant block for the full
-- reasoning, including why 0025's `authenticated` grant is not the pattern to
-- copy here.
revoke execute on function public.remove_published_schedule(uuid) from public, anon, authenticated;
grant execute on function public.remove_published_schedule(uuid) to service_role;
