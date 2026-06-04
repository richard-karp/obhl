-- Games and per-game dressed rosters.

create table games (
  id uuid primary key default gen_random_uuid(),
  season_id uuid not null references seasons(id) on delete cascade,
  division_id uuid references divisions(id) on delete set null,
  home_team_id uuid not null references teams(id),
  away_team_id uuid not null references teams(id),
  scheduled_at timestamptz,
  status game_status not null default 'scheduled',
  game_type game_type not null default 'regular',
  week int,
  round int,
  home_goals int not null default 0,
  away_goals int not null default 0,
  result_type result_type not null default 'regulation',
  finalized_at timestamptz,
  finalized_by uuid references auth.users(id) on delete set null,
  is_draft boolean not null default false,
  -- Optional marker for special season games (e.g. an in-season tournament
  -- "Final"). NULL for ordinary games; shown as a badge when set.
  label text,
  created_at timestamptz not null default now(),
  constraint games_distinct_teams check (home_team_id <> away_team_id)
);
create index games_season_idx on games(season_id);
create index games_scheduled_idx on games(scheduled_at);
create index games_status_idx on games(status);

-- A row = this player dressed for this game (the GP source). The team's goalie
-- is the dressed player whose team_players.position = 'G'. Scoring is tracked as
-- simple per-player counters on this row (goals/assists/penalty minutes): the
-- scorekeeper bumps them by ±1. Only the jersey number identifies the player.
create table game_rosters (
  id uuid primary key default gen_random_uuid(),
  game_id uuid not null references games(id) on delete cascade,
  team_id uuid not null references teams(id) on delete cascade,
  player_id uuid not null references players(id) on delete cascade,
  goals int not null default 0 check (goals >= 0),
  assists int not null default 0 check (assists >= 0),
  pim int not null default 0 check (pim >= 0),
  unique (game_id, player_id)
);
create index game_rosters_game_idx on game_rosters(game_id);
