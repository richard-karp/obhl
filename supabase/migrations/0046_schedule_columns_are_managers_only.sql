-- Only a league manager may change a game's SCHEDULE. Scoring is unaffected.
--
-- ⛔ THE HOLE THIS CLOSES, AND WHY IT WAS NOT ONE UNTIL NOW. `0032`'s
-- "scorekeeper update games" policy is `for update` over the WHOLE ROW, because
-- **RLS cannot restrict columns** — a policy is a row predicate, and there is no
-- per-column form of it. That was correct when it was written (`0009`):
-- scorekeepers legitimately cancelled and postponed games, so "may update this
-- row" and "may do the things we mean" were the same sentence.
--
-- They stopped being the same on 2026-09-07, when the rule became that
-- scorekeepers "can only score games" and `cancelGame`, `postponeGame`,
-- `restoreGame` and `rescheduleGame` moved to manager-only guards. The guards
-- were then the ONLY thing standing there: a scorekeeper's own session, with the
-- publishable key, still wrote `status`, `scheduled_at` and both team ids
-- directly. Demonstrated, not theorised — `e2e/30-schedule-edits.spec.ts` has a
-- test that cancelled a published game this way and got no error back.
--
-- ⚠️ A TIGHTER `with check` CANNOT DO THIS, WHICH IS WHY IT IS A TRIGGER. A
-- policy sees only the NEW row. Telling "a scorekeeper edited the goals" from "a
-- scorekeeper moved the game" needs OLD as well, and only a row trigger has it.
--
-- ⚠️ IT ALSO CLOSES A SECOND DOOR NOBODY HAD LOOKED AT. `postpone_game` and
-- `restore_game` (`0025`) are `security invoker` and granted to `authenticated`,
-- so a scorekeeper could call them directly and get the same result by another
-- route. Because they are invoker, their UPDATE runs as the caller and lands
-- here like any other — one check covers both doors.

create or replace function public.guard_game_schedule_columns()
returns trigger
language plpgsql
set search_path = public as $$
declare
  -- The statuses SCORING moves a game through. `bumpStat` sets in_progress,
  -- `finalizeGame` sets final, `reopenGame` sets in_progress again — all with
  -- the scorekeeper's own session, all legitimate. `postponed` and `cancelled`
  -- are not in here: those are decisions about whether the game HAPPENS, which
  -- is the whole line this trigger draws.
  scoring_statuses constant text[] := array['scheduled', 'in_progress', 'final'];
  changed_schedule boolean;
begin
  changed_schedule :=
       new.scheduled_at   is distinct from old.scheduled_at
    or new.home_team_id   is distinct from old.home_team_id
    or new.away_team_id   is distinct from old.away_team_id
    or new.is_draft       is distinct from old.is_draft
    or new.season_id      is distinct from old.season_id
    or new.postponed_from is distinct from old.postponed_from
    -- A status change counts as a schedule change only when it leaves or enters
    -- the scoring lifecycle. scheduled -> final is scoring; scheduled ->
    -- cancelled is not.
    or (new.status is distinct from old.status
        and not (new.status::text = any(scoring_statuses)
                 and old.status::text = any(scoring_statuses)));

  if not changed_schedule then
    return new;
  end if;

  -- The server's own admin client (`createAdminClient`), migrations, and psql.
  -- `apply_game_writes` and every schedule action reach the table this way, and
  -- their authorisation is the guard in `src/lib/auth` plus `requireGameRole`,
  -- not this trigger. ⚠️ `current_user` is the right test precisely BECAUSE
  -- PostgREST does `set role` per request: a service_role call is
  -- `service_role` here, a browser's call is `authenticated`.
  if current_user in ('service_role', 'postgres') then
    return new;
  end if;

  if manages_league(season_league(new.season_id)) then
    return new;
  end if;

  raise exception
    'Only a league manager can change a game''s schedule. Scoring a game is unaffected.'
    using errcode = '42501';
end;
$$;

comment on function public.guard_game_schedule_columns() is
  'Refuses a non-manager who changes a game''s date, teams, draft flag or schedule status. RLS cannot restrict columns, so this is the column half of "scorekeepers can only score games".';

drop trigger if exists guard_game_schedule_columns on games;
create trigger guard_game_schedule_columns
  before update on games
  for each row execute function public.guard_game_schedule_columns();
