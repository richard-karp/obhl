-- The audit log had no league. Every manager can open /<league>/manage/audit,
-- and it listed — and offered to revert — every league's actions, so the league
-- in the URL described the nav and nothing else. Reverting is a write: it
-- reopens games, restores player status, undoes captaincy.
--
-- Nullable, and deliberately not backfilled. Rows written before this migration
-- have no league and drop out of the scoped list; the alternative is deriving
-- each one through its entity type, which is the same four lookups logAudit now
-- does at write time. Nothing has been bootstrapped in production yet, so there
-- is no history worth that.
alter table audit_log
  add column league_id uuid references leagues(id) on delete cascade;

create index on audit_log (league_id, created_at desc);
