-- A league lives at /<slug>, matched by the `[league]` dynamic segment. Next
-- resolves static segments first, so a league whose slug is a top-level route
-- can never be reached: /login is the sign-in page, and the league behind it —
-- along with its manage tools — simply does not resolve. Nothing errors.
--
-- The application rejects these too (src/lib/league/reserved-slugs.ts), but
-- there is no league-creation UI: leagues are inserted by hand-written SQL, so
-- the database is the only place that covers every path. Change both together.
--
-- `manage` would in fact work, since it sits under [league] rather than beside
-- it. It is reserved so that no league answers to /manage/manage/dashboard.
alter table leagues
  add constraint leagues_slug_not_reserved
  check (slug not in ('api', 'auth', 'login', 'manage', '_next'));

-- The empty slug is the same failure by another route. slugify() returns "" for
-- a name with no letters or digits, and "" passes not-null, passes the
-- lower-case check, and is in no reserved list — leaving a league addressed at
-- "/", which is the league picker. Named separately so the violation says which
-- rule was broken.
alter table leagues
  add constraint leagues_slug_not_empty
  check (slug <> '');
