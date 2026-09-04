-- A player who leaves a team mid-season keeps their roster row; left_on marks
-- when they left, and NULL means they are still on the team.
--
-- The row SURVIVING is the point. v_goalie_stats INNER JOINs team_players to
-- find the dressed position='G' player, so deleting the row erases the old
-- team's entire goalie record — GP, W/L, GAA, shutouts — while the games
-- themselves remain. v_skater_stats LEFT JOINs the same row for jersey_number
-- and position, so deleting it leaves the old team's line with both columns
-- null. Neither failure reports an error.
--
-- No attribution depends on this date: game_rosters.team_id already records
-- which team a player played each game for. left_on is for humans and ordering.
alter table team_players add column left_on date;

comment on column team_players.left_on is
  'Date the player left this team; NULL means currently rostered. Attribution comes from game_rosters.team_id, never from this column.';

-- A departed player's number frees up for a new signing, while their history
-- keeps the number it was earned under.
alter table team_players drop constraint team_players_season_id_team_id_jersey_number_key;
create unique index team_players_active_jersey
  on team_players (season_id, team_id, jersey_number)
  where left_on is null;

-- Makes "the player's current team" well-defined rather than merely usual, so
-- the leaderboard's current-team join in 0037 can never return two rows.
create unique index team_players_one_active_team
  on team_players (season_id, player_id)
  where left_on is null;

create index team_players_active_idx
  on team_players (season_id, team_id) where left_on is null;

-- NOT dropped, and the omission is deliberate: `unique (season_id, team_id,
-- player_id)` from 0003_membership.sql survives, and it is NOT partial. So a
-- player returning to a former team cannot get a second row for that team —
-- transferPlayer clears left_on on the row already there instead of inserting
-- (Task B6 step 6). Making this constraint partial would allow the second row
-- and leave two rows for one player and team, which every per-team read would
-- then have to de-duplicate.
