-- League announcements (homepage news). Public reads published announcements of
-- a public league; managers manage them.

create table announcements (
  id uuid primary key default gen_random_uuid(),
  league_id uuid not null references leagues(id) on delete cascade,
  title text not null,
  body text not null,
  is_published boolean not null default true,
  published_at timestamptz not null default now(),
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now()
);
create index announcements_league_published_idx
  on announcements (league_id, published_at desc);

alter table announcements enable row level security;

-- Public read: published announcements of a public league.
create policy "public read announcements" on announcements
  for select to anon, authenticated
  using (is_published and public.league_is_public(league_id));

-- Manager write: full control.
create policy "manager write announcements" on announcements
  for all to authenticated
  using (public.auth_role() = 'league_manager')
  with check (public.auth_role() = 'league_manager');

-- Privileges (rows still gated by RLS). 0008/0009 ran before this table existed,
-- so grant explicitly here.
grant select on announcements to anon, authenticated;
grant insert, update, delete on announcements to authenticated;
