-- What 0036's three partial indexes actually enforce, run against a live
-- database rather than argued from the DDL.
--
--   psql "postgresql://postgres:postgres@127.0.0.1:54322/postgres" -f scripts/prove-roster-indexes.sql
--
-- Everything happens inside a transaction that rolls back, so it is safe to run
-- against a seeded local database. It writes, so it is LOCAL ONLY.
--
-- Assertion 5 is the one worth keeping: 0036 deliberately left
-- `unique (season_id, team_id, player_id)` from 0003 non-partial, which is what
-- forces transferPlayer to clear `left_on` on a return to a former team instead
-- of inserting a second row.
\set ON_ERROR_STOP on
begin;
do $$
declare
  v_season uuid; v_league uuid; v_team uuid; v_team2 uuid;
  a uuid; b uuid; jn int;
begin
  select id, league_id into v_season, v_league from seasons where is_active limit 1;
  select id into v_team  from teams where league_id = v_league order by name limit 1;
  select id into v_team2 from teams where league_id = v_league and id <> v_team order by name limit 1;

  insert into players (first_name, last_name) values ('Index','Probe A') returning id into a;
  insert into players (first_name, last_name) values ('Index','Probe B') returning id into b;
  select coalesce(max(jersey_number), 0) + 50 into jn
    from team_players where season_id = v_season and team_id = v_team;

  insert into team_players (season_id, team_id, player_id, jersey_number, position)
    values (v_season, v_team, a, jn, 'F');

  -- 1. two ACTIVE rows with the same jersey on one team must be rejected
  begin
    insert into team_players (season_id, team_id, player_id, jersey_number, position)
      values (v_season, v_team, b, jn, 'F');
    raise exception 'FAIL 1: a second active row took jersey % on the same team', jn;
  exception when unique_violation then
    raise notice 'PASS 1: duplicate ACTIVE jersey rejected with 23505';
  end;

  -- 2. the same jersey where the first row has departed must insert
  update team_players set left_on = current_date
    where season_id = v_season and team_id = v_team and player_id = a;
  insert into team_players (season_id, team_id, player_id, jersey_number, position)
    values (v_season, v_team, b, jn, 'F');
  raise notice 'PASS 2: jersey % reused after the previous holder departed', jn;

  -- 3. two ACTIVE rows for one player in one season must be rejected
  begin
    insert into team_players (season_id, team_id, player_id, jersey_number, position)
      values (v_season, v_team2, b, jn + 1, 'F');
    raise exception 'FAIL 3: a player was made active on two teams in one season';
  exception when unique_violation then
    raise notice 'PASS 3: second ACTIVE team rejected with 23505';
  end;

  -- 4. and the transfer shape — depart, then join — must be allowed, or B6
  --    cannot be written at all
  update team_players set left_on = current_date
    where season_id = v_season and team_id = v_team and player_id = b;
  insert into team_players (season_id, team_id, player_id, jersey_number, position)
    values (v_season, v_team2, b, jn + 1, 'F');
  raise notice 'PASS 4: departed-then-joined accepted (the transfer shape)';

  -- 5. the unique that 0036 deliberately did NOT make partial: a return to a
  --    former team must not be able to insert a second row for that team
  begin
    insert into team_players (season_id, team_id, player_id, jersey_number, position)
      values (v_season, v_team, b, jn + 2, 'F');
    raise exception 'FAIL 5: a returning player got a second row for the same team';
  exception when unique_violation then
    raise notice 'PASS 5: return to a former team rejected — B6 must clear left_on instead';
  end;
end $$;
rollback;
