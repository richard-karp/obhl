# Scheduling concerns the future

Design for the reframing in `2026-08-01-scheduling-is-future-only-brief.md`.
That brief states the defect and the settled ground; this document decides what
to build. It covers the model, the database operations, the gates and the
builder UI.

**It deliberately excludes seeding the generator from played games.** That is
section 9, and it gets its own spec — it is the larger half and it reaches into
the three phase files `SCHEDULE_HANDOFF.md` governs. Both are built before the
feature is announced. Neither ships alone.

## 1. Problem

A past-dated draft locks a season permanently. The brief's §1 carries the full
six-step reproduction; the shape is that `season_is_started` counts a past date
as "played" — correctly, since a game played last night that nobody has scored
yet is indistinguishable from an untouched fixture — but reads *published* games
only. So a draft dated in the past is invisible to the gate right up until the
moment it is published, at which point the season is instantly and permanently
started. Replace refuses, remove refuses, and the builder renders a locked card.

The manager gets there by accepting a pre-filled default:
`schedule-generate-form.tsx` fills "First game night" with the season's
`starts_on`, the input has no `min`, and `generateSchedule` never validates it.
Setting up a season whose start date has already passed produces a past-dated
draft without the manager doing anything unusual.

**One correction to the brief.** Its §1 says the only escape is 172 Reschedule
operations. It is one Reschedule per *past-dated* game, not per game: move those
forward and `season_is_started` reads false again, unlocking replace and remove
for the whole season. On a season set up two weeks late that is a dozen or so
games. Tedious rather than impossible — which lowers the urgency but not the
argument, since the count scales with how late setup happens, and the escape
evaporates the moment a real game is played.

## 2. The principle

From the user, and it is what this design is organised around:

> If games have been played then those games do not need to be scheduled as they
> already exist, and so only games in the future will require scheduling.

A played game is a record, not a fixture. It is not excluded from a scheduling
operation by a rule — it is outside the operation's scope by definition. Nothing
in this design ever asks "was this played?", which is the question §2 of the
brief shows cannot be answered from status or score.

The principle cuts both ways, and the second direction is easy to lose. If a
past game counts as played for the purpose of protecting it, it counts as played
everywhere: what it consumed — a night, an ice slot, a home date, an opponent —
is real and carries into planning the rest of the season. A design that protects
past rows while treating them as fiction when convenient has quietly
reintroduced the distinction it just declared unmakeable. Section 9 is that
obligation, and it is why this work is two specs rather than one.

## 3. The three sets

One predicate, defined once in SQL. Every **live** game falls in exactly one of
three sets — no overlaps, no gaps, so nothing is double-counted and nothing is
stranded.

| Set | Definition | Treatment |
|---|---|---|
| **Schedulable** | the predicate below | removed, replaced, replanned |
| **History** | live ∧ ¬schedulable ∧ `status <> 'cancelled'` | never touched; seeds the generator (§9) |
| **Cancelled** | `status = 'cancelled'` | never touched; not counted as played |

```sql
-- A game a scheduling operation may touch.
status = 'postponed'                       -- awaiting rescheduling; no date to test
or (status = 'scheduled'
    and home_goals = 0 and away_goals = 0
    and scheduled_at >= now())             -- future, and untouched
```

`game_status` is `('scheduled', 'in_progress', 'final', 'postponed',
'cancelled')`. Only `scheduled` and `postponed` can be schedulable, so
`in_progress` and `final` fall to history without needing to be named.

**Why the status and score clauses survive.** They are no longer how "played" is
detected — the date does that. They catch a game finalised early while still
carrying a future date, which the date test alone would hand to the delete.

**Why postponed games are in scope, and named explicitly.** A postponed game
carries `scheduled_at = NULL` and `status = 'postponed'` (migration `0025`), so
it is neither past nor future and the "a played game is necessarily in the past"
reasoning does not reach it. It has to be decided, not derived.

It is in scope. A postponed game was by definition not played — `postpone_game`
moves a fixture out of the calendar precisely because it did not happen — and a
fixture awaiting rescheduling is the most in-scope thing there is. This also
matches `2026-07-30-remove-published-schedule-design.md` §5, whose bulk-cancel
predicate names `status = 'postponed'` for the same reason, and it preserves two
shipped behaviours the alternative would break: removing a published schedule
still empties an unstarted season, and a replace leaves no postponed orphans
sitting beside the schedule that replaced them.

