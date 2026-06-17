create table audit_log (
  id          uuid primary key default gen_random_uuid(),
  session_id  uuid,
  user_id     uuid references auth.users,
  action      text not null,
  entity_type text not null,
  entity_id   text not null,
  old_data    jsonb,
  new_data    jsonb,
  created_at  timestamptz default now()
);
create index on audit_log (session_id);
create index on audit_log (created_at desc);

alter table audit_log enable row level security;
create policy "managers read audit_log"
  on audit_log for select to authenticated
  using (public.auth_role() = 'league_manager');
