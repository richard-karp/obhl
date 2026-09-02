-- Per-league access control: membership, not a new role tier.
--
-- 0009 left roles GLOBAL and said so in its header: a scorekeeper or manager
-- could write any league's rows in a multi-league instance. That note also
-- named the fix, and this is it — a profile_leagues join table, with every
-- role-keyed policy re-stated to require membership in the row's league.
--
-- Deliberately membership-only. The `app_role` enum is untouched, and so is the
-- custom-access-token hook (0010): nothing here rides in the JWT, so no claim
-- can go stale and the hook does not have to be re-enabled by hand. A manager
-- grants access only inside leagues they are already in, which is what removes
-- the need for a superadmin tier.
--
-- `players` is deliberately NOT scoped. A person is one human across leagues —
-- the seed rosters the same two people in both — so the player row stays
-- globally writable and league scoping rides on team_players instead.

create table profile_leagues (
  profile_id uuid not null references profiles(id) on delete cascade,
  league_id  uuid not null references leagues(id)  on delete cascade,
  created_at timestamptz not null default now(),
  primary key (profile_id, league_id)
);
create index profile_leagues_league_idx on profile_leagues (league_id);

alter table profile_leagues enable row level security;

-- 0008/0009's blanket grants ran before this table existed, so grant here.
grant select on profile_leagues to authenticated;
grant insert, update, delete on profile_leagues to authenticated;

-- ── Helpers ────────────────────────────────────────────────────────────────
--
-- SECURITY DEFINER for the same reason as 0008's: a policy expression is
-- evaluated as the calling user, so a policy that reads another table would
-- recurse through that table's own RLS. These read the gating tables directly.
-- All of them fail closed on a null argument — `= null` is never true — which
-- is what makes an unresolvable league a refusal rather than a pass.

create or replace function public.is_league_member(p_league uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from profile_leagues
    where profile_id = auth.uid() and league_id = p_league
  );
$$;

