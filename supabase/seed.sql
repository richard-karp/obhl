-- Seed: TWO leagues so the league switcher and cross-league players are real.
--   * Oceanview Beer Hockey League — 6 teams, ~14 players each, 6 rounds
--     (rounds 1-3 final with goals/penalties, 4-5 scheduled but PAST, 6 TONIGHT).
--   * Harbor Rec Hockey League — 4 teams, ~12 players each, 4 rounds
--     (rounds 1-2 final, round 3 scheduled but past, round 4 TONIGHT).
-- ⚠️ The two "tonight" rounds are the only fixtures that are ever today, and
-- they exist for the scorekeeper's page — see the TONIGHT blocks below. Rounds
-- 4-5 of Oceanview are `scheduled` yet in the PAST, which is what lets the
-- scoring specs open a game without one being today.
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
  -- ⛔ WEEKDAY-STABLE, NOT JUST "SOME DAYS AGO". Every league-1 game is a
  -- Tuesday and every league-2 game a Wednesday; `28-`'s SKIP_DAY is a
  -- day-of-month that must land on a Thursday. `date_trunc('week', …)` returns
  -- the ISO Monday, so +1 is Tuesday and +2 is Wednesday.
  --
  -- ⚠️ `current_date` IS UTC, SO THE WHOLE FIXTURE STEPS FORWARD AT UTC
  -- MIDNIGHT, NOT LOCAL MIDNIGHT — 20:00 Eastern in EDT, and 19:00 once the
  -- league is on EST. The Postgres container runs in UTC, so an
  -- evening `db:reset` seeds against tomorrow's date. Watched 2026-09-07 at
  -- 20:14 EDT: the same reset that produced a 2026-05-05 anchor that morning
  -- produced 2026-05-12 that evening — a SEVEN-day jump, because the extra day
  -- crossed a week boundary and `date_trunc` snaps to it. That is correct and
  -- self-consistent (every spec derives from these same values, and all of them
  -- read the date back from the database or use `getUTC*`), but it means a
  -- morning run and an evening run exercise different fixtures. If you are ever
  -- chasing a failure that reproduces only at one time of day, this is why.
  v_l1_anchor  date := date_trunc('week', current_date - 120)::date + 1;
  v_l2_anchor  date := date_trunc('week', current_date - 120)::date + 2;
  v_fall_anchor date := date_trunc('week', current_date + 14)::date + 1;
  -- ⛔ TONIGHT, IN THE LEAGUE'S ZONE — NOT `current_date`.
  --
  -- The scorekeeper's page lists games whose LEAGUE-LOCAL date is today, and
  -- `leagueDateKey` reads them in `America/New_York`. `current_date` is UTC and
  -- rolls at 20:00 Eastern (19:00 on EST), which is INSIDE the 19:00-23:00 window
  -- these games occupy — so a fixture dated `current_date` would be dated
  -- TOMORROW by the app for the whole second half of every evening, and would be
  -- invisible on the very page it exists to test. The UTC-rollover trap is the
  -- same one the comment above records; this is the one place it bites.
  v_tonight date := (current_timestamp at time zone 'America/New_York')::date;
