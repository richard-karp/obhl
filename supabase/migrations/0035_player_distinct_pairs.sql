-- Pairs the operator has judged to be two different people who share a name.
-- Without this, a dismissed cluster reappears on every visit to the duplicates
-- page forever, and the tool becomes noise the operator learns to skip.
--
-- Ordered pair (check a < b) so one judgement is one row regardless of which
-- record was listed first.
create table player_distinct_pairs (
  id         uuid primary key default gen_random_uuid(),
  league_id  uuid not null references leagues(id) on delete cascade,
  player_a   uuid not null references players(id) on delete cascade,
  player_b   uuid not null references players(id) on delete cascade,
  created_at timestamptz not null default now(),
  created_by uuid references auth.users(id) on delete set null,
  constraint player_distinct_pairs_ordered check (player_a < player_b),
  unique (league_id, player_a, player_b)
);

alter table player_distinct_pairs enable row level security;
-- No policies and no grants: every read and write here is the admin client,
-- and an absent grant cannot be dropped by a later migration the way a policy
-- can. Same reasoning as 0034's league_office table.
