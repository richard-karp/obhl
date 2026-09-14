-- A signed-in session may not change a profile's id, role or player link.
--
-- ⛔ 0009's "own profile update" is `using (id = auth.uid())` with no column
-- list, so any account — the shared scorekeeper login included — could run
-- `update profiles set role = 'league_manager' where id = auth.uid()`. RLS
-- applied it at once, and the JWT hook copied it at the next refresh. Setting
-- `player_id` the same way made `is_captain_of` (0038) true for another
-- league's team. Reproduced on the local stack 2026-09-13.
--
-- ⛔ `id` TOO. 0033's "manager write profiles" is FOR ALL, so a manager session
-- could re-key a profile row that nothing references onto another auth account,
-- moving its `role` and `player_id` there without either column changing.
--
-- Every legitimate write to these columns is a server action on the service-role
-- client (people.ts, seasons.ts, players.ts), so refusing the user-facing roles
-- outright costs nothing. `display_name` stays writable by its owner.
--
-- ⚠️ The user roles are refused BY NAME (`authenticated`, `anon`). PostgREST
-- only ever switches to anon, authenticated or service_role, so those two are
-- every session a browser can reach, and the service role and psql pass.
--
-- ⚠️ SECURITY INVOKER ON PURPOSE. `current_user` must be the caller's role; a
-- SECURITY DEFINER trigger would see its owner and let everything through.
create or replace function public.profiles_privileged_columns_are_server_only()
returns trigger language plpgsql security invoker set search_path = public as $$
begin
  if current_user not in ('authenticated', 'anon') then
    return new;
  end if;
  if tg_op = 'INSERT' then
    if new.role is not null or new.player_id is not null then
      raise exception 'profiles.role and profiles.player_id are set by the server only'
        using errcode = 'insufficient_privilege';
    end if;
  elsif new.id is distinct from old.id
     or new.role is distinct from old.role
     or new.player_id is distinct from old.player_id then
    raise exception 'profiles.id, profiles.role and profiles.player_id are set by the server only'
      using errcode = 'insufficient_privilege';
  end if;
  return new;
end $$;

drop trigger if exists profiles_privileged_columns_are_server_only on profiles;
create trigger profiles_privileged_columns_are_server_only
  before insert or update on profiles
  for each row execute function public.profiles_privileged_columns_are_server_only();
