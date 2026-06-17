-- Season-scoped status flags for players: rookie year, injury, suspension.
alter table team_players
  add column is_rookie boolean not null default false,
  add column injury_notes text,
  add column is_suspended boolean not null default false;
