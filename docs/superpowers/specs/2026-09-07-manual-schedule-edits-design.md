# Manual schedule edits — trades, not reassignments

**Date:** 2026-09-07 · **Status:** design, approved in chat, not yet built
**Decided by:** the user, 2026-09-07, over the course of one session.

## The problem, in the user's words

Two things were asked for, in this order:

1. Beyond moving a whole game night, a manager must be able to **move an
   individual game** and **change the teams in a game** — on drafts *and* on
   published schedules.
2. Those edits must be possible **without running a repair**. "If two teams
   agree to switch times/games then they can also agree that the schedule then
   doesn't completely rebalance."

And one constraint that reshaped both:

> **Total games played and games per night are non-negotiable. Those numbers
> always have to be even.**

⛔ **"Even" here means EQUAL, not divisible by two.** Every team finishes with
the same number of games; every game night carries the same number of games.
Confirmed with the user before designing. Everything below follows from it.

⚠️ **What is actually enforced is PRESERVATION, not global equality — and the
difference matters.** A season can legitimately hold a night with fewer games
than the others (a short final week, a rink that only gave up two sheets that
Tuesday). An edit must not be blamed for an imbalance the generator or the
manager already chose. So the rule each operation enforces is:

> **After the edit, every team's total and every night's game count are exactly
> what they were before it.**

That is strictly checkable, needs no opinion about what the schedule *should*
look like, and delivers the user's requirement — the two numbers can never drift
through manual editing. A global-equality check would instead refuse edits on any
season that was already uneven for a legitimate reason, which is a different and
wrong behaviour.

**These invariants apply to drafts exactly as they do to published games.** A
draft is a schedule waiting to be published; letting it drift unbalanced would
just move the problem to publish time.

## What the constraint implies, and why it shrank the feature

The invariant quietly decides the shape of every operation:

| Naive operation | What it does to the invariant |
| --- | --- |
| Replace team B with team C in one game | ⛔ B ends one game short, C one long, permanently |
| Move one game to another date | ⛔ the night it leaves loses a game; the night it joins gains one |
| Trade a participant between two games | ✅ all four totals unchanged |
| Trade the dates of two games | ✅ both nights keep their count |

**So every permitted edit is a trade.** That is not a restriction imposed on the
user's request — it is the user's own constraint, followed to its conclusion, and
it happens to match the case they described: two teams *agreeing to switch* is a
trade, not a reassignment.

⚠️ This is why "repair" is not involved. A repair re-optimises the whole
schedule against its goals; these operations preserve the two hard counts by
construction and leave every soft goal (bye spacing, weekday balance, ice-time
share) exactly as the manager left it. **Making a schedule worse by these
measures is an allowed outcome** — the manager and two captains have agreed to
it, and the app's job is to keep the two non-negotiable numbers true, not to
re-impose its own preferences.

## The primitives

Three, and only three. Both features the user asked for compile down to them.

### `exchangeTeams(gameX, teamLeavingX, gameY, teamLeavingY)`

Two rows written. The named participant of each game moves to the other. Four
teams' totals are unchanged; no `scheduled_at` moves.

This is the write behind **both** "two teams agreed to switch" **and** "replace a
team" — see the wizard below.

### `exchangeSlots(gameX, gameY)`

Two rows written. The two games trade `scheduled_at` entirely. Games-per-night
is preserved on both nights by construction, which a free-form move cannot be.

### `retimeGame(game, newTime)`

One row. **Same night only** — 19:00 → 20:15. Changes no count, so it needs no
partner and no compensating edit.

⚠️ A date change is never this operation. Moving a game to a different night is
`exchangeSlots` with a game already on that night, or it is refused.

## "Replace a team" is a wizard over `exchangeTeams`

The user chose *guide to a compensating edit* over refusing outright or warning
and allowing. So the surface reads as a replacement and the write is a trade:

1. In game X, the manager picks the team leaving (B) and the team arriving (C).
2. The app lists every game containing C where B could take C's place without
   breaking a guard, ranked by nearest date.
3. The manager picks one. Both rows are written as a single `exchangeTeams`.

⛔ **If step 2 finds no candidate, the action is refused with that reason**, not
completed as an unbalanced single-row write. A schedule the UI can produce is
always a schedule with both counts intact.

## Guards

Refuse when any of these hold, naming which one in the message:

- **Either game holds goals.**
- **Either game's status is `final`.** ⚠️ Not redundant with the goals check: a
  0–0 final has no goals and is still a played game. The user's stated rule was
  "only refuse when goals exist"; this spec deliberately goes one step stricter,
  and the user was told so.
- **A team would face itself.**
- **A team would play twice on the same night.** ⚠️ **AN ASSUMPTION, NOT A
  DECISION** — the user was asked and did not answer. It is safe here because
  the generator cannot produce a doubleheader (two ice slots means four of six
  teams play and two sit), so one could only arrive by mistake. If the league
  ever wants doubleheaders, this is a single predicate to drop.

⛔ **SCHEDULED ONLY — THIS SPEC WAS WRONG, AND THE BUILD PROVED IT.** It said
postponed and cancelled games remain editable, which was the user's explicit
choice on the grounds that neither carries a result. The code was written that
way and could never work: `applyGameWrites`'s pre-flight (`gameWrites.ts:246`)
refuses any row whose status is not `scheduled` BEFORE the widened set is
consulted. A cancelled game keeps its date, so it reached the picker and then
failed with "The schedule changed while this was on screen" — permanently, and
for a reason the message never gave. Found in review 2026-09-07, not by a test.

