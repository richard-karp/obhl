-- What a league manager tells the schedule generator: pin a team's bye to a
-- night or a week, force a play night, pin an ice time, or lean a stretch of
-- season early or late.
--
-- ── Why the params are stored as MEANING, not as solver indices ─────────────
--
-- `params` holds `{"date": "2026-11-12"}`, `{"week_of": "2026-11-09"}`,
-- `{"time": "21:30"}` — never a week number and never a slot position. Both of
-- those are derived from the calendar the generate form is holding at the
-- moment it runs: a week number shifts as soon as a skip date is added ahead of
-- it, and a slot position shifts as soon as an ice time is inserted. A date and
-- a wall-clock time survive both. Resolution to indices happens once, at
-- generation time, in src/lib/schedule/constraints.ts.
--
-- ── A constraint can outlive what it names ─────────────────────────────────
--
-- Both foreign keys cascade, so a deleted season or team takes its constraints
-- with it. That is NOT the whole story: **un-enrolling a team from a season
-- deletes no team row**, so its constraints survive and name a team that is no
-- longer in the generator's team list. A stored date likewise stops being a
-- game night the moment the manager changes the weekdays or adds a skip date.
-- Neither is a database problem and neither is repaired here — the generator
-- reports those constraints unmet, with the reason, rather than indexing into a
-- list that does not contain them.
--
-- `kind` is a text column with a check rather than an enum: the set is expected
-- to grow, and adding an enum value is a migration that cannot run inside a
-- transaction with its first use, where a check constraint is one `alter`.

create table season_schedule_constraints (
  id         uuid primary key default gen_random_uuid(),
  season_id  uuid not null references seasons(id) on delete cascade,
  team_id    uuid not null references teams(id) on delete cascade,
  kind       text not null check (
    kind in ('bye_on', 'bye_in_week', 'bye_week', 'play_on', 'slot_on', 'slot_bias')
  ),
  params     jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index season_schedule_constraints_season_idx
  on season_schedule_constraints (season_id);

-- ⛔ NOT OPTIONAL, AND THE OMISSION HAS NO SYMPTOM.
--
-- A bare `create table` in `public` on a Supabase instance arrives with ALL
-- SEVEN privileges already granted to BOTH `anon` and `authenticated`, and with
-- RLS off. That is Supabase's default privileges, not 0009's blanket
-- `grant insert, update, delete on all tables in schema public` — that grant ran
-- long before this table existed and cannot reach it. `0034_league_office.sql:53`
-- names the blanket as the cause; it is the right warning with the wrong
-- mechanism, and the mechanism matters because "the blanket cannot reach my new
-- table" reads like a reason to relax. It is not one. Measured 2026-09-04 by
-- creating a throwaway table and reading `information_schema.role_table_grants`.
--
-- So without the two statements below, this table is readable and writable by
-- any authenticated user AND by anon — with no error, no symptom, and nothing in
-- the app looking wrong, because every read here goes through the admin client,
-- which bypasses RLS and grants either way.
alter table season_schedule_constraints enable row level security;

-- A second, independent layer rather than a substitute for the first. RLS
-- decides which rows a privilege reaches; this removes the privilege. Either
-- alone would do, which is the point — a policy can be written wrong or dropped
-- by a later migration meaning to replace it, and a blanket `grant ... on all
-- tables` in some future migration would hand this table back to `authenticated`
-- without mentioning it by name. 0034 makes the same argument for going grant-
-- less, and 0040 pairs the two the same way.
revoke all on season_schedule_constraints from anon, authenticated;

-- Kept even though the revoke above leaves nobody it can admit, and deliberately
-- so: it is the layer that survives a future migration re-granting this table,
-- and it states the intended rule in the schema rather than only in the app.
--
-- The league-scoped pattern from 0032: resolve the league through the season and
-- require manager membership of it. `season_league` returns null for a season
-- that no longer exists and `manages_league(null)` is false, so an unresolvable
-- row fails closed.
--
-- No `anon` policy and no public read. A constraint is an instruction to the
-- generator, not part of the published schedule; the public site has no reason
-- to see one. Every legitimate access is the admin client, on the service role.
create policy "manager write season_schedule_constraints"
  on season_schedule_constraints
  for all to authenticated
  using (public.manages_league(public.season_league(season_id)))
  with check (public.manages_league(public.season_league(season_id)));

comment on table season_schedule_constraints is
  'Manager instructions to the schedule generator. params stores what the manager meant (a date, a week-of date, an "HH:MM" ice time) and is resolved to solver indices at generation time — never a week number or a slot position.';
