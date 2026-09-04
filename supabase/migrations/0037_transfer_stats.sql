-- Two changes that have to ship together: restore the goalie view 0024 quietly
-- reverted, and add the per-season totals the leaderboards need once a player
-- can appear on more than one team in a season.

-- ---------------------------------------------------------------------------
-- 1. v_goalie_stats — restore 0015, keep 0024's filter
-- ---------------------------------------------------------------------------
--
-- 0024 rebuilt this view from 0014's definitions to add `not is_draft`, and in
-- doing so dropped everything 0015 had added: the explicit goalie of record
-- (home_goalie_id / away_goalie_id), the substitute suppression, and the
-- empty-net subtraction. Nothing failed. `src/lib/actions/games.ts` kept writing
-- all three columns and the scoresheet kept showing them back, while the view
-- ignored them — so the goalie credited for a game was whichever dressed
-- position='G' player sorted lowest, and every empty-net goal was charged to a
-- goalie who was on the bench for it. GAA has been inflated since 0024.
--
-- Watched on 2026-09-03 before writing this: `pg_get_viewdef('v_goalie_stats')`
-- contained neither `home_goalie_id` nor `empty_net`.
--
-- Both intents are restored explicitly rather than one being inferred from the
-- other: 0015's body verbatim, plus `and not is_draft` in `finals`.
create or replace view v_goalie_stats with (security_invoker = true) as
with finals as (
  select id, season_id, home_team_id, away_team_id,
         home_goalie_id, away_goalie_id,
         home_goalie_is_sub, away_goalie_is_sub,
         home_empty_net_against, away_empty_net_against
  from games
  where status = 'final' and game_type = 'regular' and not is_draft
),
-- Goalie of record per (game, team):
--   1. Explicit pick (individual) when set and not flagged as sub.
--   2. No attribution when goalie_is_sub is true (sub goalie, no individual record).
--   3. Dressed position='G' fallback when no explicit pick and not flagged as sub.
goalie_appearances as (
  select season_id, home_goalie_id as player_id, id as game_id, home_team_id as team_id
    from finals where home_goalie_id is not null and not home_goalie_is_sub
  union all
  select season_id, away_goalie_id, id, away_team_id
    from finals where away_goalie_id is not null and not away_goalie_is_sub
  union all
  -- wrapped so the distinct on / order by stay scoped to this branch, not the union
  select * from (
    select distinct on (gr.game_id, gr.team_id)
      f.season_id, gr.player_id, gr.game_id, gr.team_id
    from game_rosters gr
    join finals f on f.id = gr.game_id
    -- ⛔ No `left_on` filter here, and adding one would be the quietest possible
    -- way to lose data. This join is what credits a goalie's games to the team
    -- they played them for, and after 0036 a departed goalie's roster row is
    -- exactly the row that says they were ever that team's goalie. Filter it and
    -- their whole record for that team — GP, W/L, GAA, shutouts — vanishes from
    -- the view with no error, while the games themselves stay on the schedule.
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

-- ---------------------------------------------------------------------------
-- 2. Season totals — one line per player, whatever teams they played for
-- ---------------------------------------------------------------------------
--
-- v_skater_stats and v_goalie_stats are per (player, team) and stay that way:
-- team pages need exactly that, and so does a player page's breakdown. But a
-- transferred player has two rows there, so a leaderboard reading them shows
-- the same person twice with each half of their season. These roll that up.
--
-- The team columns describe the player's CURRENT team, which is what a
-- leaderboard's crest and colour should show. 0036's
-- `team_players_one_active_team` is what makes that join single-valued; without
-- it this would silently multiply rows.
create view v_skater_season_totals with (security_invoker = true) as
with agg as (
  select season_id, player_id,
         sum(gp)::int gp, sum(g)::int g, sum(a)::int a, sum(pim)::int pim
  from v_skater_stats group by season_id, player_id
)
select agg.season_id, agg.player_id, p.first_name, p.last_name,
       cur.team_id, tm.name as team_name, tm.slug as team_slug,
       tm.color as team_color, cur.jersey_number, cur.position,
       agg.gp, agg.g, agg.a, (agg.g + agg.a) as pts, agg.pim
from agg
join players p on p.id = agg.player_id
-- The CURRENT team. 0036's partial unique index guarantees at most one.
left join team_players cur
  on cur.season_id = agg.season_id and cur.player_id = agg.player_id
 and cur.left_on is null
left join teams tm on tm.id = cur.team_id;

-- Same shape, except GAA is RECOMPUTED from the season's totals rather than
-- averaged across the per-team rows. Averaging two GAAs is only right when the
-- games split evenly, and a mid-season transfer is precisely the case where
-- they do not: 30 games at 2.00 and 2 games at 6.00 is 2.25, not 4.00.
create view v_goalie_season_totals with (security_invoker = true) as
with agg as (
  select season_id, player_id,
         sum(gp)::int gp, sum(wins)::int wins, sum(losses)::int losses,
         sum(ties)::int ties, sum(ga)::int ga, sum(so)::int so
  from v_goalie_stats group by season_id, player_id
)
select agg.season_id, agg.player_id, p.first_name, p.last_name,
       cur.team_id, tm.name as team_name, tm.slug as team_slug,
       tm.color as team_color, cur.jersey_number,
       agg.gp, agg.wins, agg.losses, agg.ties, agg.ga, agg.so,
       round(agg.ga::numeric / nullif(agg.gp, 0), 2) as gaa
from agg
join players p on p.id = agg.player_id
left join team_players cur
  on cur.season_id = agg.season_id and cur.player_id = agg.player_id
 and cur.left_on is null
left join teams tm on tm.id = cur.team_id;

-- Both joins to team_players are LEFT, so a player with stats and no active
-- roster row — released outright, or removed after playing — still appears,
-- with a null team. Their games happened; dropping them from the leaderboard
-- would be the same kind of quiet erasure this migration exists to undo.
