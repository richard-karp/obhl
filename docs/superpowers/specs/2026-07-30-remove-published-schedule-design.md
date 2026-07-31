# Removing a published schedule

Follow-on to `2026-07-30-one-published-schedule-design.md`, which built the
replace path. That spec listed a standalone unpublish as a non-goal on the
grounds that "nothing asks for it". Something did: a manager looking at a
season holding 172 published games found no way to empty it, and no
indication that generating a draft was what would unlock replacing it.

## Problem

Two distinct failures, found in the same sitting on the same screen.

**No way to remove.** `is_draft` is one-way. Every `.delete()` against `games`
in the app is filtered `is_draft = true`; the only exception is the delete
inside `replace_published_schedule`, which requires a draft standing ready to
take the old schedule's place. A season whose published schedule is simply
wrong cannot be emptied — only overwritten.

**No way to tell.** In `published` mode the builder renders a count
("Published: 172 games · September 10, 2026 → March 10, 2027") and an empty
state reading "Generate one above to preview it here before publishing."
Neither says that generating a draft is the *precondition for replacing*, so
the page reads as a dead end to a manager who wants a different schedule. This
half is copy, not capability, and is the cheaper of the two to fix.

## Goals

1. A season that has not started can have its published schedule removed,
   leaving zero games.
2. The `published` state explains how to change the schedule.
3. Goal 4 of the previous spec — a played game is never deleted — is preserved
   *structurally*, not by adding a rule.

## Non-goals

- **Cancelling the remaining games of a started season.** Designed and
  deliberately not built; see §5, which records the design so it need not be
  re-derived.
- **Bulk restore.** Nothing here cancels in bulk, so nothing needs un-cancelling
  in bulk.
- **Deleting an individual published game.** Unchanged from the previous spec:
  `Cancel` and `Postpone` cover the real cases and are non-destructive.
- **Marking cancelled games in the calendar feeds.** Still open, still out of
  scope; see §5's note on what would tip it.

---

## 1. What the gate decides

`season_is_started` remains the single source of truth. Each operation on a
season's live schedule sits on exactly one side of it:

| Season state | Operation | Effect |
|---|---|---|
| Not started | **Replace** (exists) | delete live games, promote drafts, one transaction |
| Not started | **Remove** (new) | delete live games, season back to zero |
| Started | — | locked; individual games only, via Cancel / Postpone / Reschedule |

No operation exists on both sides, which is what keeps the rule sayable in one
sentence: *before the season starts you can delete; after it starts you can
only change games one at a time.*

## 2. `remove_published_schedule`

```sql
remove_published_schedule(p_season uuid) returns table (deleted int, refused text)
```

`refused` is `'started'`, `'no_games'`, or null on success — the same shape as
`replace_published_schedule`, so the action layer maps refusals the same way.

The body copies `replace_published_schedule`'s discipline exactly, and for the
same reason:

1. `pg_advisory_xact_lock` on the season.
2. `perform 1 from games where season_id = p_season and not is_draft for update;`
3. The `season_is_started` gate — refuse `'started'`.
4. Refuse `'no_games'` when nothing is live.
5. `delete from games where season_id = p_season and not is_draft`.

Step 2 is load-bearing and non-obvious. The gate and the delete are separate
statements, so under READ COMMITTED they see separate snapshots; without the
row locks a game finalized *between* them is deleted, because the gate reads
the pre-finalize snapshot and the delete then re-evaluates against the new row
version. This was reproduced against a database on the previous branch before
the lock was added. It is not redundant here just because the delete has no
promotion after it — the hazard is in the gate, not the promotion.

The insert-side residual carries over unchanged: `for update` cannot lock rows
that do not exist, so a played game *inserted* concurrently in the same window
would still be deleted. No current path does that.

Grants match the existing pair: revoked from `public`, `anon` and
`authenticated`, granted to `service_role` only. `CREATE FUNCTION` grants
EXECUTE to `PUBLIC` by default, so omitting a grant does not close this —
the revoke is required.

## 3. Actions and reads

`removeSchedule(prev, formData)` in `src/lib/actions/schedule.ts`, shaped like
`publishSchedule`: `requireManager`, resolve the season, call the RPC, map
`refused` to a message, audit, revalidate.

It reuses `revalidateAfterPublish` — the same five paths change, for the same
reason — including on refusal, since a refusal means the tab is already stale.

Audited unconditionally as `remove_schedule`. Unlike a first publish, every
successful removal destroys live games, so there is no cheap case to exempt.

**`getPublishState` is unchanged.** `liveCount`, `firstLiveDate`,
`lastLiveDate` and `lineupsAtRisk` already exist and are exactly what the
confirm dialog needs. No new read, and the existing fail-closed behaviour
covers the new control for free: on a read error the season reports `started`,
which suppresses removal along with everything else.

## 4. UI

**No new `publishMode` state, and no new predicate.** Removal is available in
exactly `published` and `replace` — both of which already mean *live games
exist and the season has not started*. `publishMode` stays at five states with
its tests untouched; the condition is `mode === "published" || mode === "replace"`.

The published-count line, currently rendered only in `published` mode, renders
in `replace` mode too. That gives the Remove control a consistent home and
closes a minor from the previous branch's review: in `replace` mode the button
label was the only on-page evidence that a live schedule existed at all.

**A separate component, not a mode on `PublishControls`.** `RemoveControls`
lives beside it in `src/components/manage/` and uses the same `dialog.tsx`
primitives. `PublishControls` already branches on `destructive` between two
quite different renders; a third path for an action that publishes nothing
would make one component answer two unrelated questions.

