-- Postponing a game now clears its date. A postponed game is not being played
-- when it was scheduled, and leaving scheduled_at in place made every consumer
-- state something untrue: the schedule page listed it on that night, the
-- calendar feeds published it, and the CSV asserted it.
--
-- The old date moves to postponed_from rather than being dropped, so the night
-- stays discoverable by the one-off planner (which locks a night containing a
-- non-scheduled game), Restore has somewhere to go back to, and postponing is
-- not a destructive act — status changes are not audited.
alter table games add column postponed_from timestamptz;

comment on column games.postponed_from is
  'Where a postponed game was scheduled before it was postponed. Null unless status = postponed.';

-- Existing postponed rows predate the column. Without this they keep a date they
-- are not being played on, and — now that exports no longer withhold postponed
-- games — would be published at it.
update games
   set postponed_from = scheduled_at,
       scheduled_at = null
 where status = 'postponed'
   and scheduled_at is not null;

-- A column-to-column move can't be expressed through PostgREST, so these are
-- RPCs rather than a read-then-write from the client: one round trip, and no
-- window where a concurrent update sees a half-applied transition.
create or replace function public.postpone_game(p_game uuid)
returns void language plpgsql security invoker set search_path = public as $$
begin
  update games
     set status = 'postponed',
         -- coalesce so postponing an already-postponed game doesn't overwrite
         -- the original date with the null it now carries.
         postponed_from = coalesce(postponed_from, scheduled_at),
         scheduled_at = null
   where id = p_game;
end;
$$;

create or replace function public.restore_game(p_game uuid)
returns void language plpgsql security invoker set search_path = public as $$
begin
  -- A cancelled game kept its date and only flips status; a postponed one gets
  -- its date back. coalesce covers both, and a postponed game that never had a
  -- date stays undated rather than failing.
  --
  -- Restricted to the two statuses the Restore button is offered for. Without
  -- it, restoring a finished game silently discards the result and returns it to
  -- 'scheduled' while its goals stay on the row.
  update games
     set status = 'scheduled',
         scheduled_at = coalesce(scheduled_at, postponed_from),
         postponed_from = null
   where id = p_game
     and status in ('cancelled', 'postponed');
end;
$$;

grant execute on function public.postpone_game(uuid) to authenticated;
grant execute on function public.restore_game(uuid) to authenticated;
