-- Public bucket for team/league logos. Public read; managers write (uploads go
-- through the service-role admin client, but these policies also allow a
-- manager session to write directly).
insert into storage.buckets (id, name, public)
values ('logos', 'logos', true)
on conflict (id) do nothing;

create policy "public read logos" on storage.objects
  for select to anon, authenticated using (bucket_id = 'logos');

create policy "manager insert logos" on storage.objects
  for insert to authenticated
  with check (bucket_id = 'logos' and public.auth_role() = 'league_manager');

create policy "manager update logos" on storage.objects
  for update to authenticated
  using (bucket_id = 'logos' and public.auth_role() = 'league_manager');

create policy "manager delete logos" on storage.objects
  for delete to authenticated
  using (bucket_id = 'logos' and public.auth_role() = 'league_manager');
