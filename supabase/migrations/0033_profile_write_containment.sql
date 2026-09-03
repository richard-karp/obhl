-- The RLS half of "a role write may not reach a league you cannot see".
--
-- 0032 gated `manager write profiles` on `shares_league_with(id)` — do the
-- caller and the target share ANY league. That is the right test for READING
-- staff, and the wrong one for writing them, because sharing a league is
-- something the caller can arrange:
--
--   1. insert into profile_leagues (<their profile>, <my league>)
--      — permitted by "manager write memberships", and permitted on purpose:
--        granting someone a league you already manage is how one person comes
--        to work both, and it writes no profile.
--   2. update profiles set role = 'league_manager' where id = <them>
--      — `shares_league_with` now passes, because step 1 made it pass.
--
-- `profiles.role` is one instance-wide column (0009 reads it as the role
-- source, 0010's hook copies it into the JWT), so step 2 lands in every league
-- that account works — including the ones the caller cannot reach. Both steps
-- were watched succeeding through an ordinary signed-in session on the anon
-- key, with no admin client and no app page involved: a manager of `harbor`
-- turned `obhl`'s scorekeeper into a manager of `obhl`.
--
-- The app-side guard (`mayWriteProfileOf`, `src/lib/auth/membership.ts`) already
-- refuses this, and every write People & Roles makes goes through the admin
-- client where no policy runs. This is the second, independent half: the same
-- test, for a session addressing PostgREST directly.
--
-- CONTAINMENT, not overlap: every league the target works must be one the
-- caller works too. A profile in no league passes vacuously, which is what keeps
-- "removed by mistake, add them back" working — `removeStaff` revokes the
-- membership and leaves exactly that shape.
--
-- Step 1 is deliberately left permitted. It is the flow the membership model
-- exists for, and closing step 2 is what makes it safe to keep.
--
-- ⚠️ This policy is not strictly tighter than the one it replaces. Containment
-- passes vacuously where overlap failed, so two things a manager could NOT do
-- through their own session under 0032 are permitted from here (both watched, on
-- the anon key, as a manager of one league):
--
--   * INSERT a profiles row for an auth user that has none — including with
--     role 'league_manager';
--   * UPDATE the role of an existing profile that belongs to no league.
--
-- Neither hands out anything. A role with no league reaches nothing: every
-- policy in 0032 asks `manages_league(...)`, which needs a membership row, and a
-- manager can still only grant leagues they manage. So the reachable end state
-- is a co-manager of a league they already manage, which People & Roles offers
-- them anyway.
--
-- It is also the intended shape rather than a side effect: `mayWriteProfileOf`
-- has always had this carve-out app-side, and 0032 did not, so a profile that
-- `removeStaff` had emptied of leagues was writable through the app and refused
-- through the API. The two halves now agree.

create or replace function public.contains_leagues_of(p_profile uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select not exists (
    select 1
    from profile_leagues theirs
    where theirs.profile_id = p_profile
      and not exists (
        select 1
        from profile_leagues mine
        where mine.profile_id = auth.uid()
          and mine.league_id = theirs.league_id
      )
  );
$$;

-- Only the WRITE policy changes. `manager read profiles` keeps
-- `shares_league_with`: a manager should see the staff of a league they share,
-- and reading one changes nothing anywhere else.
drop policy "manager write profiles" on profiles;
create policy "manager write profiles" on profiles
  for all to authenticated
  using (public.auth_role() = 'league_manager' and public.contains_leagues_of(id))
  with check (public.auth_role() = 'league_manager' and public.contains_leagues_of(id));
