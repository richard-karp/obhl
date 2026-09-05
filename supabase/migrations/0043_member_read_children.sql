-- The other half of 0042: make a staged league WORK for the people who staff it.
--
-- 0042 widened the `leagues` ROW to any member, and said in its own header what
-- it deliberately did not do:
--
--     So a scorekeeper or captain member of a staged league now gets a 200
--     instead of a 404, and the page is EMPTY [...] Making that true means
--     widening `league_is_public`/`season_is_public`, which changes the gate on
--     every child table at once. That is a materially bigger decision and wants
--     its own migration and its own review.
--
-- This is that migration. A scorekeeper who cannot see a single game is not
-- staffing anything, so "reachable but empty" was never a resting place.
--
-- ⛔ THE HELPERS ARE NOT TOUCHED, AND THAT IS THE DESIGN. The obvious move is to
-- redefine `league_is_public(l)` as `... or is_league_member(l)`. Do not: it
-- makes a function called `_is_public` return true for a league that is not
-- public, and it is read by `player_is_public` and `game_is_public_final`, so
-- the lie would propagate into two more predicates that other policies compose
-- with. Postgres ORs the policies of a table together, so a SECOND policy per
-- table buys the same widening with each half still saying what it means —
-- exactly the shape 0042 used, for the same reason.
--
-- SELECT ONLY, every one of them. Membership is not permission to write; 0009
-- and 0032's role policies still govern that, untouched.
--
-- ⚠️ WHAT A MEMBER CAN NOW SEE that they could not before: the seasons, teams,
-- rosters, rules, published announcements and non-draft games of a STAGED league
-- they belong to. Not another league's — every predicate below resolves the row
-- back to a league and asks `is_league_member` about THAT league. Not drafts,
-- and not unpublished announcements: those are the manager's staging area, and
-- 0032's `for all` policies already give the manager both.
--
-- `is_league_member` fails closed on null (0034's load-bearing guard) and passes
-- for the office, so both properties are inherited here rather than restated —
-- an unresolvable season or game refuses, and a commissioner keeps reading
-- everything.

-- Players are a global table with no league_id, so membership has to be reached
-- through a roster — the mirror of 0008's `player_is_public`, which asks the same
-- question about public leagues. SECURITY DEFINER because it reads three tables
-- the caller may not be able to select from; that is what makes it a predicate
-- rather than a leak.
create or replace function public.player_in_my_league(p_player uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1
    from team_players tp
    join seasons s on s.id = tp.season_id
    where tp.player_id = p_player and public.is_league_member(s.league_id)
  );
$$;

create policy "member read seasons" on seasons
  for select to authenticated using (public.is_league_member(league_id));

create policy "member read divisions" on divisions
  for select to authenticated
  using (public.is_league_member(public.season_league(season_id)));

create policy "member read teams" on teams
  for select to authenticated using (public.is_league_member(league_id));

create policy "member read players" on players
  for select to authenticated using (public.player_in_my_league(id));

create policy "member read season_teams" on season_teams
  for select to authenticated
  using (public.is_league_member(public.season_league(season_id)));

create policy "member read team_players" on team_players
  for select to authenticated
  using (public.is_league_member(public.season_league(season_id)));

create policy "member read league_rules" on league_rules
  for select to authenticated using (public.is_league_member(league_id));

-- `not is_draft` is carried over from 0008 ON PURPOSE. A draft game is the
-- schedule builder's scratch space, and 0024 exists because drafts leaking into
-- the stats views was a bug. A manager reads their own drafts through 0032's
-- `for all`; nobody else needs to.
create policy "member read games" on games
  for select to authenticated
  using (not is_draft and public.is_league_member(public.season_league(season_id)));

-- ⚠️ Wider than 0008's public rule, which is FINAL games only (the box score).
-- A member of the league is exactly who has business seeing a lineup before the
-- puck drops: it is what a captain sets and a scorekeeper works from. 0009's
-- `captain read game_rosters` already grants a narrower version of this to one
-- role; this generalises it to the league's own people and no further.
create policy "member read game_rosters" on game_rosters
  for select to authenticated
  using (public.is_league_member(public.game_league(game_id)));

-- Published only, matching 0008's shape. An unpublished announcement is a draft
-- by another name.
create policy "member read announcements" on announcements
  for select to authenticated
  using (is_published and public.is_league_member(league_id));
