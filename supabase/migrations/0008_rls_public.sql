-- Public-read RLS. Role/write policies are added in M2 (0009). Helper
-- functions are SECURITY DEFINER so they read gating tables without recursing
-- through RLS.

create or replace function public.league_is_public(p_league uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select coalesce((select is_public from leagues where id = p_league), false);
$$;

create or replace function public.season_is_public(p_season uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select coalesce((
    select l.is_public
    from seasons s join leagues l on l.id = s.league_id
    where s.id = p_season
  ), false);
$$;

create or replace function public.game_is_public_final(p_game uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select coalesce((
    select g.status = 'final' and not g.is_draft and public.season_is_public(g.season_id)
    from games g where g.id = p_game
  ), false);
$$;

-- A player is publicly visible only if they appear on a roster in some PUBLIC
-- league (players are a global table with no league_id of their own).
create or replace function public.player_is_public(p_player uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1
    from team_players tp
    join seasons s on s.id = tp.season_id
    join leagues l on l.id = s.league_id
    where tp.player_id = p_player and l.is_public
  );
$$;

-- Enable RLS (default deny) on every base table.
alter table leagues       enable row level security;
alter table seasons       enable row level security;
alter table divisions     enable row level security;
alter table teams         enable row level security;
alter table players       enable row level security;
alter table season_teams  enable row level security;
alter table team_players  enable row level security;
alter table profiles      enable row level security;
alter table games         enable row level security;
alter table game_rosters  enable row level security;
alter table league_rules  enable row level security;

-- Public-read policies (anon + authenticated) for published data.
create policy "public read leagues" on leagues
  for select to anon, authenticated using (is_public);

create policy "public read seasons" on seasons
  for select to anon, authenticated using (public.league_is_public(league_id));

create policy "public read divisions" on divisions
  for select to anon, authenticated using (public.season_is_public(season_id));

create policy "public read teams" on teams
  for select to anon, authenticated using (public.league_is_public(league_id));

-- Players are global people (no league_id). Expose a player only if they're on
-- a roster in a public league — otherwise private-league members' names leak.
create policy "public read players" on players
  for select to anon, authenticated using (public.player_is_public(id));

create policy "public read season_teams" on season_teams
  for select to anon, authenticated using (public.season_is_public(season_id));

create policy "public read team_players" on team_players
  for select to anon, authenticated using (public.season_is_public(season_id));

create policy "public read league_rules" on league_rules
  for select to anon, authenticated using (public.league_is_public(league_id));

-- Games: published (non-draft) games of a public league.
create policy "public read games" on games
  for select to anon, authenticated
  using (not is_draft and public.season_is_public(season_id));

-- Scoresheet rosters (with the per-player goal/assist/PIM counters): public only
-- for FINAL games (the box score).
create policy "public read final game_rosters" on game_rosters
  for select to anon, authenticated using (public.game_is_public_final(game_id));

-- Base table privileges (rows still gated by RLS above). The reporting views in
-- 0007 are security_invoker, so reading through them still enforces these
-- policies (private-league / non-final data stays hidden).
grant usage on schema public to anon, authenticated;
grant select on all tables in schema public to anon, authenticated;
