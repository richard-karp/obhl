-- `tonight` becomes a top-level route: the scorekeeper's page moves from
-- /manage/tonight to /tonight.
--
-- It sat under /manage/ because that segment was already reserved and the two
-- pages there — the League Office and league creation — are the other routes
-- belonging to no league. It reads wrong for this one: `manage` describes the
-- role that CANNOT manage anything, and this page is a scorekeeper's home,
-- typed on a phone at a rink. Short and honest beat free.
--
-- ⛔ THE RESERVATION IS THE WHOLE COST OF THAT MOVE, AND SKIPPING IT IS SILENT.
-- A league named "Tonight" slugifies to `tonight`, passes every check, and is
-- created at an address that can never resolve — Next matches the static
-- segment first, so /tonight is the scorekeeper's page and the league behind it
-- is unreachable, along with every tool under it. Nothing errors; the league is
-- simply gone, and there is still no UI to delete one.
--
-- That is not hypothetical. `set-password` did exactly this until `0047`, and
-- the damage grew when league creation began redirecting into the league it had
-- just made — an import named that way landed the manager on a 404 instead of a
-- message they could read.
--
-- Mirrored in `src/lib/league/reserved-slugs.ts`. ⚠️ CHANGE BOTH TOGETHER: this
-- covers hand-written SQL inserts, the app list covers the importers, and
-- `reserved-slugs.test.ts` fails if the two ever disagree — which is the only
-- reason this pair is safe to maintain by hand.
alter table leagues
  drop constraint leagues_slug_not_reserved;

alter table leagues
  add constraint leagues_slug_not_reserved
  check (slug not in ('api', 'auth', 'login', 'manage', 'set-password', 'tonight', '_next'));
