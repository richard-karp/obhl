-- Atomic counter bump for the scorekeeper board + indexes for hot queries.

-- Atomically adjust a dressed player's goals/assists/pim by `p_delta`, clamped at
-- 0. Runs as the INVOKER (default), so the game_rosters RLS policies still gate
-- who can write (scorekeeper/manager only — captains have no UPDATE policy).
-- This replaces a read-modify-write in the action that could lose concurrent taps.
create or replace function public.bump_game_roster_stat(
  p_id uuid, p_col text, p_delta int
) returns void language plpgsql set search_path = public as $$
begin
  if p_col = 'goals' then
    update game_rosters set goals = greatest(0, goals + p_delta) where id = p_id;
  elsif p_col = 'assists' then
    update game_rosters set assists = greatest(0, assists + p_delta) where id = p_id;
  elsif p_col = 'pim' then
    update game_rosters set pim = greatest(0, pim + p_delta) where id = p_id;
  else
    raise exception 'invalid stat column: %', p_col;
  end if;
end $$;
grant execute on function public.bump_game_roster_stat(uuid, text, int) to authenticated;

-- Indexes for the common filters (enrollment lookups, roster/stat joins,
-- player-visibility checks, and the stat-view GROUP BYs).
create index if not exists season_teams_season_idx on season_teams (season_id);
create index if not exists team_players_season_team_idx on team_players (season_id, team_id);
create index if not exists team_players_player_idx on team_players (player_id);
create index if not exists game_rosters_player_idx on game_rosters (player_id);
create index if not exists game_rosters_team_idx on game_rosters (team_id);
