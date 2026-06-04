-- Core entities: leagues, seasons, divisions, teams, players.

create table leagues (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  slug text not null unique,
  logo_path text,
  is_public boolean not null default true,
  created_at timestamptz not null default now()
);

create table seasons (
  id uuid primary key default gen_random_uuid(),
  league_id uuid not null references leagues(id) on delete cascade,
  name text not null,
  starts_on date,
  ends_on date,
  is_active boolean not null default false,
  -- Points awarded for win/tie/otl/loss. This league: 2/1/-/0 (ties, no OT).
  point_system jsonb not null default '{"win":2,"tie":1,"loss":0}'::jsonb,
  created_at timestamptz not null default now()
);
-- Exactly one active season per league.
create unique index seasons_one_active_per_league on seasons (league_id) where is_active;

create table divisions (
  id uuid primary key default gen_random_uuid(),
  season_id uuid not null references seasons(id) on delete cascade,
  name text not null
);

create table teams (
  id uuid primary key default gen_random_uuid(),
  league_id uuid not null references leagues(id) on delete cascade,
  name text not null,
  slug text not null,
  logo_path text,
  color text,
  created_at timestamptz not null default now(),
  unique (league_id, slug)
);

-- A person. Identity is GLOBAL (not league-scoped): the same human can play in
-- more than one league. League/season participation is layered on top via
-- team_players (team_players.season_id -> seasons.league_id).
create table players (
  id uuid primary key default gen_random_uuid(),
  first_name text not null,
  last_name text not null,
  birthdate date,
  created_at timestamptz not null default now()
);
