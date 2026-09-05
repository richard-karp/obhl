-- Removing a person from a LEAGUE, without removing them from the database.
--
-- ⛔ LEAGUE-SCOPED, NOT A COLUMN ON `players`. The obvious shape is
-- `players.archived_at`, and it is wrong here for the reason 0002_core.sql:43
-- and 0032's header both state: `players` is deliberately global, one human is
-- one row, and the same person plays in more than one league. The add-player
-- picker reads `players` unfiltered ("Global people not already on this team's
-- roster"), so a global flag would make "remove them from THIS league" also
-- erase them from every OTHER league's picker — silently, for people those
-- leagues never touched and whose managers were never asked.
--
-- A row per (player, league) is what "removed from the league" actually means.
--
-- ⚠️ THIS IS A VISIBILITY RECORD, NOT A DELETION. Nothing here touches
-- team_players, game_rosters, or either stats view: every game a person played
-- is still theirs, every team page still shows what was earned in that sweater,
-- and their player page still renders. Archiving takes them out of the lists
-- that ask "who could join a team / be a captain here", and nothing else.
--
-- The rule that keeps that coherent lives in `archivePlayer`
-- (src/lib/actions/rosters.ts): a person with an ACTIVE roster row in the league
-- cannot be archived. Not enforced here — it spans seasons and would need a
-- trigger reading team_players on every insert — but a reader wondering why an
-- archived person is never in the roster table should know it is a rule and not
-- a coincidence.
--
-- ⚠️ IT IS A RULE ITS WRITERS APPLY, NOT AN INVARIANT THIS SCHEMA HOLDS.
-- THREE writers, and counting them wrong is how the gap opened the first time:
-- this paragraph said "two" until a review found `mergePlayers` repointing
-- `team_players.player_id` with no archive check at all — archive someone whose
-- rows here are all departed, then merge an actively-rostered duplicate into
-- them, and no interleaving is needed for the bad state, just the two steps in
-- order. Now guarded in `planMerge` (reason `keep-archived`).
--
-- So: `archivePlayer`, `addRosterPlayer` and `mergePlayers`, each reading what
-- the others write. The remaining hole is a race, not a sequence —
-- `archivePlayer` re-reads the roster after its write and undoes itself, which
-- closes the order where an add arrives mid-archive; the reverse order is still
-- open. Making it actually hold needs the trigger.
--
-- ⛔ ANY FUTURE WRITER OF `team_players.player_id` OR OF THIS TABLE JOINS THAT
-- LIST. There is nothing in the schema to stop one, which is the whole point of
-- this paragraph — count the writers before trusting the one above it.

create table player_league_archive (
  player_id   uuid not null references players(id)  on delete cascade,
  league_id   uuid not null references leagues(id)  on delete cascade,
  archived_at timestamptz not null default now(),
  -- The one FK that is NOT cascade: an entry outliving the account that made it
  -- must stay an entry. Deleting the manager must not un-archive people.
  archived_by uuid references profiles(id) on delete set null,
  primary key (player_id, league_id)
);

-- The read this table exists for is "everyone archived in THIS league", which is
-- the league alone. The primary key leads on player_id and cannot serve it.
create index player_league_archive_league_idx on player_league_archive (league_id);

-- ⛔ NOT OPTIONAL, AND ITS ABSENCE HAS NO SYMPTOM.
--
-- MEASURED 2026-09-04, against the local database, because 0034 and
-- verify-transfers.mjs disagree about this and the answer decides whether the
-- next new table is safe. Created a bare `create table _grant_probe (id uuid
-- primary key)` in `public` and read `information_schema.role_table_grants`:
--
--     anon          = SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER
--     authenticated = SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER
--     relrowsecurity = false
--
-- So a new public table arrives FULLY WRITABLE BY EVERY SESSION, ANONYMOUS
-- INCLUDED, with RLS off — Supabase's default privileges, not 0009's blanket
-- grant, which did run before this table existed.
--
-- ⚠️ `0034_league_office.sql:53` asserts the opposite ("a new table starts with
-- none"). It is wrong on the facts and safe in effect: `league_office` still
-- holds all seven privileges for `authenticated` today, and is protected only by
-- the `enable row level security` on its next line, with no policy to satisfy.
-- That is the load-bearing half. Do not read its comment as licence to skip this
-- line.
--
-- Nothing here would look wrong if it were missing, either: every read below
-- goes through the admin client, which bypasses RLS regardless.
alter table player_league_archive enable row level security;

-- ⛔ NO GRANTS, AND AN EXPLICIT REVOKE. Same reasoning as 0034_league_office.sql:
-- an absent privilege is stronger than any policy, because a policy can be
-- written wrong or dropped by a later migration meaning to replace it. There is
-- no legitimate session-level write here — archiving and restoring run on the
-- admin client behind `requireLeagueManagerOf`, and every read (the add-player
-- picker, the captain-candidate list) is an admin-client read on a manage page.
--
-- The revoke is a SECOND, INDEPENDENT layer over the `enable row level
-- security` above, and the measurement shows it is doing real work rather than
-- restating it: without this line the table keeps all seven default privileges
-- and is refused only by RLS. With it, `authenticated` holds nothing at all, so
-- a later migration that drops or rewrites a policy cannot open this table by
-- accident. Watched afterwards: manager, scorekeeper, captain and anon sessions
-- all get `42501 permission denied` on both select and insert, while the admin
-- client (service_role) still writes.
revoke all on player_league_archive from anon, authenticated;
