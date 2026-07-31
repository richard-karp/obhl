-- A season may have at most one published schedule.
--
-- Publishing was a bulk flip of is_draft, and generation deleted only drafts, so
-- nothing stopped a second generate+publish from leaving the season holding two
-- complete overlapping schedules — both live in the schedule page, both .ics
-- feeds, the CSV, and standings.
--
-- Publishing now replaces: the season's live games are deleted and the drafts
-- take their place, in one transaction. Once the season has started it refuses
-- outright, which is also the entire protection for played games — see below.

-- The rule, defined once. Three consumers: the gate in
-- replace_published_schedule, generateSchedule's early return, and the builder
-- UI. A second copy of this predicate in TypeScript would be free to drift.
--
-- Each predicate covers the others' blind spot:
--   scheduled_at < now()   a night has passed. The load-bearing one: a game
--                          played last night that nobody has scored yet is
--                          still a played game.
--   status <> 'scheduled'  someone acted on it. Catches a game finalized early
--                          with a future date, and a postponed game, whose
--                          scheduled_at is null and so invisible to the first.
--   goals > 0              a score exists. Both columns are not null default 0.
create or replace function public.season_is_started(p_season uuid)
returns boolean language sql stable security invoker set search_path = public as $$
  select exists (
    select 1 from games
     where season_id = p_season and not is_draft
       and (scheduled_at < now()
            or status <> 'scheduled'
            or home_goals > 0 or away_goals > 0)
  );
$$;

comment on function public.season_is_started(uuid) is
  'True once any published game in the season has been played or acted on. The gate on replacing a schedule.';

-- Delete the live schedule and promote the drafts, atomically.
--
-- Run as two PostgREST calls instead, a failure between them leaves the season
-- with ZERO games: old schedule deleted, new one still in draft, and the public
-- schedule page, both calendar feeds and the CSV all empty. Same reasoning as
-- postpone_game/restore_game in 0025.
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

  -- Lock the rows the delete below will remove, BEFORE the gate reads them.
  --
  -- This is what makes "a played game removes the delete path" actually true,
  -- rather than only true when nothing else is running. Under READ COMMITTED the
  -- gate and the delete are separate statements with separate snapshots, so
  -- without this lock a scorekeeper who commits `status='final'` in between is
  -- invisible to the gate and fatal to the game: season_is_started() reads the
  -- pre-finalize snapshot and returns false, the delete then blocks on the
  -- scorekeeper's row lock, and on waking re-evaluates its WHERE against the NEW
  -- row version — which still matches `season_id = ? and not is_draft`. The
  -- finalized game is deleted, its game_rosters cascade with it, and the call
  -- reports a clean `deleted=N, published=N, refused=null`. Nothing surfaces.
  --
  -- Taking the locks first moves that wait to before the gate: the concurrent
  -- finalize either commits before us (and the gate, on its own later snapshot,
  -- sees it and refuses) or waits behind us (and finalizes a game that is
  -- already gone, which is the pre-existing stale-tab case). The check and the
  -- act become one decision instead of two.
  perform 1 from games where season_id = p_season and not is_draft for update;

  -- Evaluated inside the transaction on purpose. The rule is time-based, so a
  -- check in TypeScript followed by a separate write would let a game 30 seconds
  -- from its start time tick past while the replace is in flight.
  if season_is_started(p_season) then
    return query select 0, 0, 'started'::text;
    return;
  end if;

  -- Nothing to promote. Without this a stale form submit — draft discarded in
  -- another tab — deletes the live schedule and publishes nothing in its place.
  if not exists (select 1 from games where season_id = p_season and is_draft) then
    return query select 0, 0, 'no_draft'::text;
    return;
  end if;

  delete from games where season_id = p_season and not is_draft;
  get diagnostics v_deleted = row_count;

  update games set is_draft = false where season_id = p_season and is_draft;
  get diagnostics v_published = row_count;

  return query select v_deleted, v_published, null::text;
end;
$$;

comment on function public.replace_published_schedule(uuid) is
  'Replace a season''s published schedule with its drafts, in one transaction. Refuses once the season has started.';

-- service_role only, stated explicitly in both directions.
--
-- Unlike 0025's postpone/restore — called with the *user* client from the score
-- page — both of these are reached exclusively through createAdminClient():
-- getPublishState and generateSchedule read season_is_started, publishSchedule
-- calls replace_published_schedule. Granting `authenticated` instead, as 0025
-- does, would work here only by accident of the legacy auto-expose default that
-- hands every Data API role EXECUTE (see auto_expose_new_tables in
-- supabase/config.toml, whose implicit default flipped to false on 2026-05-30).
-- On a project with the new behaviour these RPCs would return permission denied,
-- and because getPublishState fails closed on RPC error every season would
-- render as locked and the builder would be unusable.
--
-- The revokes are not redundant with omitting a grant. CREATE FUNCTION grants
-- EXECUTE to PUBLIC by default, so while auto-expose is still on, "we never
-- granted it to authenticated" does not mean authenticated cannot call it — it
-- reaches it through PUBLIC. Only revoking makes the intent true today as well
-- as after the default flips, and it matters most for
-- replace_published_schedule: through PostgREST that is a one-call "delete this
-- season's published schedule", and no code path calls it with a user client.
revoke execute on function public.season_is_started(uuid) from public, anon, authenticated;
revoke execute on function public.replace_published_schedule(uuid) from public, anon, authenticated;
grant execute on function public.season_is_started(uuid) to service_role;
grant execute on function public.replace_published_schedule(uuid) to service_role;
