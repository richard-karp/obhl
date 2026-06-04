-- Role/write RLS layered on top of the public-read policies from 0008.

-- Coarse role from the caller's profile (always fresh; no JWT staleness).
create or replace function public.auth_role()
returns app_role language sql stable security definer set search_path = public as $$
  select role from profiles where id = auth.uid();
$$;

-- Is the current user a captain of this team for this season?
create or replace function public.is_captain_of(p_team uuid, p_season uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from team_players tp
    join profiles pr on pr.player_id = tp.player_id
    where pr.id = auth.uid()
      and tp.team_id = p_team
      and tp.season_id = p_season
      and tp.is_captain
  );
$$;

-- Authenticated users get table-level write privilege; RLS gates the rows.
grant insert, update, delete on all tables in schema public to authenticated;

-- Manager: full control of league configuration tables.
create policy "manager write leagues" on leagues
  for all to authenticated
  using (public.auth_role() = 'league_manager') with check (public.auth_role() = 'league_manager');
create policy "manager write seasons" on seasons
  for all to authenticated
  using (public.auth_role() = 'league_manager') with check (public.auth_role() = 'league_manager');
create policy "manager write divisions" on divisions
  for all to authenticated
  using (public.auth_role() = 'league_manager') with check (public.auth_role() = 'league_manager');
create policy "manager write teams" on teams
  for all to authenticated
  using (public.auth_role() = 'league_manager') with check (public.auth_role() = 'league_manager');
create policy "manager write players" on players
  for all to authenticated
  using (public.auth_role() = 'league_manager') with check (public.auth_role() = 'league_manager');
create policy "manager write season_teams" on season_teams
  for all to authenticated
  using (public.auth_role() = 'league_manager') with check (public.auth_role() = 'league_manager');
create policy "manager write team_players" on team_players
  for all to authenticated
  using (public.auth_role() = 'league_manager') with check (public.auth_role() = 'league_manager');
create policy "manager write league_rules" on league_rules
  for all to authenticated
  using (public.auth_role() = 'league_manager') with check (public.auth_role() = 'league_manager');

-- Games: manager full; scorekeeper may update any game, including a completed
-- one — a game can be "completed" then still corrected after the fact. Captains
-- never write games.
create policy "manager write games" on games
  for all to authenticated
  using (public.auth_role() = 'league_manager') with check (public.auth_role() = 'league_manager');
create policy "scorekeeper update games" on games
  for update to authenticated
  using (public.auth_role() = 'scorekeeper')
  with check (public.auth_role() = 'scorekeeper');

-- Game rosters: manager full. Scorekeeper may edit the lineup / counters at any
-- time (so completed games stay fixable). A captain may set their own team's
-- lineup only until the game is finalized.
create policy "manager write game_rosters" on game_rosters
  for all to authenticated
  using (public.auth_role() = 'league_manager') with check (public.auth_role() = 'league_manager');
create policy "scorekeeper write game_rosters" on game_rosters
  for all to authenticated
  using (public.auth_role() = 'scorekeeper')
  with check (public.auth_role() = 'scorekeeper');
create policy "captain write game_rosters" on game_rosters
  for all to authenticated
  using (
    exists (
      select 1 from games g
      where g.id = game_rosters.game_id and g.finalized_at is null
        and public.is_captain_of(game_rosters.team_id, g.season_id)
    )
  )
  with check (
    exists (
      select 1 from games g
      where g.id = game_rosters.game_id and g.finalized_at is null
        and public.is_captain_of(game_rosters.team_id, g.season_id)
    )
  );

-- Scoring (goals/assists/PIM) lives on game_rosters counters, covered by the
-- game_rosters policies above: the scorekeeper bumps them while the game is not
-- finalized. Captains set the dressed lineup but the UI does not expose the
-- stat counters to them.

-- Profiles: own row read/update; managers read & manage all.
create policy "own profile read" on profiles
  for select to authenticated using (id = auth.uid());
create policy "manager read profiles" on profiles
  for select to authenticated using (public.auth_role() = 'league_manager');
create policy "own profile update" on profiles
  for update to authenticated using (id = auth.uid()) with check (id = auth.uid());
create policy "manager write profiles" on profiles
  for all to authenticated
  using (public.auth_role() = 'league_manager') with check (public.auth_role() = 'league_manager');
