-- `set-password` was the one top-level route missing from 0030's list.
--
-- `src/app/set-password/` has existed since the auth work; 0030 reserved
-- api/auth/login/manage/_next and did not include it. A league named "Set
-- password" slugifies to `set-password`, passes every check, and is created at
-- an address that can never resolve — Next matches the static segment first, so
-- /set-password is the password form and the league behind it is unreachable,
-- along with every manage tool under it. Nothing errors; the league is simply
-- gone. There is still no UI to delete one.
--
-- ⚠️ THE CONSEQUENCE GOT WORSE ON 2026-09-08, which is why this is being fixed
-- now rather than left. League creation moved to /manage/leagues/new and a
-- clean import now REDIRECTS into the league it just made, so an import named
-- this way sends the manager to /set-password/seasons — a 404 — instead of
-- showing them a message they could at least read.
--
-- Mirrored in `src/lib/league/reserved-slugs.ts`. Change both together: the app
-- covers the importers, and this covers the hand-written SQL inserts that 0030
-- was written for.
alter table leagues
  drop constraint leagues_slug_not_reserved;

alter table leagues
  add constraint leagues_slug_not_reserved
  check (slug not in ('api', 'auth', 'login', 'manage', 'set-password', '_next'));
