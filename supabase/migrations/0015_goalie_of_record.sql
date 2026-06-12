-- Goalie stats fixes:
--  1. A team can use different goalies in different games, so the goalie of
--     record is captured per game (home_goalie_id / away_goalie_id) and each
--     goalie's W/L/GAA is credited only for the games they actually played.
--     Existing/imported games (no pick) fall back to the dressed position='G'
--     player, as before.
--  2. Empty-net goals (scored against a team while its net was empty) must not
--     count against that team's goalie. We store a per-game, per-team count of
--     empty-net goals against, and subtract it from the goalie's goals-against
--     when computing GA / GAA / shutouts. These goals still count in the score
--     and standings — only the goalie's personal GA excludes them.

alter table games
  add column home_goalie_id uuid references players(id) on delete set null,
  add column away_goalie_id uuid references players(id) on delete set null,
  add column home_empty_net_against int not null default 0
    check (home_empty_net_against >= 0),
  add column away_empty_net_against int not null default 0
    check (away_empty_net_against >= 0);

comment on column games.home_goalie_id is
  'Goalie of record for the home team this game; NULL falls back to the dressed position=G player.';
comment on column games.home_empty_net_against is
  'Goals scored against the home team''s empty net — excluded from its goalie''s GA/GAA.';

create or replace view v_goalie_stats with (security_invoker = true) as
with finals as (
  select id, season_id, home_team_id, away_team_id,
         home_goalie_id, away_goalie_id,
         home_empty_net_against, away_empty_net_against
  from games
  where status = 'final' and game_type = 'regular'
),
-- Goalie of record per (game, team): the explicit pick when set, otherwise the
-- single dressed position='G' player (lowest player_id if a team ever dresses
-- two and made no pick).
goalie_appearances as (
  select season_id, home_goalie_id as player_id, id as game_id, home_team_id as team_id
    from finals where home_goalie_id is not null
  union all
  select season_id, away_goalie_id, id, away_team_id
    from finals where away_goalie_id is not null
  union all
  -- wrapped so the distinct on / order by stay scoped to this branch, not the union
  select * from (
    select distinct on (gr.game_id, gr.team_id)
      f.season_id, gr.player_id, gr.game_id, gr.team_id
    from game_rosters gr
    join finals f on f.id = gr.game_id
    join team_players tp
      on tp.season_id = f.season_id
     and tp.team_id = gr.team_id
     and tp.player_id = gr.player_id
    where tp.position = 'G'
      and (
        (gr.team_id = f.home_team_id and f.home_goalie_id is null) or
        (gr.team_id = f.away_team_id and f.away_goalie_id is null)
      )
    order by gr.game_id, gr.team_id, gr.player_id
  ) fallback
),
with_result as (
  select
    ga.season_id, ga.player_id, ga.team_id, r.outcome,
    -- the goalie's goals-against = the team's goals-against minus the goals
    -- that beat an empty net (goalie not in play).
    greatest(
      0,
      r.ga - case
        when ga.team_id = f.home_team_id then f.home_empty_net_against
        else f.away_empty_net_against
      end
    ) as goals_against
  from goalie_appearances ga
  join finals f on f.id = ga.game_id
  join v_team_game_results r on r.game_id = ga.game_id and r.team_id = ga.team_id
),
agg as (
  select
    season_id,
    player_id,
    team_id,
    count(*)::int as gp,
    sum((outcome = 'W')::int)::int as wins,
    sum((outcome = 'L')::int)::int as losses,
    sum((outcome = 'T')::int)::int as ties,
    sum(goals_against)::int as ga,
    sum((goals_against = 0)::int)::int as so
  from with_result
  group by season_id, player_id, team_id
)
select
  agg.season_id,
  agg.player_id,
  agg.team_id,
  p.first_name,
  p.last_name,
  tp.jersey_number,
  tm.name as team_name,
  tm.slug as team_slug,
  tm.color as team_color,
  agg.gp,
  agg.wins,
  agg.losses,
  agg.ties,
  agg.ga,
  agg.so,
  round(agg.ga::numeric / nullif(agg.gp, 0), 2) as gaa
from agg
join players p on p.id = agg.player_id
join teams tm on tm.id = agg.team_id
left join team_players tp
  on tp.season_id = agg.season_id and tp.team_id = agg.team_id and tp.player_id = agg.player_id;
