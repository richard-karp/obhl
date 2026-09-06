-- ⛔ THIS MIGRATION IS A DEPLOY GATE. PUSH IT WITH OR BEFORE THE CODE.
--
-- The branch that adds it (`refactor/one-site-chrome-and-logo-ink`) reads the two
-- columns below by name, and against a database where this has not run PostgREST
-- answers 42703 for the WHOLE request rather than for the missing column. The
-- shipped consequences, in order of how quiet they are:
--
--   * `src/lib/queries/players.ts` — `getPlayerBio`'s substitute-player fallback
--     names these columns explicitly on `v_skater_stats`. It degrades to a blank
--     team, blank position and no jersey number, which reads as a player with no
--     history rather than as an error. It logs, since this migration's review;
--     it does not throw.
--   * `getSkaterLeaders` / `getGoalieLeaders` and the stats tables read
--     `select("*")`, so they keep working and simply draw the old monogram — the
--     defect this change exists to fix, silently un-fixed.
--
-- Deploying the code first therefore does not break the site; it produces one
-- page that lies. Deploying this first is harmless at any time: the columns are
-- additive and nothing reads them until the code lands.
--
-- ---------------------------------------------------------------------------
-- Team branding on the stats screens.
--
-- `TeamLogo` takes `logoPath` (an uploaded crest) and `textColor`
-- (`teams.logo_text_color`, 0041) and falls back to white initials when it gets
-- neither. Most callers never plumbed them, so a team with a real crest showed
-- its initials and a team on a pale colour showed unreadable white letters.
-- Everywhere else that is a `select` list; here it is not. The stats tables and
-- the leaderboards read these four VIEWS, which lift `teams.name`, `slug` and
-- `color` out under prefixed names and stop there. A column a view does not
-- carry cannot be added in TypeScript.
--
-- ⚠️ NOT THE STANDINGS VIEW. `v_standings_raw` has the same gap, and
-- `getStandings` already answers it with one small indexed read of
-- `season_teams -> teams` alongside the view — a decision written down in
-- `src/lib/queries/standings.ts` and left standing here. That read has one row
-- per team; the equivalent for the stats tables would be a per-row join in
-- TypeScript on every leaderboard, which is the case the view is for.
--
-- The four move together on purpose. `SkaterRow` and `GoalieRow` in
-- `src/lib/queries/stats.ts` are UNIONS of the per-team view and the per-season
-- totals view, precisely so a column present on only one of them stops
-- compiling rather than rendering blanks. Adding these to two of the four would
-- trip exactly that wire.
--
-- Recreated rather than altered, and the new columns are APPENDED. `create or
-- replace view` may add columns only at the END of the list and may not rename,
-- retype or reorder what is already there; the totals views below select from
-- the per-team ones by name, so widening those first does not disturb them.
-- Every definition below is otherwise verbatim from the migration that last
-- issued it — 0024 for `v_skater_stats`, 0037 for the other three.

-- ---------------------------------------------------------------------------
-- 1. Per-team views
-- ---------------------------------------------------------------------------

create or replace view v_skater_stats with (security_invoker = true) as
with finals as (
  select id, season_id from games
  where status = 'final' and game_type = 'regular' and not is_draft
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
  agg.pim,
  tm.logo_path as team_logo_path,
  tm.logo_text_color as team_logo_text_color
from agg
join players p on p.id = agg.player_id
join teams tm on tm.id = agg.team_id
left join team_players tp
  on tp.season_id = agg.season_id and tp.team_id = agg.team_id and tp.player_id = agg.player_id;

-- 0037's definition, which restored 0015's goalie of record and empty-net
-- handling on top of 0024's draft filter. Reproduced unchanged apart from the
-- two trailing columns — see 0037 for why each branch of `goalie_appearances`
-- is shaped the way it is, and in particular why there is no `left_on` filter.
create or replace view v_goalie_stats with (security_invoker = true) as
with finals as (
  select id, season_id, home_team_id, away_team_id,
         home_goalie_id, away_goalie_id,
         home_goalie_is_sub, away_goalie_is_sub,
         home_empty_net_against, away_empty_net_against
  from games
  where status = 'final' and game_type = 'regular' and not is_draft
),
goalie_appearances as (
  select season_id, home_goalie_id as player_id, id as game_id, home_team_id as team_id
    from finals where home_goalie_id is not null and not home_goalie_is_sub
  union all
  select season_id, away_goalie_id, id, away_team_id
    from finals where away_goalie_id is not null and not away_goalie_is_sub
  union all
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
  round(agg.ga::numeric / nullif(agg.gp, 0), 2) as gaa,
  tm.logo_path as team_logo_path,
  tm.logo_text_color as team_logo_text_color
from agg
join players p on p.id = agg.player_id
join teams tm on tm.id = agg.team_id
left join team_players tp
  on tp.season_id = agg.season_id and tp.team_id = agg.team_id and tp.player_id = agg.player_id;

-- ---------------------------------------------------------------------------
-- 2. Season totals
-- ---------------------------------------------------------------------------
--
-- The team columns here describe the player's CURRENT team (0037), and the
-- branding follows them: a leaderboard shows the crest of the team the player
-- is on now, beside the name and colour it already showed. `tm` is a LEFT join,
-- so a player with no active roster row keeps their null team and now a null
-- crest — `TeamLogo` draws its monogram from the name it is given either way.

create or replace view v_skater_season_totals with (security_invoker = true) as
with agg as (
  select season_id, player_id,
         sum(gp)::int gp, sum(g)::int g, sum(a)::int a, sum(pim)::int pim
  from v_skater_stats group by season_id, player_id
)
select agg.season_id, agg.player_id, p.first_name, p.last_name,
       cur.team_id, tm.name as team_name, tm.slug as team_slug,
       tm.color as team_color, cur.jersey_number, cur.position,
       agg.gp, agg.g, agg.a, (agg.g + agg.a) as pts, agg.pim,
       tm.logo_path as team_logo_path,
       tm.logo_text_color as team_logo_text_color
from agg
join players p on p.id = agg.player_id
left join team_players cur
  on cur.season_id = agg.season_id and cur.player_id = agg.player_id
 and cur.left_on is null
left join teams tm on tm.id = cur.team_id;

create or replace view v_goalie_season_totals with (security_invoker = true) as
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
       round(agg.ga::numeric / nullif(agg.gp, 0), 2) as gaa,
       tm.logo_path as team_logo_path,
       tm.logo_text_color as team_logo_text_color
from agg
join players p on p.id = agg.player_id
left join team_players cur
  on cur.season_id = agg.season_id and cur.player_id = agg.player_id
 and cur.left_on is null
left join teams tm on tm.id = cur.team_id;