begin
  -- ============================================================ OCEANVIEW
  insert into leagues (name, slug, is_public)
    values ('Oceanview Beer Hockey League', 'obhl', true)
    returning id into v_league;

  insert into seasons (league_id, name, starts_on, ends_on, is_active, point_system)
    -- ⚠️ THE YEAR IN THIS NAME IS NOT A CLAIM ABOUT THE DATES. The name is the
    -- handle 17 assertions use to find this season; the dates are relative to
    -- today. Do not "fix" the mismatch by pinning the dates back.
    -- ⚠️ TONIGHT'S GAMES SIT OUTSIDE THIS RANGE, AND THAT IS FINE. A previous
    -- version widened `ends_on` to cover them, justified by the schedule
    -- builder's "no room for playoffs" warning. That justification was WRONG:
    -- `overrunsSeason` (`schedule-builder-panel.tsx`) is computed from `byDate`,
    -- which is built only from DRAFT games, and this season has none — so the
    -- warning could never fire. Widening it also made Spring overlap Fall, which
    -- it never did before, and Harbor's tonight game was left outside its own
    -- `ends_on` regardless, so the rule was not even applied consistently.
    -- Nothing in the app reads `ends_on` except display and that draft-only
    -- check. Reverted.
    values (v_league, 'Spring 2026', v_l1_anchor, v_l1_anchor + 49, true,
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
     (v_l1_anchor + 20 + time '09:00') at time zone 'America/New_York'),
    (v_league, 'New ice time added: Tuesday 9:30 PM',
     'To balance the schedule we''ve added a late Tuesday slot. The schedule builder has spread these evenly so no team is stuck with it.',
     (v_l1_anchor + 10 + time '12:00') at time zone 'America/New_York'),
    (v_league, 'Reminder: jerseys must match the roster number',
     'Scorekeepers credit goals by number. If your number doesn''t match the roster, your points may not be recorded. Captains, please confirm your lineups.',
     (v_l1_anchor +  0 + time '08:00') at time zone 'America/New_York');

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
      (1, 1, 2, (v_l1_anchor +  0 + time '19:00') at time zone 'America/New_York'),
      (1, 3, 6, (v_l1_anchor +  0 + time '20:15') at time zone 'America/New_York'),
      (1, 4, 5, (v_l1_anchor +  0 + time '21:30') at time zone 'America/New_York'),
      (2, 1, 3, (v_l1_anchor +  7 + time '19:00') at time zone 'America/New_York'),
      (2, 2, 4, (v_l1_anchor +  7 + time '20:15') at time zone 'America/New_York'),
      (2, 5, 6, (v_l1_anchor +  7 + time '21:30') at time zone 'America/New_York'),
      (3, 1, 4, (v_l1_anchor + 14 + time '19:00') at time zone 'America/New_York'),
      (3, 2, 6, (v_l1_anchor + 14 + time '20:15') at time zone 'America/New_York'),
      (3, 3, 5, (v_l1_anchor + 14 + time '21:30') at time zone 'America/New_York'),
      (4, 1, 5, (v_l1_anchor + 28 + time '19:00') at time zone 'America/New_York'),
      (4, 2, 3, (v_l1_anchor + 28 + time '20:15') at time zone 'America/New_York'),
      (4, 4, 6, (v_l1_anchor + 28 + time '21:30') at time zone 'America/New_York'),
      (5, 1, 6, (v_l1_anchor + 35 + time '19:00') at time zone 'America/New_York'),
      (5, 2, 5, (v_l1_anchor + 35 + time '20:15') at time zone 'America/New_York'),
      (5, 3, 4, (v_l1_anchor + 35 + time '21:30') at time zone 'America/New_York')
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

  -- ── TONIGHT ────────────────────────────────────────────────────────────
  --
  -- Three games on the league-local calendar date, at the same 19:00/20:15/21:30
  -- slots as every other night. THE ONLY FIXTURE THAT IS EVER "TODAY".
  --
  -- ⛔ WITHOUT THIS THE SCOREKEEPER'S PAGE CANNOT BE TESTED AT ALL. Every other
  -- game here is anchored ~120 days back or ~14 days forward, so under the
  -- day restriction a scorekeeper can open exactly zero of them — the suite
  -- would go green having exercised nothing.
  --
  -- Round 6, after the five that make up the round robin. Left `scheduled` so
  -- the scoresheet has something to open, dress and finalize.
  --
  -- ⛔ THESE THREE ARE A SHARED, CONSUMABLE FIXTURE. They are the ONLY games a
  -- scorekeeper can open, so every spec that finalizes one takes it out of
  -- circulation for the specs that run after — and `scoreLabel` renders a final
  -- game as "Edit", so a locator matching the literal "Score" then finds
  -- nothing. That is measured, not predicted: `30-schedule-edits` failed exactly
  -- this way once `05-scoring` and `33-scorekeeper-day` had each finalized one.
  -- **Locate a scoresheet by `a[href$="/score"]`, never by the button label**,
  -- and if you need a game that is still unscored, count how many of these three
  -- the specs before yours have already used.
  --
  -- ⛔ THE DAY RESTRICTION MADE THIS POOL MUCH SMALLER, AND THAT IS WHY IT BITES.
  -- Before it, a scorekeeper could reach ~15 seeded games and no spec noticed
  -- another consuming one. Now they can reach these four, every scorekeeper spec
  -- in a serial run competes for them, and a spec that finalizes or cancels one
  -- changes what LATER specs see. Measured 2026-09-10: nine failures across six
  -- files, all of which passed in isolation.
  --
  -- ⚠️ THE LESSON FOR NEW SPECS: do not assert a COUNT of tonight's games, and do
  -- not match the "Score" label. Assert the invariant instead — that every row is
  -- today, and that the leagues shown are the ones the viewer scores. Those do
  -- not weaken as the fixture is used up.
  --
  -- ⚠️ FINALIZING IS NOT THE ONLY WAY TO CONSUME ONE. `05-scoring` reaches these
  -- games with `.last()` on the manager's schedule, and POSTPONING nulls
  -- `scheduled_at` (`0025`) — which removes the game from this night entirely,
  -- not just from one label. Any spec that cancels or postpones one of these must
  -- restore it in a `finally`, or the damage surfaces later as an unrelated count
  -- mismatch in a spec that never touched it.
  for g in
    select * from (values
      (6, 6, 1, (v_tonight + time '19:00') at time zone 'America/New_York'),
      (6, 5, 2, (v_tonight + time '20:15') at time zone 'America/New_York'),
      (6, 4, 3, (v_tonight + time '21:30') at time zone 'America/New_York')
    ) as t(rnd, h, a, sched)
  loop
    insert into games (season_id, home_team_id, away_team_id, scheduled_at, status, week, round)
      values (v_season, v_team_ids[g.h], v_team_ids[g.a], g.sched, 'scheduled', g.rnd, g.rnd);
  end loop;

  -- A season that has not started: no games at all, so season_is_started() is
  -- false and the schedule builder still offers to generate and publish. The
  -- active Spring 2026 season is in the past and reads as started, so without
  -- this there is no fixture on the un-started side of the rule.
  declare
    v_fall uuid;
  begin
    -- ⛔ THIS IS THE SEASON THE WHOLE CHANGE EXISTS FOR. It must be UNSTARTED
    -- for the builder specs to work: `season_is_started` flipping is what
    -- locks the builder and falsifies `11-`'s stated premise. The anchor is a
    -- Tuesday 9–15 days out for every possible weekday of "today".
    -- ⚠️ The year in the name is not a claim about the dates.
    insert into seasons (league_id, name, starts_on, ends_on, is_active, point_system)
      values (v_league, 'Fall 2026', v_fall_anchor, v_fall_anchor + 197, false,
              '{"win":2,"tie":1,"loss":0}'::jsonb)
      returning id into v_fall;

    -- Same six teams, so the generator has something to work with.
    for i in 1 .. array_length(v_team_ids, 1) loop
      insert into season_teams (season_id, team_id) values (v_fall, v_team_ids[i]);
    end loop;
  end;

  -- Two Oceanview people we'll also roster in Harbor (shared identity demo):
  -- the Sharks captain (i=1, j=6 -> index 6) and a Sharks forward (index 7).
  cross_a := v_ocean_players[6];
  cross_b := v_ocean_players[7];

  -- ============================================================ HARBOR
  insert into leagues (name, slug, is_public)
    values ('Harbor Rec Hockey League', 'harbor', true)
    returning id into v_league;

  insert into seasons (league_id, name, starts_on, ends_on, is_active, point_system)
    -- ⚠️ THE YEAR IN THIS NAME IS NOT A CLAIM ABOUT THE DATES. The name is the
    -- handle 17 assertions use to find this season; the dates are relative to
    -- today. Do not "fix" the mismatch by pinning the dates back.
    values (v_league, 'Spring 2026', v_l2_anchor, v_l2_anchor + 47, true,
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
     (v_l2_anchor + 0 + time '09:00') at time zone 'America/New_York'),
    (v_league, 'Some players are crossing over from Oceanview',
     'A few skaters suit up in both leagues this spring — their profiles are shared, so the same person shows up under each league.',
     (v_l2_anchor + 2 + time '10:00') at time zone 'America/New_York');

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
      (1, 1, 4, (v_l2_anchor +  0 + time '19:00') at time zone 'America/New_York'),
      (1, 2, 3, (v_l2_anchor +  0 + time '20:15') at time zone 'America/New_York'),
      (2, 1, 3, (v_l2_anchor +  7 + time '19:00') at time zone 'America/New_York'),
      (2, 4, 2, (v_l2_anchor +  7 + time '20:15') at time zone 'America/New_York'),
      (3, 1, 2, (v_l2_anchor + 28 + time '19:00') at time zone 'America/New_York'),
      (3, 3, 4, (v_l2_anchor + 28 + time '20:15') at time zone 'America/New_York'),
      -- ⛔ TONIGHT, IN THE SECOND LEAGUE. This one game is what makes the
      -- scorekeeper page's CROSS-LEAGUE claim testable at the page level rather
      -- than only in the query's unit tests. `scorekeeper@` belongs to both
      -- leagues and must see FOUR games under TWO headings;
      -- `single-league-scorer@` belongs only to obhl and must still see the same
      -- three under one. Without it every test renders a single group and the
      -- grouping — the whole point of the page — goes unexercised.
      --
      -- 20:45 rather than one of Oceanview's own slots, so the two leagues are
      -- distinguishable by time as well as by heading. The page groups by league
      -- and orders within a group, so this does not interleave — it just makes a
      -- mixed-up render obvious to read.
      (4, 2, 4, (v_tonight + time '20:45') at time zone 'America/New_York')
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
