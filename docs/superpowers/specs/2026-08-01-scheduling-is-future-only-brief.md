# Brief: scheduling concerns future games

**This is a problem brief, not a design.** No solution has been chosen. It exists
so a fresh session can pick up the design conversation without re-deriving what
is already settled — and without re-opening what was deliberately closed.

Written 2026-08-01, after `feat/one-published-schedule` (PR #8) shipped the
schedule replace/remove work and a reproduced defect exposed a gap in its model.

---

## 1. The defect that prompted this

**A past-dated draft locks a season permanently, and there is no way out through
the UI.**

`season_is_started` (migration `0026`) reads *published* games only:

```sql
scheduled_at < now() or status <> 'scheduled' or home_goals > 0 or away_goals > 0
```

A draft is invisible to it. So:

1. `schedule-generate-form.tsx:123` pre-fills "First game night" with the
   season's `starts_on` (`defaultValue={seasonStart ?? ""}`). A manager setting
   up a season whose start date has **already passed** gets a past-dated draft
   *by default*. The input has no `min`, and `generateSchedule` never validates
   the date.
2. The draft's games are in the past, but the season still reads "not started",
   because drafts don't count.
3. A season's *first* publish is one click with no confirm dialog — correctly,
   since it destroys nothing.
4. The instant those games go live, their past dates make the season "started".
5. `replace_published_schedule` refuses. `remove_published_schedule` refuses.
   The builder renders the locked card.
6. Cancelling every game does **not** help: `status <> 'scheduled'` satisfies the
   gate too.

The only escape is Reschedule, one game at a time, from each game's score page.
For a 172-game season that is 172 operations.

**All six steps were reproduced against the local database**, including the
cancel-doesn't-help step. This is not theoretical, and production has no
protection against it today.

## 2. Why the obvious fixes are wrong

**"Let Remove work on a started season as long as nothing has been played."**
This is the trap. `season_is_started` counts a past date deliberately, and
`0026`'s own comment says why:

> `scheduled_at < now()` — a night has passed. **The load-bearing one:** a game
> played last night that nobody has scored yet is still a played game.

A game played last night and not yet entered has `status = 'scheduled'`, `0-0`,
and a past date — indistinguishable by status or score from an untouched
fixture. Loosening the gate to ignore past dates would delete games that really
were played. That is the data loss the whole feature exists to prevent.

**Input validation alone** (a `min` on the date field, or rejecting a past
`start_date` in `generateSchedule`) prevents the *mistake* but does nothing for
a season already in the locked state, and does not address the underlying model.

## 3. The reframing to design around

From the user, and it is the reason this brief exists rather than a patch:

> If games have been played then those games do not need to be scheduled as they
> already exist, and so only games in the future will require scheduling.

**Scheduling is inherently about the future.** A played game is a *record*, not a
fixture awaiting scheduling. Played games are therefore not excluded from a
scheduling operation by a *rule* — they are outside its scope *by definition*.

This dissolves the trap in §2 rather than working around it. Under this framing
nothing ever has to ask "was this played?": a played game is necessarily in the
past, so a future-scoped operation cannot reach it. That covers the scored case
**and** the played-but-unentered case with the same test, which is exactly what
status and score could not do.

The candidate scope for "what a scheduling operation may touch":

```sql
scheduled_at >= now() AND status = 'scheduled' AND home_goals = 0 AND away_goals = 0
```

Future, and untouched. The status and score clauses remain only to catch a game
finalized early with a future date — not to detect "played".

Consequences worth designing against:

- The current gate is blunter than the principle. It says *one* played game
  freezes the entire season, including games months away. The principle says
  played games drop out of scope and the rest stay schedulable.
- The past-dated lockout dissolves: such a schedule would simply have nothing in
  scope, rather than locking the season forever.

## 4. The cost split — this is the key design tension

The principle is **cheap for removal** and **expensive for replacement**:

| | Cost |
|---|---|
| **Remove** the remaining schedule | Delete future untouched games, leave history alone. No generator involvement. |
| **Replace** — regenerate the remaining season | The thing the original spec rejected. The generator would need seeding with games-played and home/away already accrued, or the back half will not balance against the front. |

Same principle, very different price. A design that takes the cheap half and
defers the expensive half is legitimate and should be considered explicitly.

## 5. Settled — do not re-litigate

These were decided with the user across two design conversations. Reopening them
without new information wastes the session.

- **Publishing replaces rather than stacking.** Shipped.
- **A started season cannot have its full schedule replaced.** Shipped. The
  question here is what "started" should *mean* and what it should gate, not
  whether the gate exists.
- **No bulk cancel of a started season's remaining games.** Designed in detail
  and deliberately cut on frequency grounds —
  `2026-07-30-remove-published-schedule-design.md` §5 carries the predicate, the
  cancel-over-delete reasoning, and the single-statement concurrency argument.
  **Note:** that section's predicate is close to §3's here. If this design lands,
  §5 should be revisited as *implementation* of a now-accepted principle, not as
  a rejected feature.
- **Removal is offered in `published` mode only, not `replace`.** A draft
  survives a removal, so the dialog's wording would be false in replace mode.
- **The remove dialog is deliberately short.** No game count, no calendar
  warning — a pre-start removal destroys nothing unrecoverable except captains'
  lineups, which is the only thing it mentions.

## 6. State of the code

**Branch `feat/one-published-schedule` / PR #8**, 29 commits, not yet merged.
Unit 177/177, e2e 66 passed / 1 skipped / 0 failed.

Migrations — **`0026`, `0027` and `0028` are all applied to production**:

| | |
|---|---|
| `0026` | `season_is_started`, `replace_published_schedule` |
| `0027` | `remove_published_schedule` |
| `0028` | fixes a TOCTOU in `0026` — see below |

`0028` exists because `0026`'s `no_draft` guard read draft rows that nothing
locked. Reproduced: the call returned `deleted=4, published=0, refused=null`,
left the season with **zero games**, and was reported to the manager as a
success. `0028` widens the lock to every game in the season. **Both `for update`
lines are load-bearing and verified in both directions — do not remove them.**

Relevant files:

| | |
|---|---|
| `supabase/migrations/0026..0028` | the gate and the two operations |
| `src/lib/queries/schedule.ts` | `getPublishState`, fail-closed on any read error |
| `src/lib/schedule/publishMode.ts` | the builder's five modes; `started` outranks all |
| `src/lib/actions/schedule.ts` | `generateSchedule`, `publishSchedule`, `removeSchedule` |
| `src/components/manage/schedule-builder-panel.tsx` | the panel and its mode gates |
| `EXPORTS_HANDOFF.md` §3 | why the locks make the played-game guarantee true |

## 7. A process note worth carrying

The `0028` TOCTOU was in code the authoring agent reviewed **twice** and passed
both times — including once *after* reproducing a different race in the same
function. A fresh-context reviewer found it in a single pass, and reproduced it.

For concurrency-sensitive SQL in this area, reasoning and self-review are not
sufficient. Reproduce races with two `psql` sessions, and get a reviewer that has
not seen the authoring reasoning.

## 8. Suggested opening move

Start with `superpowers:brainstorming`. The first question worth asking the user
is whether this should change what `season_is_started` *means*, or leave that
function alone and instead scope each operation to future games — those are
different blast radii, and the second is far more contained.