**It must carry a `key`, for the reason `PublishControls` does.** Copying that
component's derived `dialogOpen = open && !state?.ok` also copies its
precondition: `open` is never reset on success, so the component must unmount
afterwards or its trigger goes permanently inert. That holds here — a
successful removal drops `liveCount` to 0, which moves the season to `empty` or
`draft-only`, and this control renders in neither. Key it on `publish.liveCount`
anyway, so the guarantee is structural rather than a consequence of where the
mode boundaries happen to fall today. See the comment on `dialogOpen` in
`publish-controls.tsx`.

Confirm dialog, using the same `destructive` styling:

> **Remove the published schedule?**
> This deletes {liveCount} live games ({liveRange}) and leaves the season with
> no schedule. Team calendar feeds will empty.
> {lineupsAtRisk} lineup entries already set for those games will be deleted
> with them.

The third line appears only when `lineupsAtRisk > 0`, matching the replace
dialog. `liveRange` is formatted by the server panel with `formatLongDate` and
passed in — not formatted in the dialog — for the reason the replace dialog
does it: this is where a manager checks *which* schedule is about to go, and it
must not be the one screen in the app showing raw ISO dates.

**Discoverability.** In `published` mode, one line beneath the count:

> To change the schedule, generate a new one above — you'll be asked to confirm
> before it replaces this one.

This is the sentence whose absence made the page read as a dead end. It is
independent of the RPC and ships whether or not removal does.

## 5. Cancelling a started season's remaining games — designed, not built

Recorded so it is not re-derived from scratch.

**What it would do.** Flip every not-yet-played game to `cancelled`:

```sql
status = 'postponed' OR (status = 'scheduled' AND scheduled_at >= now())
```

Past games still sitting at `scheduled` are deliberately excluded: that state
means a scorekeeper is behind on entering results, not that the game did not
happen. `postponed` rows carry a NULL `scheduled_at` by design, so a date
comparison cannot reach them and they must be named explicitly. A `scheduled`
row with a NULL date is unreachable today — `postpone_game` sets both together
— and falls out of `>= now()` as NULL, which leaves it alone: the safe
direction.

**Why cancel rather than delete.** Cancelling keeps the rows, so played games
are untouched by construction rather than by a predicate that has to be right.
It is individually reversible through the existing `restoreGame`, standings
already filter on `status = 'final'` and so never counted these games, and
`game_rosters` survives — a restored game comes back with its lineup intact.

**Why it needs no `for update`.** Its work is a single `UPDATE`. When that
statement meets a row locked by a concurrent transaction, Postgres re-evaluates
the WHERE clause against the new row version once the lock releases, so a game
finalized mid-flight fails the predicate and is skipped. The replace path
needed explicit locks precisely because it was two statements. Copying the lock
here would be cargo-culting the shape of a fix without its reason.

**Why it is not built.** Schedule creation, editing and deletion happen before
a season begins. Mid-season change is individual games, and is itself rare. The
fallback if this does not exist is not "impossible" but "cancel them from the
score pages" — already possible, already non-destructive, already reversible.
A new RPC, gate direction, predicate and set of failure modes is permanent
surface area traded for tedium in a case that may never arise. It also keeps
goal 4 structural: nothing new deletes live games, so `EXPORTS_HANDOFF.md` §3
stays true as written.

**If it is ever built**, the frequency argument says it should be harder to
reach than replace, not easier: a collapsed disclosure rather than a button,
and a typed confirmation rather than a Cancel/Confirm pair.

**One consequence to weigh first.** `isExportableFixture` withholds cancelled
games from both `.ics` feeds, which `EXPORTS_HANDOFF.md` §3 records as a
deliberate choice of uniformity over emitting `STATUS:CANCELLED`, to revisit
"if subscribers complain that games disappear without explanation". A bulk
cancel turns that from a one-game annoyance into a season's worth of events
vanishing from every subscriber's calendar at once. Marking rather than
dropping should be settled before bulk cancel ships, not after.

## 6. Verification

**Unit.** No new pure logic, so no new unit tests. `publishMode`'s existing
tests continue to cover the states the new control keys off.

**e2e.** One new test against `Fall 2026`, the seeded season that has not
started: generate, publish, then remove — the season returns to zero games,
the panel falls back to the empty state, and the published count disappears.
The started-season lock is already covered by an existing test, and removal
being absent there follows from the same `mode === "locked"` gate.

**The gap, stated honestly.** There is no DB-level test harness in this repo,
so the SQL gate and the `for update` placement are not covered by any test —
deleting the lock line would leave every test green. Verified by hand against
the local database instead:

1. Open two `psql` sessions. In the first, `begin;` then
   `update games set status = 'final', home_goals = 3, away_goals = 1 where id = '<a live game in an unstarted season>';`
2. In the second, call `remove_published_schedule` on that season. It must
   block rather than return.
3. `commit;` the first session. The second must then return
   `refused = 'started'`, `deleted = 0`, and the game must still exist.

Without the `for update` line, step 2 returns immediately and step 3 leaves the
finalized game deleted. That difference is the whole point of the line.

## 7. Deployment

One migration adding one function. Additive — no schema change, no backfill,
nothing existing is altered. Safe to apply ahead of the code, which is the
correct order: an unapplied migration makes `getPublishState` fail closed and
locks the builder for every manager.

The hosted database is on `0026` as of this writing.