The brief's §3 candidate predicate excludes them. That was an oversight of the
NULL, not a decision, and this supersedes it.

**Why cancelled games are split out of history.** A cancelled game did not
happen. Folding it into history would make it seed the generator (§9) as a game
played, and a team would be compensated for a game nobody played.

**`now()` is transaction-scoped, and that is load-bearing.** In plpgsql `now()`
is `transaction_timestamp()` — fixed for the whole transaction. The set used for
the row lock, the count, the delete and the returned numbers is therefore
provably the same set. `statement_timestamp()` here would reintroduce exactly
the split-snapshot class of bug that `0028` exists to close, and it would do so
invisibly, because the two evaluations would agree in every test that runs
faster than a clock tick.

## 4. Data layer — migration `0029`

### What must not change

Both RPCs keep their `pg_advisory_xact_lock` and both keep

```sql
perform 1 from games where season_id = p_season for update;
```

**unchanged, covering every game in the season.** The brief is right that these
are load-bearing, and this design makes them more so rather than less: with
every row locked before the predicate is evaluated, the schedulable set cannot
move underneath the delete that acts on it. `0026`'s and `0028`'s header
comments carry the two reproductions and stay accurate.

`0028`'s `published = 0` raise is kept verbatim.

### `remove_published_schedule`

Drops the `season_is_started` gate. Scopes its delete to the schedulable set.
Returns `(deleted, kept, refused)`.

`kept` is every live game left behind — **history *and* cancelled**, since what
it answers is "how many games are still there". That makes it the wrong number
to label "already played": §6's copy draws on `playedCount` for that, and a
cancelled game must never be described as played.

`refused = 'no_games'` becomes `refused = 'nothing_to_remove'`, raised when the
schedulable set is empty — which is now the honest statement of the condition. A
season with nothing left to schedule refuses because there is nothing to do, not
because it is forbidden.

### `replace_published_schedule`

Drops the `season_is_started` gate. Scopes its delete to the schedulable set.
Returns `(deleted, kept, published, refused)`. Keeps `no_draft`.

Gains one refusal:

- **`past_draft`** — refuse the whole call if any draft game is not itself
  schedulable. Drafts are always `status = 'scheduled'` at `0-0` (nothing in the
  app postpones, finalises or scores a draft), so in practice this reduces to
  `scheduled_at >= now()`. It is written as the full predicate anyway, so the
  guard cannot quietly become wrong if that ever stops being true.

That is the backstop that makes the original defect unreachable rather than
merely unlikely. `generateSchedule` will not build a past-dated draft (§5), but
a stale tab, a clock skew, or a draft that sat unpublished across its own start
date can all present one. Refusing the whole call rather than promoting the
schedulable subset matters: a partial promotion would publish a schedule with
holes in it and report success.

### `season_is_started`

Stays in the database. Gates nothing, and — once §5's `playedCount` lands — is
read by nothing: "the season is under way" is `playedCount > 0`, which says it
better and comes from the same snapshot as every other number on the screen.

It is kept anyway, because `0026` and `0027` are applied to production and a
rollback to their code has to find the function still there. Its comment is
rewritten to say exactly that, so the next reader is not left inferring a live
gate from a function nothing calls. Dropping it belongs in a later migration,
once no deployed code path can want it.

## 5. App layer

### `getPublishState` (`src/lib/queries/schedule.ts`)

`liveCount` splits in two:

- `remainingCount` — the schedulable set. What a replace or remove would delete.
- `playedCount` — history. What survives *and* counts as played.

Cancelled games are in neither, on purpose: they were not played and they will
not be rescheduled. The two numbers therefore do not sum to the season's live
game count, and §6's copy must not imply they do.

`firstLiveDate` / `lastLiveDate` become the range of the **schedulable** set,
since their only consumer is the confirm dialog describing what is about to be
deleted. A range that spans games the operation will not touch is a false
statement on the one screen in this app that destroys data.

