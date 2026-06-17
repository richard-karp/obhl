-- A team may play a substitute goalie. A substitute goalie has NO individual
-- record: no GA/GAA, no win/loss — those goals count for the team in the
-- standings only, and the sub goalie's own goals/assists go in the team's
-- "Substitute" roster row like any other sub. We mark this per game/side with
-- home/away_goalie_is_sub, which also SUPPRESSES the dressed-goalie fallback so a
-- rostered goalie dressed as an unused backup is never charged.

alter table games
  add column home_goalie_is_sub boolean not null default false,
  add column away_goalie_is_sub boolean not null default false;

comment on column games.home_goalie_is_sub is
  'The home goalie of record was a substitute — credit no individual goalie (team standings still count the goals).';

create or replace view v_goalie_stats with (security_invoker = true) as
with finals as (
  select id, season_id, home_team_id, away_team_id,
         home_goalie_id, away_goalie_id,
         home_goalie_is_sub, away_goalie_is_sub,
         home_empty_net_against, away_empty_net_against
  from games
  where status = 'final' and game_type = 'regular'
),
goalie_appearances as (
  select season_id, home_goalie_id as player_id, id as game_id, home_team_id as team_id
    from finals where home_goalie_id is not null and not home_goalie_is_sub
  union all
  select season_id, away_goalie_id, id, away_team_id
    from finals where away_goalie_id is not null and not away_goalie_is_sub
  union all
  -- dressed position='G' fallback, only when the side has no explicit pick and
  -- isn't flagged as a substitute goalie
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
        (gr.team_id = f.home_team_id and f.home_goalie_id is null and not f.home_goalie_is_sub) or
        (gr.team_id = f.away_team_id and f.away_goalie_id is null and not f.away_goalie_is_sub)
      )
    order by gr.game_id, gr.team_id, gr.player_id
  ) fallback
),
with_result as (
  select
    ga.season_id, ga.player_id, ga.team_id, r.outcome,
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
