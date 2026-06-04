-- League rules, stored as Tiptap/ProseMirror JSON (one row per league).
create table league_rules (
  id uuid primary key default gen_random_uuid(),
  league_id uuid not null references leagues(id) on delete cascade unique,
  content jsonb,
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users(id) on delete set null
);
