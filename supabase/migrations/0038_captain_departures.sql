-- After 0036 a roster row is history, not a statement about the present. Two
-- things were reading it as the latter.

-- 1. A transferred captain kept write access to their FORMER team for the rest
--    of the season. `is_captain_of` only asked whether a roster row with
--    `is_captain` existed, and after 0036 that row survives the transfer — so
--    the RLS policies over game_rosters (0009) kept saying yes.
--
-- `transferPlayer` and `removeRosterPlayer` also clear `is_captain` on the row
-- they retire, and both halves ship: an app guard plus an independent RLS half
-- is this codebase's standing pattern, and this is the half that holds when the
-- app is not the one asking.
create or replace function public.is_captain_of(p_team uuid, p_season uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from team_players tp
    join profiles pr on pr.player_id = tp.player_id
    where pr.id = auth.uid()
      and tp.team_id = p_team
      and tp.season_id = p_season
      and tp.is_captain
      and tp.left_on is null
  );
$$;

-- 2. `player_is_public` (0008) is the other one, and it is deliberately left
--    ALONE. Recorded here because "0038 filtered one and not the other" is the
--    sort of asymmetry a later reader fixes by accident.
comment on function public.player_is_public(uuid) is
  'Deliberately does NOT filter team_players.left_on. A player who left a team is still a real person who appeared in a public league, and their profile page and stat lines must keep resolving. This answers "may this person be seen at all", not "are they on a roster today".';
