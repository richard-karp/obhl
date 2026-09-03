-- The League Office: a tier above the league manager.
--
-- 0032's header claimed membership "removes the need for a superadmin tier".
-- That is true of GRANTING and false of REVOKING (0032's header is corrected in
-- the same change as this file). `profiles.role` is one instance-wide column,
-- so 0033 tests CONTAINMENT — every league the target works must be one the
-- actor works too — and where no single manager works every league a person
-- works, NOBODY can change that person's role and it is done by hand in SQL.
-- This is the tier that can.
--
-- Three tiers, one rule: YOU MAY WRITE A PROFILE ONLY IF YOUR TIER IS STRICTLY
-- ABOVE THEIRS.
--
--   commissioner  every league, present and future  writes anyone but a commissioner
--   deputy        every league, present and future  writes anyone outside the office
--   league manager  leagues they are a member of    writes tier-0 accounts whose
--                                                   leagues theirs contain, never
--                                                   another manager
--
-- That single comparison produces every rule asked for: commissioner↔commissioner,
-- deputy↔deputy and manager↔manager all fail it, which is "peers" stated once
-- instead of three times. Containment survives untouched at tier 0, where it is
-- still the whole of the test.
--
-- Two consequences, named because they are easy to misread:
--   * A deputy cannot touch the office AT ALL — not another deputy, not a
--     commissioner, and not the tier itself.
--   * The commissioner tier is NOT EDITABLE FROM THE APP, by anyone. It is
--     peer-flat, so no commissioner outranks another; appointing or removing one
--     is done in SQL. Deliberate: it is the same shape as manager demotion was,
--     and it means no single compromised office account can empty the tier.
--
-- The `app_role` enum and the 0010 custom-access-token hook are UNTOUCHED, so no
-- claim rides in the JWT, nothing goes stale, and the hook does not have to be
-- re-enabled by hand in the dashboard. It also means a revoked deputy loses
-- their power immediately rather than at the next token rotation, which is the
-- point of the tier.

create type office_tier as enum ('deputy', 'commissioner');

create table league_office (
  profile_id uuid primary key references profiles(id) on delete cascade,
  tier       office_tier not null,
  created_at timestamptz not null default now()
);

alter table league_office enable row level security;

-- ⛔ NO GRANTS TO `authenticated`, AND NO POLICIES. This is deliberate, and it
-- is a departure from this codebase's usual "an app guard plus an independent
-- RLS half".
--
-- 0009's blanket `grant insert, update, delete on all tables in schema public`
-- ran long before this table existed, so a new table starts with none — 0032 hit
-- the same thing and granted explicitly. This one does not, because AN ABSENT
-- GRANT IS STRONGER THAN ANY POLICY. A policy can be written wrong, or dropped
-- by a later migration that means to replace it; a table `authenticated` cannot
-- write at all has no such failure mode. There is no legitimate session-level
-- write here — every legitimate write is the admin client, on the service role.
--
-- `select` is not granted either. Nothing needs it: the helpers below are
-- SECURITY DEFINER, and every page that lists the office reads on the admin
-- client.

create or replace function public.office_tier_of(p_profile uuid)
returns office_tier language sql stable security definer set search_path = public as $$
  select tier from league_office where profile_id = p_profile;
$$;

create or replace function public.my_office_tier()
returns office_tier language sql stable security definer set search_path = public as $$
  select tier from league_office where profile_id = auth.uid();
$$;

-- ── Reach ──────────────────────────────────────────────────────────────────
--
-- "Full manager of every league" is delivered by ONE branch here. `manages_league(l)`
-- is already `auth_role() = 'league_manager' and is_league_member(l)`, so an
-- office member whose `profiles.role` stays 'league_manager' is granted every one
-- of the ~20 role-keyed policies in 0009/0032 WITH NO EDIT TO ANY OF THEM. That
-- is the whole reason this change is small.
--
-- ⛔ `p_league is not null` IS LOAD-BEARING AND NEW. 0032's header states the
-- invariant it protects:
--
--     All of them fail closed on a null argument — `= null` is never true —
--     which is what makes an unresolvable league a refusal rather than a pass.
--
-- The body below USED to fail closed only incidentally, because `league_id = null`
-- is never true. An `or` branch that does not mention `p_league` destroys that.
-- Without the explicit guard a commissioner passes `manages_league(null)` — and
-- null is what `logo_object_league` returns for a malformed storage path, what
-- `season_league` returns for a deleted season, and what every pre-0031 audit row
-- carries. The office would silently gain write access to every unresolvable and
-- orphaned object in the instance.
--
-- Do not "simplify" the conjunct away. No existing test covers it; the probe that
-- does is recorded in docs/worklists/2026-09-03-678b2916-league-office.md.