**`lineupsAtRisk` must be rescoped to rosters on schedulable games.** Left
counting every live game's rosters it overstates the damage — and it does so in
the direction that erodes trust in the warning, which is the direction that
eventually gets it ignored.

The fail-closed contract is unchanged and still covers every read: any error
locks the builder rather than producing a confident number from a partial read.
The reasoning in the existing comment holds as written.

### `publishMode` (`src/lib/schedule/publishMode.ts`)

Same five modes, same shape, two inputs renamed:

```ts
publishMode({ remainingCount, draftCount, readFailed })
```

`readFailed` replaces `started`, and `locked` now means only "this season's
games could not be read". The `started` outranks-everything comment goes with
it.

A mid-season season whose remainder has been removed lands in `draft-only`, and
that is correct rather than a leak: nothing is in scope, so publishing destroys
nothing, so it stays one click with no confirm — the same reasoning that made a
first publish one click.

### `generateSchedule` (`src/lib/actions/schedule.ts`)

Drops the `season_is_started` early return, including its fail-closed handling —
there is no longer a gate to fail closed on.

Prevention, in three layers:

1. The form's date input gets `min`, and its default becomes
   `max(seasonStart, today)` rather than `seasonStart`. This is what the manager
   actually sees, and it is what stops the defect being reachable by accident.
2. The server **clamps** a past `start_date` to today (league-local, via
   `leagueDateKey`) before it reaches `enumerateNights`, which then finds the
   first night from there matching the chosen weekdays and skip dates. Clamping
   the date rather than searching for a night keeps the change to one
   expression and leaves night selection where it already lives.
   `generateSchedule` returns void and its six
   existing guards all fail silently; adding a seventh silent return would give
   the manager a form that appears to do nothing. Clamping is also the forgiving
   reading of the principle — you asked for the past, the past is not
   schedulable, here is the earliest thing that is.
3. `past_draft` in §4 is the guarantee. Layers 1 and 2 are ergonomics.

## 6. UI (`schedule-builder-panel.tsx`)

The locked card stops being the mid-season experience. It survives only for the
read-failure case, whose copy is already written for exactly that.

In its place, the builder states the split above the generate form:

> 18 games played · 154 remaining

and the confirm dialogs name what is kept, not only what goes:

> Removes the 154 remaining games and 41 lineups. Keeps the 18 already played.

Postponed games are counted separately in that copy. They are in scope and will
be deleted, but they carry no date, so a date range silently omits them — the
one case where the range and the count disagree.

The `RemoveControls` placement rule from
`2026-07-30-remove-published-schedule-design.md` is unchanged: offered in
`published` mode only, not `replace`. The reasoning there — a draft survives a
removal, so the dialog's wording would be false in replace mode — is unaffected
by this design.

**The numbers on screen are an estimate; the numbers in the toast are the
truth.** The panel renders outside a transaction, so a game can tick from
schedulable to history between render and click, and the RPC will then keep one
more game than the page promised. The RPC returns its actual counts and the
toast reports those. This is already how the shipped code behaves; it is written
down here because the future-only model makes the drift routine rather than
exotic.

## 7. What this does not do

- **Nothing reaches a past game.** The elapsed rows in an already-stuck season
  stay. The manager cancels or reschedules them from the score pages — a
  handful of operations, against a defect that currently has no bounded escape
  at all. Making recovery clear them too would need something that reaches into
  the past, which is the trap the whole design exists to avoid.
- **No bulk cancel.** `2026-07-30-remove-published-schedule-design.md` §5 stays
  cut on frequency grounds. Its predicate is close to §3's here, and if it is
  ever built it should be built as an implementation of this principle. Its
  warning about `.ics` subscribers losing a season of events at once still needs
  settling first.
- **No generator seeding.** Section 9.

## 8. Alternatives rejected

**Loosen `season_is_started` to ignore past dates.** The trap the brief names.
It deletes games that really were played, which is the data loss the feature
exists to prevent.

**Input validation alone.** Prevents the mistake, does nothing for a season
already locked, and leaves the model untouched. It is layer 1 of §5 here, not a
design.

