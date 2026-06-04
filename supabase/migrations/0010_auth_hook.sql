-- Custom Access Token hook: injects the user's app role into the JWT
-- app_metadata claims for cheap UI/route gating. RLS still authorizes via
-- auth_role() (the profiles table), so this claim is never the source of truth
-- for security decisions — only for which shell/nav to render.

create or replace function public.custom_access_token_hook(event jsonb)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  claims jsonb;
  v_role text;
begin
  select role::text into v_role from public.profiles where id = (event->>'user_id')::uuid;

  claims := coalesce(event->'claims', '{}'::jsonb);

  if v_role is not null then
    if claims ? 'app_metadata' then
      claims := jsonb_set(claims, '{app_metadata, role}', to_jsonb(v_role));
    else
      claims := jsonb_set(claims, '{app_metadata}', jsonb_build_object('role', v_role));
    end if;
  end if;

  return jsonb_set(event, '{claims}', claims);
end;
$$;

-- The hook runs as the auth admin role.
grant usage on schema public to supabase_auth_admin;
grant execute on function public.custom_access_token_hook to supabase_auth_admin;
revoke execute on function public.custom_access_token_hook from authenticated, anon, public;
-- The hook reads profiles; allow the auth admin to bypass RLS for this read.
grant select on public.profiles to supabase_auth_admin;
create policy "auth admin reads profiles" on profiles
  as permissive for select to supabase_auth_admin using (true);
