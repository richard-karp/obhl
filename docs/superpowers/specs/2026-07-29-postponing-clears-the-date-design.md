# Postponing a game clears its date

## Problem

`postponeGame` set `status = 'postponed'` and nothing else. Its own docstring
claimed "date TBD until rescheduled", but `scheduled_at` kept pointing at the
original date, so every consumer stated something untrue:

- The schedule page listed the game on a night it was not being played.
- Both `.ics` feeds published it as an event at that time.
- The CSV export had to withhold postponed games entirely, because with four
  columns and no status there was no way to tell the truth about one.

The export work made this visible: it is the only reason a game had to be
suppressed rather than described.

## Goals

1. A postponed game stops claiming a date it is not being played on.
2. Postponing stays reversible, and stays non-destructive.
3. The one-off planner keeps seeing the night a postponed game belongs to.

## Non-goals

- **Auditing status changes.** `setStatus` still doesn't call `logAudit`; that
  gap is real but wider than this change. Preserving the date in a column makes
  it moot for postponement specifically.
- **Changing what cancelling does.** A cancelled game keeps its date, and stays
  withheld from exports for exactly the reason postponed games no longer need
  to be.

---

## 1. `postponed_from`

`0025_postponed_from.sql` adds `postponed_from timestamptz`. Postponing moves
`scheduled_at` into it; rescheduling and restoring clear it.

Clearing the date outright was the smaller change, and was rejected for three
reasons:

| Without the column | Consequence |
|---|---|
| The night is unrecoverable | `getSeasonNights` groups on the date. A dateless postponed game disappears from its night, taking the night's lock with it — so the one-off planner could re-pair a night it must not touch, and would see it one game short. |
| The date is unrecoverable | Status changes are not audited, so postponing would destroy the original time with no record. |
| Restore has nowhere to go | `restoreGame` only set `status`, so restoring would leave a `scheduled` game with no date — a state the app has never produced. |

The migration backfills: existing `postponed` rows move `scheduled_at` into
`postponed_from`. Without that they keep a date they are not being played on,
and — since exports no longer withhold postponed games — would be published at
it.

## 2. Two RPCs

PostgREST cannot express `set postponed_from = scheduled_at`; doing it from the
client means a read followed by an update, which is two round trips with a
window in between. `postpone_game(uuid)` and `restore_game(uuid)` follow the
convention already set by `bump_game_empty_net`
(`supabase/migrations/0018_empty_net_rpc.sql`) — `security invoker`, pinned
`search_path`, execute granted to `authenticated`.

Both are idempotent by construction:

- `postpone_game` writes `coalesce(postponed_from, scheduled_at)`, so postponing
  an already-postponed game doesn't overwrite the original date with the null it
  now carries.
- `restore_game` writes `coalesce(scheduled_at, postponed_from)`, which covers a
  cancelled game (keeps its date, only the status flips) and a postponed one
  (takes its date back) in one statement.

`rescheduleGame` stays a plain update, with `postponed_from: null` added — a game
given a new date is not postponed any more, and leaving the column set would keep
parking it on the night it was postponed from.

## 3. `groupIntoNights`

The night grouping and locking rules moved out of `getSeasonNights` into a pure
`groupIntoNights(rows, today)` in `src/lib/schedule/nights.ts`. `getSeasonNights`
now only fetches.

This was not tidying. The rule that protects the planner — *a postponed game
still belongs to, and still locks, the night it was postponed from* — was
unreachable by tests while it lived inside a function that needs a database, and
the one-off e2e spec locks every night by date (its seeded games are all in the
past) so it never exercised locking by status at all. As a pure function it is
covered directly, including the case that would have broken.

Games are placed by `scheduled_at ?? postponed_from`. A game with neither is
dropped: nothing ties it to a night.

## 4. Exports stop withholding postponed games

`isExportableFixture` narrows to `cancelled` alone.

A postponed game is now genuinely undated, so it is no longer claiming a slot it
isn't being played in. The CSV describes it accurately as a row with empty date
and time cells — the undated handling that was already built and tested, and
which until this change was essentially unreachable in practice. `buildIcs` drops
it exactly as it drops any undated game, so the feeds need no rule of their own.

This reopens, with better information, the choice made when the feeds first
started withholding: the reason to suppress a postponed game was that it carried
a false date, and it no longer does.

## 5. UI

`GameRow` renders "Postponed from &lt;date&gt; · &lt;time&gt;" when
`postponed_from` is set. Without it the game reads only as "TBD" under the
schedule page's "Date TBD" group, and when it was meant to be played becomes
invisible — which would trade one kind of dishonesty for another.

## 6. Verification

`groupIntoNights` has ten tests, including a postponed game keeping its night and
locking it, and a game with no date at all being dropped.

Live, against a seeded database: postponing a game moved it out of its date group
into "Date TBD" with its original date shown, made it appear in the CSV as
`,,Gulls,Mariners`, and dropped the season feed from 6 events to 5. `restore_game`
returned the exact original timestamp and cleared `postponed_from`; the CSV and
feed both returned to 6.

## 7. Migration verification

`supabase db reset` replays the full chain, `0001` through `0025`, and seeds
cleanly.

The backfill was verified separately, because a fresh database has no postponed
rows for it to convert. A row was put into the shape production rows are in today
— `status = 'postponed'`, date intact, `postponed_from` null — the migration's
`update` was run verbatim against it, and the date moved across as intended. The
whole check ran inside a transaction that was rolled back.

`restore_game`'s status guard was checked the same way: called against a `final`
game, it leaves the row untouched.

## 8. Guarding against a resurrected date

`SeasonNightGame.scheduledAt` carries the game's own `scheduled_at` — null for a
postponed game — and *not* the date its night was derived from. The two differ
only for postponed games, and the distinction matters because the one-off repair
writes that value straight back to the column
(`src/lib/actions/schedule.ts`).

Conflating them would let the repair restore a date that had been cleared on
purpose, leaving a row that claims both a schedule and a postponement. That path
is unreachable — the repair only builds rows for unlocked nights, and a postponed
game always locks its own — but the protection sat two modules away from the
write. Splitting the field means that if it ever were reached, the write would
leave the game undated rather than corrupt it.