**Future-scope `remove` only, defer the rest.** The cheap half of the brief's
§4 cost split. It does not unstick the season: after removing the future games,
`generateSchedule` still consults `season_is_started` and still returns early,
so the manager is left holding the past rows with no way to refill the season.
The hand-rescheduling remains the actual fix, which makes the new operation
close to ornamental. It also needs `RemoveControls` surfaced inside the locked
card — a button offered on the one screen whose entire message is that nothing
here can be changed.

**Keep `locked`, add a separate mid-season "replace the remaining schedule"
path.** Preserves the shipped guarantee by leaving it alone, and follows §5's
preference for making mid-season bulk operations harder to reach. Rejected
because the guarantee does not need protecting: under future-only scoping, "a
started season cannot have its full schedule replaced" is true *by
construction*, since a started season's full schedule includes past games and
those are out of scope. Two RPCs and two mental models buy UI emphasis that the
confirm dialog already provides.

**Redefine `season_is_started` to mean "nothing left to schedule".** Smallest
diff at the call sites, but it leaves a function whose name, comment and
migration history all describe a different idea than its behaviour — in the one
area of this codebase where the comments are the documentation.

## 9. The second spec — seeding the generator

Recorded here so the obligation is not lost, and so the first spec's shape is
readable as deliberate rather than partial.

History (§3) feeds the generator as a per-team starting offset plus a short
lookback across the boundary:

| Phase | Seeded with |
|---|---|
| `roundRobin.ts` | per-team games played and home/away, so the multiset targets **season** totals |
| **P** `participation.ts` | per-team weekday counts; which of the last two weeks each team byed, and on which weekday |
| **M** `matchups.ts` | pairwise meeting counts; how recently each pair last met |
| **S** `slots.ts` | per-team ice-slot counts; each team's last slot before the boundary |

P, M and S are counter offsets. Those phases already optimise these dimensions,
so a starting value moves the target rather than changing the algorithm.

`roundRobin.ts` is the real work. `buildBalancedPairings` is the circle method,
where one round gives every team exactly one game, so games-played equality is
structural rather than optimised — as `SCHEDULE_HANDOFF.md` §3 says outright. An
elapsed front half almost never leaves teams level: three nights of 8 teams on 3
ice slots lands two teams on 3 games and six on 2. Levelling *season* totals
therefore needs a multiset with unequal per-team degrees, which the circle
method cannot express. A degree-constrained construction replaces it for the
seeded path.

**Decided:** regenerating levels season totals, not the remaining window. Given
two teams on 3 and six on 2 against a 36-game target, the new draft is 33 and 34
— every team finishes on exactly 36 — rather than 34 each, which would leave two
teams playing a season-long extra game that never self-corrects.

Phase M owns rematch spacing, so the pairing multiset only has to be the right
multiset; its ordering is not load-bearing.

**Invariant to test explicitly:** with no history, the generator's output is
identical to today's. That keeps `SCHEDULE_HANDOFF.md` §4's measured results
valid rather than something to re-establish from scratch.

## 10. Verification

Unit and e2e as usual, plus two things this area has earned:

**Reproduce the races with two `psql` sessions.** The brief's §7 is the reason:
the `0028` TOCTOU sat in code the authoring agent reviewed twice and passed both
times, including once after reproducing a different race in the same function.
Reasoning is not evidence here. Both directions — with the lock and without —
for every guard this migration adds.

**Get a fresh-context reviewer on the migration.** One that has not seen the
authoring reasoning. `0028` was found that way, in a single pass.

Cases the tests must cover:

- The brief's six-step reproduction, end to end, now recovering.
- A postponed game is deleted by both remove and replace.
- A cancelled game survives both, and does not count as played.
- A game finalised early with a future date survives both.
- `past_draft` refuses and rolls back rather than promoting a subset.
- A season with nothing schedulable refuses with `nothing_to_remove`.
- `lineupsAtRisk` counts only rosters on schedulable games.
- An unstarted season behaves exactly as it does today — same counts, same
  dialogs, same one-click first publish.

## 11. Consequences for the handoffs

`EXPORTS_HANDOFF.md` §3 records that the row locks make the played-game
guarantee true. That guarantee now rests on scope rather than on the gate, and
the section needs rewriting to say so — the locks are still load-bearing, but
what they protect is the stability of the schedulable set, not the correctness
of a started check.

`SCHEDULE_HANDOFF.md` gains nothing from this spec and everything from the
second one.
