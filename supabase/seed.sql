-- Seed: TWO leagues so the league switcher and cross-league players are real.
--   * Oceanview Beer Hockey League — 6 teams, ~14 players each, 5 rounds
--     (rounds 1-3 final with goals/penalties, 4-5 upcoming).
--   * Harbor Rec Hockey League — 4 teams, ~12 players each, 3 rounds
--     (rounds 1-2 final, round 3 upcoming).
-- Two Oceanview people also skate in Harbor (shared global identity).
-- Plus a few league announcements. Deterministic (no random()).

-- Session-temp helper: finalize a game (dressed rosters + goals + penalties).
-- pg_temp is dropped automatically at the end of the seed session.
create function pg_temp.finalize_seed_game(
  p_season uuid, p_home uuid, p_away uuid, p_sched timestamptz,
  p_rnd int, p_hg int, p_ag int
) returns void language plpgsql as $fn$
declare
  v_game uuid; h_sk uuid[]; a_sk uuid[]; n_h int; n_a int; k int;
begin
  insert into games (season_id, home_team_id, away_team_id, scheduled_at, status,
                     week, round, home_goals, away_goals, result_type, finalized_at)
    values (p_season, p_home, p_away, p_sched, 'final',
            p_rnd, p_rnd, p_hg, p_ag, 'regulation', p_sched + interval '2 hours')
    returning id into v_game;

  insert into game_rosters (game_id, team_id, player_id)
    select v_game, p_home, player_id from team_players
    where season_id = p_season and team_id = p_home;
  insert into game_rosters (game_id, team_id, player_id)
    select v_game, p_away, player_id from team_players
    where season_id = p_season and team_id = p_away;

  select array_agg(player_id order by jersey_number) into h_sk
    from team_players where season_id = p_season and team_id = p_home and position <> 'G';
  select array_agg(player_id order by jersey_number) into a_sk
    from team_players where season_id = p_season and team_id = p_away and position <> 'G';
  n_h := array_length(h_sk, 1);
  n_a := array_length(a_sk, 1);

  -- Distribute each team's goals + one assist per goal across its skaters,
  -- as per-player counters on the dressed roster row.
  for k in 1..p_hg loop
    update game_rosters set goals = goals + 1
      where game_id = v_game and player_id = h_sk[1 + ((k * 3) % n_h)];
    update game_rosters set assists = assists + 1
      where game_id = v_game and player_id = h_sk[1 + ((k * 3 + 1) % n_h)];
  end loop;
  for k in 1..p_ag loop
    update game_rosters set goals = goals + 1
      where game_id = v_game and player_id = a_sk[1 + ((k * 2) % n_a)];
    update game_rosters set assists = assists + 1
      where game_id = v_game and player_id = a_sk[1 + ((k * 2 + 1) % n_a)];
  end loop;

  -- One 2-minute minor per team (penalty minutes count; type doesn't matter).
  update game_rosters set pim = 2
    where game_id = v_game and player_id = h_sk[1 + (p_rnd % n_h)];
  update game_rosters set pim = 2
    where game_id = v_game and player_id = a_sk[1 + (p_rnd % n_a)];
end $fn$;

do $$
declare
  v_league uuid;
  v_season uuid;
  v_team uuid;
  v_player uuid;
  v_team_ids uuid[];
  v_ocean_players uuid[] := '{}';   -- captured to share two people into Harbor
  cross_a uuid; cross_b uuid;
  first_names text[] := array['Jordan','Alex','Sam','Casey','Riley','Taylor','Morgan','Jamie','Drew','Quinn','Avery','Parker','Reese','Skyler','Cameron','Hayden','Emerson','Finley'];
  last_names  text[] := array['Miller','Tremblay','Roy','Gagne','Cote','Bouchard','Pelletier','Lavoie','Fortin','Gauthier','Morin','Lefebvre','Bergeron','Caron','Cloutier','Girard','Boucher','Poulin'];
  team_names text[]; team_slugs text[]; team_colors text[];
  n_teams int; n_players int;
  i int; j int;
  pos player_position;
  g record;
  hg int; ag int;
begin
  -- ============================================================ OCEANVIEW
  insert into leagues (name, slug, is_public)
    values ('Oceanview Beer Hockey League', 'obhl', true)
    returning id into v_league;

  insert into seasons (league_id, name, starts_on, ends_on, is_active, point_system)
    values (v_league, 'Spring 2026', date '2026-05-12', date '2026-06-30', true,
            '{"win":2,"tie":1,"loss":0}'::jsonb)
    returning id into v_season;

  insert into league_rules (league_id, content) values (v_league,
    '{"type":"doc","content":[
      {"type":"heading","attrs":{"level":2},"content":[{"type":"text","text":"League Rules"}]},
      {"type":"paragraph","content":[{"type":"text","text":"Games consist of two 25-minute running-time halves. Teams must field a minimum of six skaters and a goaltender to avoid a forfeit."}]},
      {"type":"heading","attrs":{"level":3},"content":[{"type":"text","text":"Standings"}]},
      {"type":"paragraph","content":[{"type":"text","text":"A win is worth 2 points, a tie 1 point, and a loss 0 points. Ties are settled in the standings by head-to-head record, then goal differential."}]},
      {"type":"heading","attrs":{"level":3},"content":[{"type":"text","text":"Conduct"}]},
      {"type":"paragraph","content":[{"type":"text","text":"This is a non-checking recreational league. Fighting results in an automatic game misconduct and a one-game suspension."}]}
    ]}'::jsonb);

  insert into announcements (league_id, title, body, published_at) values
    (v_league, 'Playoffs start the week of June 22',
     'Top four teams qualify. Seeding is by points, then head-to-head. Check the standings page for the latest picture.',
     timestamptz '2026-06-01 09:00-04'),
    (v_league, 'New ice time added: Tuesday 9:30 PM',
     'To balance the schedule we''ve added a late Tuesday slot. The schedule builder has spread these evenly so no team is stuck with it.',
     timestamptz '2026-05-22 12:00-04'),
    (v_league, 'Reminder: jerseys must match the roster number',
     'Scorekeepers credit goals by number. If your number doesn''t match the roster, your points may not be recorded. Captains, please confirm your lineups.',
     timestamptz '2026-05-12 08:00-04');

  team_names  := array['Sharks','Bears','Wolves','Ducks','Hawks','Bisons'];
  team_slugs  := array['sharks','bears','wolves','ducks','hawks','bisons'];
  team_colors := array['#0ea5e9','#b45309','#64748b','#16a34a','#dc2626','#7c3aed'];
  n_teams := 6; n_players := 14;
  v_team_ids := '{}';

  for i in 1..n_teams loop
    insert into teams (league_id, name, slug, color)
      values (v_league, team_names[i], team_slugs[i], team_colors[i])
      returning id into v_team;
    v_team_ids := array_append(v_team_ids, v_team);
    insert into season_teams (season_id, team_id) values (v_season, v_team);

    for j in 1..n_players loop
      insert into players (first_name, last_name)
        values (first_names[1 + ((i * 5 + j * 3) % array_length(first_names, 1))],
                last_names[1 + ((i * 3 + j) % array_length(last_names, 1))])
        returning id into v_player;
      v_ocean_players := array_append(v_ocean_players, v_player);

      if j = 1 then pos := 'G';
      elsif j <= 5 then pos := 'D';
      else pos := 'F';
      end if;

      insert into team_players (season_id, team_id, player_id, jersey_number, position, is_captain)
        values (v_season, v_team, v_player, j, pos, (j = 6));
    end loop;
  end loop;

  -- Oceanview schedule: single round-robin, 5 rounds x 3 games. Rounds 1-3 final.
  for g in
    select * from (values
      (1, 1, 2, timestamptz '2026-05-12 19:00-04'),
      (1, 3, 6, timestamptz '2026-05-12 20:15-04'),
      (1, 4, 5, timestamptz '2026-05-12 21:30-04'),
      (2, 1, 3, timestamptz '2026-05-19 19:00-04'),
      (2, 2, 4, timestamptz '2026-05-19 20:15-04'),
      (2, 5, 6, timestamptz '2026-05-19 21:30-04'),
      (3, 1, 4, timestamptz '2026-05-26 19:00-04'),
      (3, 2, 6, timestamptz '2026-05-26 20:15-04'),
      (3, 3, 5, timestamptz '2026-05-26 21:30-04'),
      (4, 1, 5, timestamptz '2026-06-09 19:00-04'),
      (4, 2, 3, timestamptz '2026-06-09 20:15-04'),
      (4, 4, 6, timestamptz '2026-06-09 21:30-04'),
      (5, 1, 6, timestamptz '2026-06-16 19:00-04'),
      (5, 2, 5, timestamptz '2026-06-16 20:15-04'),
      (5, 3, 4, timestamptz '2026-06-16 21:30-04')
    ) as t(rnd, h, a, sched)
  loop
    if g.rnd <= 3 then
      hg := ((g.rnd * 2 + g.h) % 5) + 1;   -- 1..5
      ag := (g.rnd * 3 + g.a) % 5;         -- 0..4
      perform pg_temp.finalize_seed_game(
        v_season, v_team_ids[g.h], v_team_ids[g.a], g.sched, g.rnd, hg, ag);
    else
      insert into games (season_id, home_team_id, away_team_id, scheduled_at, status, week, round)
        values (v_season, v_team_ids[g.h], v_team_ids[g.a], g.sched, 'scheduled', g.rnd, g.rnd);
    end if;
  end loop;

  -- Two Oceanview people we'll also roster in Harbor (shared identity demo):
  -- the Sharks captain (i=1, j=6 -> index 6) and a Sharks forward (index 7).
  cross_a := v_ocean_players[6];
  cross_b := v_ocean_players[7];

  -- ============================================================ HARBOR
  insert into leagues (name, slug, is_public)
    values ('Harbor Rec Hockey League', 'harbor', true)
    returning id into v_league;

  insert into seasons (league_id, name, starts_on, ends_on, is_active, point_system)
    values (v_league, 'Spring 2026', date '2026-05-13', date '2026-06-29', true,
            '{"win":2,"tie":1,"loss":0}'::jsonb)
    returning id into v_season;

  insert into league_rules (league_id, content) values (v_league,
    '{"type":"doc","content":[
      {"type":"heading","attrs":{"level":2},"content":[{"type":"text","text":"Harbor Rec Rules"}]},
      {"type":"paragraph","content":[{"type":"text","text":"Three 15-minute stop-time periods. A win is worth 2 points and a tie 1 point."}]}
    ]}'::jsonb);

  insert into announcements (league_id, title, body, published_at) values
    (v_league, 'Welcome to the Harbor Rec spring season',
     'Four teams, six weeks, one trophy. Schedules and standings update automatically as scorekeepers finalize each game.',
     timestamptz '2026-05-13 09:00-04'),
    (v_league, 'Some players are crossing over from Oceanview',
     'A few skaters suit up in both leagues this spring — their profiles are shared, so the same person shows up under each league.',
     timestamptz '2026-05-15 10:00-04');

  team_names  := array['Anchors','Gulls','Mariners','Tide'];
  team_slugs  := array['anchors','gulls','mariners','tide'];
  team_colors := array['#0891b2','#ca8a04','#475569','#059669'];
  n_teams := 4; n_players := 12;
  v_team_ids := '{}';

  for i in 1..n_teams loop
    insert into teams (league_id, name, slug, color)
      values (v_league, team_names[i], team_slugs[i], team_colors[i])
      returning id into v_team;
    v_team_ids := array_append(v_team_ids, v_team);
    insert into season_teams (season_id, team_id) values (v_season, v_team);

    for j in 1..n_players loop
      insert into players (first_name, last_name)
        values (first_names[1 + ((i * 7 + j * 2) % array_length(first_names, 1))],
                last_names[1 + ((i * 4 + j * 5) % array_length(last_names, 1))])
        returning id into v_player;

      if j = 1 then pos := 'G';
      elsif j <= 4 then pos := 'D';
      else pos := 'F';
      end if;

      insert into team_players (season_id, team_id, player_id, jersey_number, position, is_captain)
        values (v_season, v_team, v_player, j, pos, (j = 5));
    end loop;
  end loop;

  -- Shared identity: roster the two Oceanview people onto the Anchors (team 1)
  -- BEFORE finalizing, so they accrue Harbor stats too.
  insert into team_players (season_id, team_id, player_id, jersey_number, position, is_captain)
    values (v_season, v_team_ids[1], cross_a, 21, 'F', false),
           (v_season, v_team_ids[1], cross_b, 22, 'D', false);

  -- Harbor schedule: 4-team single round-robin, 3 rounds x 2 games. Rounds 1-2 final.
  for g in
    select * from (values
      (1, 1, 4, timestamptz '2026-05-13 19:00-04'),
      (1, 2, 3, timestamptz '2026-05-13 20:15-04'),
      (2, 1, 3, timestamptz '2026-05-20 19:00-04'),
      (2, 4, 2, timestamptz '2026-05-20 20:15-04'),
      (3, 1, 2, timestamptz '2026-06-10 19:00-04'),
      (3, 3, 4, timestamptz '2026-06-10 20:15-04')
    ) as t(rnd, h, a, sched)
  loop
    if g.rnd <= 2 then
      hg := ((g.rnd * 2 + g.h) % 4) + 2;   -- 2..5
      ag := (g.rnd * 3 + g.a) % 4;         -- 0..3
      perform pg_temp.finalize_seed_game(
        v_season, v_team_ids[g.h], v_team_ids[g.a], g.sched, g.rnd, hg, ag);
    else
      insert into games (season_id, home_team_id, away_team_id, scheduled_at, status, week, round)
        values (v_season, v_team_ids[g.h], v_team_ids[g.a], g.sched, 'scheduled', g.rnd, g.rnd);
    end if;
  end loop;
end $$;
