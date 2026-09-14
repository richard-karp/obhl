-- Team logos are PNG, JPEG or WebP in storage itself, not only in the app.
--
-- ⛔ `uploadTeamLogo` takes the name and type from an allowlist
-- (`src/lib/utils/logo-type.ts`), but that check is not in the path of a
-- manager's own session. 0032's "manager insert logos" and "manager update
-- logos" accept any `teams/<uuid>.<anything>`, and 0011 made the bucket with no
-- `allowed_mime_types`, so a manager session could store `teams/<team>.svg` as
-- `image/svg+xml` in a PUBLIC bucket — script served from the Storage origin.
-- Reproduced through supabase-js on the local stack 2026-09-13.
--
-- Two halves, each covering what the other cannot:
--   - the bucket refuses a TYPE outside the list, whatever the name, and for
--     every client, the admin client included;
--   - the name check refuses an EXTENSION outside it, whatever type is claimed,
--     so a manager session can only ever write a raster file name.

update storage.buckets
  set allowed_mime_types = array['image/png', 'image/jpeg', 'image/webp']
  where id = 'logos';

-- 0032's function with the extension anchored. All three write policies on the
-- bucket resolve their league through it, so a name outside the list resolves
-- to null and `manages_league(null)` refuses it — no policy is re-created.
--
-- ⚠️ DELETE too: a manager session can no longer remove an existing non-raster
-- object. Nothing does that — `logos.ts` is the only storage caller, on the
-- admin client, where no policy runs.
-- ⚠️ Case-sensitive, like the app: `logoFileType` lowercases the extension.
create or replace function public.logo_object_league(p_name text)
returns uuid language plpgsql stable security definer set search_path = public as $$
declare v_league uuid;
begin
  if p_name !~ '^teams/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\.(png|jpe?g|webp)$' then
    return null;
  end if;
  select league_id into v_league from teams where id = substring(p_name from 7 for 36)::uuid;
  return v_league;
end $$;
