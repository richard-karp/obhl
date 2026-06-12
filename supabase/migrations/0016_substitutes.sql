-- Substitute players. For some games a team dresses substitutes (sometimes
-- including a goalie). Their stats are recorded in a single per-team
-- "Substitute" roster row that DOES count toward the team's goals (score /
-- standings goals-for and goals-against) but is NOT attributed to any individual
-- player's season totals.
--
-- A substitute row has no player_id and is_substitute = true. v_skater_stats and
-- v_goalie_stats already INNER JOIN players (and team_players for the goalie
-- fallback), so null-player rows fall out of the season skater and goalie stats
-- automatically — no view changes are needed. The finalize/score sum aggregates
-- every game_rosters.goals for the team, so the substitute goals still land in
-- the team score.

alter table game_rosters
  add column is_substitute boolean not null default false,
  alter column player_id drop not null,
  add constraint game_rosters_player_or_sub
    check (player_id is not null or is_substitute);

-- At most one substitute row per team per game (the single aggregate line).
-- The existing unique (game_id, player_id) still applies to real players; null
-- player_ids don't collide there, so this partial index does the enforcing.
create unique index game_rosters_one_sub
  on game_rosters (game_id, team_id) where is_substitute;
