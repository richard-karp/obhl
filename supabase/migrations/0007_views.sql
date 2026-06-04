-- Derived read models. Raw aggregates only; ordered standings (incl.
-- head-to-head) are computed in TypeScript (lib/standings/tiebreakers.ts).
-- Views are denormalized with team/player names so the frontend reads them
-- directly without extra joins.

-- One row per team per FINAL game, from that team's perspective.
create view v_team_game_results as
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
where g.status = 'final'
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
where g.status = 'final';

-- Standings raw aggregates per enrolled team (0-0-0 until games are final).
create view v_standings_raw as
select
  st.season_id,
  st.team_id,
  tm.name as team_name,
  tm.slug as team_slug,
  tm.color as team_color,
  coalesce(count(r.game_id), 0)::int as gp,
  coalesce(sum((r.outcome = 'W')::int), 0)::int as wins,
  coalesce(sum((r.outcome = 'L' and r.result_type = 'regulation')::int), 0)::int as losses,
  coalesce(sum((r.outcome = 'T')::int), 0)::int as ties,
  coalesce(sum((r.outcome = 'L' and r.result_type in ('overtime', 'shootout'))::int), 0)::int as otl,
  coalesce(sum(r.gf), 0)::int as gf,
  coalesce(sum(r.ga), 0)::int as ga,
  coalesce(sum(r.gf - r.ga), 0)::int as gd,
  coalesce(sum(
    case
      when r.outcome = 'W' then (s.point_system->>'win')::int
      when r.outcome = 'T' then (s.point_system->>'tie')::int
      when r.outcome = 'L' and r.result_type in ('overtime', 'shootout')
        then coalesce((s.point_system->>'otl')::int, 0)
      else (s.point_system->>'loss')::int
    end
  ), 0)::int as points
from season_teams st
join seasons s on s.id = st.season_id
join teams tm on tm.id = st.team_id
left join v_team_game_results r
  on r.season_id = st.season_id and r.team_id = st.team_id
group by st.season_id, st.team_id, tm.name, tm.slug, tm.color;

-- Skater stats per player from FINAL games. GP = final games dressed; G/A/PIM
-- are summed from the per-game roster counters the scorekeeper records.
create view v_skater_stats as
with finals as (
  select id, season_id from games where status = 'final'
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

-- Goalie stats: the dressed position='G' player credited with the team result.
create view v_goalie_stats as
with finals as (
  select id, season_id from games where status = 'final'
),
goalie_appearances as (
  select f.season_id, gr.player_id, gr.game_id, gr.team_id
  from game_rosters gr
  join finals f on f.id = gr.game_id
  join team_players tp
    on tp.season_id = f.season_id
   and tp.team_id = gr.team_id
   and tp.player_id = gr.player_id
  where tp.position = 'G'
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