-- The common pair: manager role AND membership of this league.
create or replace function public.manages_league(p_league uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select public.auth_role() = 'league_manager' and public.is_league_member(p_league);
$$;

create or replace function public.keeps_score_for(p_league uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select public.auth_role() = 'scorekeeper' and public.is_league_member(p_league);
$$;

create or replace function public.season_league(p_season uuid)
returns uuid language sql stable security definer set search_path = public as $$
  select league_id from seasons where id = p_season;
$$;

create or replace function public.game_league(p_game uuid)
returns uuid language sql stable security definer set search_path = public as $$
  select s.league_id
  from games g join seasons s on s.id = g.season_id
  where g.id = p_game;
$$;

-- Does the caller share a league with this profile? Backs the People & Roles
-- policies: a manager sees and edits the staff of their own leagues, not every
-- account in the instance.
create or replace function public.shares_league_with(p_profile uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1
    from profile_leagues mine
    join profile_leagues theirs on theirs.league_id = mine.league_id
    where mine.profile_id = auth.uid() and theirs.profile_id = p_profile
  );
$$;

-- ── Membership rows themselves ─────────────────────────────────────────────

create policy "own memberships read" on profile_leagues
  for select to authenticated using (profile_id = auth.uid());
-- A manager sees and edits membership only for leagues they belong to, so
-- granting access is bounded by the access they already have.
create policy "manager read memberships" on profile_leagues
  for select to authenticated using (public.manages_league(league_id));
create policy "manager write memberships" on profile_leagues
  for all to authenticated
  using (public.manages_league(league_id))
  with check (public.manages_league(league_id));

-- ── Backfill BEFORE the policies tighten ───────────────────────────────────
--
-- Everyone who exists today can already reach every league, so membership in
-- all of them is exactly today's behaviour written down. Skipping this would
-- lock every existing manager out of every league the moment the policies
-- below take effect — including whoever runs `supabase db push`.
--
-- Locally this is a no-op: `db reset` runs migrations and seed.sql (leagues, no
-- profiles) and `seed:users` creates the profiles afterwards, so that script
-- grants the memberships instead.
insert into profile_leagues (profile_id, league_id)
  select p.id, l.id from profiles p cross join leagues l
  on conflict do nothing;

-- ── 0009's role policies, re-stated with membership ────────────────────────

drop policy "manager write leagues" on leagues;
-- Note the insert side: a league that does not exist yet has no members, so a
-- manager cannot create one through their own session. League creation runs on
-- the admin client (`runEsportsdeskImport`), which grants the creating manager
-- membership in the same breath.
create policy "manager write leagues" on leagues
  for all to authenticated
  using (public.manages_league(id)) with check (public.manages_league(id));

drop policy "manager write seasons" on seasons;
create policy "manager write seasons" on seasons
  for all to authenticated
  using (public.manages_league(league_id))
  with check (public.manages_league(league_id));

drop policy "manager write divisions" on divisions;
create policy "manager write divisions" on divisions
  for all to authenticated
  using (public.manages_league(public.season_league(season_id)))
  with check (public.manages_league(public.season_league(season_id)));

drop policy "manager write teams" on teams;
create policy "manager write teams" on teams
  for all to authenticated
  using (public.manages_league(league_id))
  with check (public.manages_league(league_id));

-- "manager write players" is intentionally left alone — see the header.

drop policy "manager write season_teams" on season_teams;
create policy "manager write season_teams" on season_teams
  for all to authenticated
  using (public.manages_league(public.season_league(season_id)))
  with check (public.manages_league(public.season_league(season_id)));

drop policy "manager write team_players" on team_players;
create policy "manager write team_players" on team_players
  for all to authenticated
  using (public.manages_league(public.season_league(season_id)))
  with check (public.manages_league(public.season_league(season_id)));

drop policy "manager write league_rules" on league_rules;
create policy "manager write league_rules" on league_rules
  for all to authenticated
  using (public.manages_league(league_id))
  with check (public.manages_league(league_id));

drop policy "manager write games" on games;
create policy "manager write games" on games
  for all to authenticated
  using (public.manages_league(public.season_league(season_id)))
  with check (public.manages_league(public.season_league(season_id)));

drop policy "scorekeeper update games" on games;
create policy "scorekeeper update games" on games
  for update to authenticated
  using (public.keeps_score_for(public.season_league(season_id)))
  with check (public.keeps_score_for(public.season_league(season_id)));

drop policy "manager write game_rosters" on game_rosters;
create policy "manager write game_rosters" on game_rosters
  for all to authenticated
  using (public.manages_league(public.game_league(game_id)))
  with check (public.manages_league(public.game_league(game_id)));

drop policy "scorekeeper write game_rosters" on game_rosters;
create policy "scorekeeper write game_rosters" on game_rosters
  for all to authenticated
  using (public.keeps_score_for(public.game_league(game_id)))
  with check (public.keeps_score_for(public.game_league(game_id)));

-- The three captain game_rosters policies are untouched. They already derive
-- from team_players -> season -> league via is_captain_of, so they are
-- league-correct without membership and stay that way.

-- Profiles: a manager reads and manages the staff of their own leagues only.
-- "own profile read"/"own profile update" and 0010's auth-admin policy are
-- untouched, so a person can always see themselves and the JWT hook still runs.
drop policy "manager read profiles" on profiles;
create policy "manager read profiles" on profiles
  for select to authenticated
  using (public.auth_role() = 'league_manager' and public.shares_league_with(id));

drop policy "manager write profiles" on profiles;
create policy "manager write profiles" on profiles
  for all to authenticated
  using (public.auth_role() = 'league_manager' and public.shares_league_with(id))
  with check (public.auth_role() = 'league_manager' and public.shares_league_with(id));

-- ── 0012's announcements ───────────────────────────────────────────────────

drop policy "manager write announcements" on announcements;
create policy "manager write announcements" on announcements
  for all to authenticated
  using (public.manages_league(league_id))
  with check (public.manages_league(league_id));

-- ── 0021's audit log ───────────────────────────────────────────────────────
--
-- 0031 added league_id nullable and did not backfill; a null-league entry is
-- already filtered out of every scoped view, and `manages_league(null)` is
-- false, so those rows stay invisible here too.
drop policy "managers read audit_log" on audit_log;
create policy "managers read audit_log" on audit_log
  for select to authenticated using (public.manages_league(league_id));

-- ── 0011's logo storage ────────────────────────────────────────────────────
--
-- Logos are written as `teams/<uuid>.<ext>` (see uploadTeamLogo), which is the
-- only claim of ownership a storage object carries. plpgsql rather than sql so
-- the shape check is guaranteed to run BEFORE the cast: in a single sql
-- statement the planner may evaluate the `::uuid` first and error on a path
-- that is not a team logo at all.
--
-- Any other shape returns null, and `manages_league(null)` is false, so it is
-- refused. That is the right default, but it is silent: `leagues.logo_path`
-- exists with nothing writing it today, and a league-logo upload added later
-- would be refused here with no clue why. Give it a branch when it arrives.
create or replace function public.logo_object_league(p_name text)
returns uuid language plpgsql stable security definer set search_path = public as $$
declare v_league uuid;
begin
  if p_name !~ '^teams/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\.' then
    return null;
  end if;
  select league_id into v_league from teams where id = substring(p_name from 7 for 36)::uuid;
  return v_league;
end $$;

drop policy "manager insert logos" on storage.objects;
create policy "manager insert logos" on storage.objects
  for insert to authenticated
  with check (bucket_id = 'logos' and public.manages_league(public.logo_object_league(name)));

drop policy "manager update logos" on storage.objects;
create policy "manager update logos" on storage.objects
  for update to authenticated
  using (bucket_id = 'logos' and public.manages_league(public.logo_object_league(name)));

drop policy "manager delete logos" on storage.objects;
create policy "manager delete logos" on storage.objects
  for delete to authenticated
  using (bucket_id = 'logos' and public.manages_league(public.logo_object_league(name)));
