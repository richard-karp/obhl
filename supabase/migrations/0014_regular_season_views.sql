-- Standings and stats are regular-season only. Playoff games are still stored
-- (status='final', game_type='playoff') and show up in the schedule/results, but
-- must not move the regular-season standings or skater/goalie leaderboards. All
-- pre-existing games default to game_type='regular', so this changes no current
-- numbers — it only fences off the playoff/imported-tournament games.
-- Recreated (not altered) because the only change is an added WHERE predicate;
-- column lists are identical, so `create or replace view` is safe.

create or replace view v_team_game_results with (security_invoker = true) as
select
  g.id as game_id,
  g.season_id,
  g.home_team_id as team_id,
  g.away_team_id as opponent_id,
  g.home_goals as gf,
  g.away_goals as ga,
  case
    when g.home_goals > g.away_goals then 'W'
    when g.home_goals < g.away_goals then 'L'
    else 'T'
  end as outcome,
  g.result_type
from games g
where g.status = 'final' and g.game_type = 'regular'
union all
select
  g.id,
  g.season_id,
  g.away_team_id,
  g.home_team_id,
  g.away_goals,
  g.home_goals,
  case
    when g.away_goals > g.home_goals then 'W'
    when g.away_goals < g.home_goals then 'L'
    else 'T'
  end,
  g.result_type
from games g
where g.status = 'final' and g.game_type = 'regular';

create or replace view v_skater_stats with (security_invoker = true) as
with finals as (
  select id, season_id from games
  where status = 'final' and game_type = 'regular'
),
agg as (
  select
    f.season_id, gr.player_id, gr.team_id,
    count(*)::int as gp,
    sum(gr.goals)::int as g,
    sum(gr.assists)::int as a,
    sum(gr.pim)::int as pim
  from game_rosters gr
  join finals f on f.id = gr.game_id
  group by f.season_id, gr.player_id, gr.team_id
)
select
  agg.season_id,
  agg.player_id,
  agg.team_id,
  p.first_name,
  p.last_name,
  tp.jersey_number,
  tp.position,
  tm.name as team_name,
  tm.slug as team_slug,
  tm.color as team_color,
  agg.gp,
  agg.g,
  agg.a,
  (agg.g + agg.a) as pts,
  agg.pim
from agg
join players p on p.id = agg.player_id
join teams tm on tm.id = agg.team_id
left join team_players tp
  on tp.season_id = agg.season_id and tp.team_id = agg.team_id and tp.player_id = agg.player_id;

create or replace view v_goalie_stats with (security_invoker = true) as
with finals as (
  select id, season_id from games
  where status = 'final' and game_type = 'regular'
),
goalie_appearances as (
  select distinct on (gr.game_id, gr.team_id)
    f.season_id, gr.player_id, gr.game_id, gr.team_id
  from game_rosters gr
  join finals f on f.id = gr.game_id
  join team_players tp
    on tp.season_id = f.season_id
   and tp.team_id = gr.team_id
   and tp.player_id = gr.player_id
  where tp.position = 'G'
  order by gr.game_id, gr.team_id, gr.player_id
),
with_result as (
  select ga.season_id, ga.player_id, ga.team_id, r.outcome, r.ga as goals_against
  from goalie_appearances ga
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
