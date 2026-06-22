-- is_default_goalie: the team's fallback goalie of record when no per-game pick
-- has been made and no day-of-week schedule matches.
alter table team_players
  add column is_default_goalie boolean not null default false;

-- Per-team, per-weekday goalie preference.  day_of_week: 0=Sun … 6=Sat.
-- Overrides is_default_goalie when the game falls on that day.
create table team_goalie_days (
  id         uuid primary key default gen_random_uuid(),
  team_id    uuid not null references teams(id)   on delete cascade,
  season_id  uuid not null references seasons(id) on delete cascade,
  day_of_week smallint not null check (day_of_week between 0 and 6),
  player_id  uuid not null references players(id) on delete cascade,
  unique (team_id, season_id, day_of_week)
);

alter table team_goalie_days enable row level security;
create policy "public read team_goalie_days" on team_goalie_days
  for select using (true);
