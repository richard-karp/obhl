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

grant execute on function public.season_is_started(uuid) to authenticated;
grant execute on function public.replace_published_schedule(uuid) to authenticated;