The guard now refuses what the write path refuses, and the picker offers only
`scheduled` games. ⚠️ **Widening is deferred to the schedule-write RPC**, which
rewrites that pre-flight — doing it here first means writing it twice. Decided
with the user 2026-09-07; see
`docs/superpowers/plans/2026-09-06-schedule-write-rpc.md`.

⚠️ **The guards apply to every primitive, including `exchangeSlots`.** Trading
dates can put a team on a night it already plays, so the doubleheader and
self-play checks are evaluated against the *post-edit* state of both rows, not
against the operation's name. A guard list that only ran for `exchangeTeams`
would let the same illegal state in through the other door.

⛔ **The season lock does NOT apply to any of these.** `season_is_started`
governs generate / replace / remove — wholesale operations. These three are the
in-season tools, and gating them on the lock would recreate the exact problem
this work exists to fix.

## Where it lives — the IA change

The user's observation, which upgraded this from bounded to architectural:

> "if changes can take place after a season is published I'm not sure it makes
> sense for it to be hidden in the 'Schedule Builder' tab"

Correct: repair, night moves, one-off games and now these three primitives are
all *in-season* work, and they are the only things still available once the
builder locks itself. The permanently-available tools were inside the page that
permanently disables itself.

**Chosen: approach B — fold in-season editing into Games.**

- `/schedule` ("Games" in `staff-links.tsx`) becomes where a live schedule is
  changed: per-row edit for replace-team and retime, page-level pickers for the
  two exchanges.
- `/schedule-builder` keeps generate / review / publish only, and its lock
  becomes honest.
- ✅ **No route renames, so no new entries in `next.config.ts`.** Both routes
  already exist; only nav labels and component placement move.

**Rejected:**

- **A — rename in place.** Relabel the builder to "Schedule" and promote the
  in-season tools within it. Cheapest, but the tools still live at a URL named
  "builder" and the page still does two unrelated jobs. Renames the symptom.
- **C — one "Schedule" section with sub-nav.** Tabs over Games / Repair /
  One-off / Build. Cleanest conceptually, and the likely eventual shape — but it
  is a route restructure with three redirects and `27-one-chrome`'s assertions
  to rewrite, proposed three days before a one-way-door deadline. Deferred, not
  dismissed.

⚠️ **The one cost of B:** drafts live in the builder's preview, so the edit
components must render in both places. They are the same components with a
different row source (`is_draft = true`), not two implementations.

## Write path, and the exposure that stays open

All three primitives go through `applyGameWrites` (`src/lib/schedule/gameWrites.ts`
§2) as a batch — two rows for the exchanges, one for a retime. That path already
writes exactly the columns needed: `home_team_id`, `away_team_id`, `scheduled_at`,
`label`. `prev`/`next` must name the same columns, and `expectScheduledAt` closes
the read→write window.

⛔ **THERE IS NO TRANSACTION, AND THIS DESIGN DOES NOT ADD ONE.** The path is
compensation-only: a runtime dying mid-batch leaves one row written and
uncompensated, publicly visible. For a two-row exchange the visible result is a
game with a duplicated team and another with a missing one.

**The user was told this twice and chose to proceed anyway**, in order to have
both features before the 2026-09-10 schedule rebuild. Recorded here so the
deferred `pg_advisory_xact_lock` RPC — already the decided first post-launch job
— knows exactly what it is closing: these three primitives are its first
customers, and the exchanges are the reason it matters.

## Audit

Every primitive writes an audit entry. ⛔ **File it under an `entity_type`
`leagueOfEntity` handles** (`src/lib/audit.ts`): an unhandled type resolves to a
null league, and a null-league entry is hidden by RLS *and* filtered out of every
league-scoped view — written correctly and invisible everywhere. Entries name the
season, not the game rows, since a game may later be removed.

## Testing

- **Unit:** the invariant calculator (games-per-team, games-per-night) and the
  candidate finder behind the replace wizard, including the no-candidate case.
- **e2e:** one spec covering each primitive on a published season, plus a refusal
  for each guard, plus the draft-over-published state that hid the scoping bug.
  ⚠️ **NOT covered, and this spec claimed otherwise:** editing a DRAFT row itself
  through the builder's panel. The components render there and the actions are
  scoped for it, but no test drives it — the draft test exercises a published
  edit while a draft is staged, which is the state that broke, not the same
  thing. Worth closing. Follows the house pattern — the read-failed
  guard is copied in, not imported (relative TS imports do not load; measured
  2026-09-06).
- ⚠️ **Seed dates must be computed, not pinned.** `11-` and `23-` hardcode
  `2026-09-15` and break from 2026-09-16; a new spec must not inherit that bug.

## Success criteria

1. Two teams can trade games, and two games can trade slots, in one action each.
2. "Replace a team" is reachable, reads as a replacement, and cannot produce an
   unbalanced schedule.
3. Games-per-team and games-per-night are identical before and after every
   permitted edit — asserted, not assumed.
4. Every refusal names which rule it broke.
5. The in-season tools are reachable without visiting the Schedule Builder.