create or replace function public.is_league_member(p_league uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select p_league is not null and (
    public.my_office_tier() is not null
    or exists (
      select 1 from profile_leagues
      where profile_id = auth.uid() and league_id = p_league
    )
  );
$$;

-- ── Precedence ─────────────────────────────────────────────────────────────
--
-- ⛔ The office must be refused EXPLICITLY here rather than by leaning on
-- containment. An office member has NO `profile_leagues` rows — membership is a
-- rule here, not data — and `contains_leagues_of` asks "is there a league of
-- theirs that is not mine", which over an empty set is true for ANY caller. So
-- containment alone passes VACUOUSLY for the office: an ordinary league manager
-- satisfies `auth_role() = 'league_manager'`, and would therefore pass
-- `manager write profiles` against a commissioner and rewrite their
-- `profiles.role`.
--
-- `is distinct from` rather than `<>` ON PURPOSE: `office_tier_of` returns null
-- for everyone outside the office, and `null <> 'commissioner'` is null, not
-- true — which would refuse a commissioner every ordinary write.
--
-- This is the RLS half of `mayWriteProfileOf` in src/lib/auth/membership.ts.
-- ⚠️ They are ONE RULE WRITTEN TWICE and must be reviewed as a pair: same four
-- branches, same order.

create or replace function public.may_write_profile(p_profile uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select case public.my_office_tier()
    when 'commissioner' then public.office_tier_of(p_profile) is distinct from 'commissioner'
    when 'deputy'       then public.office_tier_of(p_profile) is null
    else public.office_tier_of(p_profile) is null
         and public.contains_leagues_of(p_profile)
  end;
$$;

-- `contains_leagues_of` (0033) is unchanged and now has exactly one caller: the
-- tier-0 branch above. Only the function this policy names changes.
--
-- `manager read profiles` keeps `shares_league_with`, as 0033 left it. Note what
-- that now means: an office member shares a league with everyone, so THEY READ
-- EVERY PROFILE IN THE INSTANCE. Intended, and written down here so it is not
-- later discovered and mistaken for a leak.

drop policy "manager write profiles" on profiles;
create policy "manager write profiles" on profiles
  for all to authenticated
  using (public.auth_role() = 'league_manager' and public.may_write_profile(id))
  with check (public.auth_role() = 'league_manager' and public.may_write_profile(id));

-- ── The invariant the tier depends on, enforced ────────────────────────────
--
-- ⚠️ THE OFFICE MULTIPLIES REACH, NOT ROLE. Every gate is `role AND membership`
-- — `manages_league` is `auth_role() = 'league_manager' and is_league_member(l)`,
-- `keeps_score_for` is the same shape for 'scorekeeper' — and the office branch
-- above widens only the membership half. So an office member who is not a
-- `league_manager` does not get a weaker version of the tier, they get a
-- DIFFERENT one: a scorekeeper in the office gains scoring in EVERY league and
-- no manager powers at all, and a captain gains nothing here while still
-- reaching every league's manage dashboard app-side.
--
-- Nothing above enforces the role, so these two triggers do. They exist in SQL
-- rather than in the app because the app is not the only writer: 0034 grants the
-- table to nobody, so every write is the admin client or hand-written SQL — and
-- hand-written SQL is the ONLY way to make a commissioner, the tier being
-- peer-flat. A guard the bootstrap path can skip is not a guard.

create or replace function public.league_office_requires_manager()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if (select role from profiles where id = new.profile_id)
     is distinct from 'league_manager'::app_role then
    raise exception
      'league_office requires profiles.role = league_manager (profile %)', new.profile_id
      using errcode = 'check_violation';
  end if;
  return new;
end $$;

create trigger league_office_requires_manager
  before insert or update on league_office
  for each row execute function public.league_office_requires_manager();

-- The other direction, and the one an appointment check alone misses: the role
-- can be changed AFTER the tier is granted. That path is reachable today —
-- `may_write_profile` lets a commissioner write a deputy, so a commissioner
-- could demote one to scorekeeper and leave the tier attached to a profile it
-- now means something entirely different for.
--
-- This is not a new rule. It enforces the two-step revocation the design already
-- documents: remove the tier in League Office, and only then is the person an
-- ordinary manager row whose role People & Roles may change. Until now that
-- ordering was a convention the UI observed and the server did not.

create or replace function public.office_member_keeps_manager_role()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.role is distinct from 'league_manager'::app_role
     and exists (select 1 from league_office where profile_id = new.id) then
    raise exception
      'profile % is in the League Office; remove the tier before changing the role', new.id
      using errcode = 'check_violation';
  end if;
  return new;
end $$;

create trigger office_member_keeps_manager_role
  before update of role on profiles
  for each row execute function public.office_member_keeps_manager_role();
