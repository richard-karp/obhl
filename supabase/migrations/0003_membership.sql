-- Season enrollment, per-season rosters, and user profiles.

-- Which teams play in a season (teams persist; enrollment is per season).
create table season_teams (
  id uuid primary key default gen_random_uuid(),
  season_id uuid not null references seasons(id) on delete cascade,
  team_id uuid not null references teams(id) on delete cascade,
  division_id uuid references divisions(id) on delete set null,
  unique (season_id, team_id)
);

-- Season-scoped roster: who is on a team, their number/position, captaincy.
create table team_players (
  id uuid primary key default gen_random_uuid(),
  season_id uuid not null references seasons(id) on delete cascade,
  team_id uuid not null references teams(id) on delete cascade,
  player_id uuid not null references players(id) on delete cascade,
  jersey_number int,
  position player_position not null default 'F',
  is_captain boolean not null default false,
  unique (season_id, team_id, player_id),
  unique (season_id, team_id, jersey_number)
);

-- Links an authenticated user to an app role (and, for captains, a player).
create table profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  role app_role,
  player_id uuid references players(id) on delete set null,
  display_name text,
  created_at timestamptz not null default now()
);
