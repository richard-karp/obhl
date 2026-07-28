# Mid-season one-off games, with matchup repair

## Problem

The schedule builder has a card titled "Schedule a one-off game (tournament final
/ semifinals)" (`src/components/manage/schedule-builder-panel.tsx:175`). It is in
the wrong place and does the wrong thing.

**Wrong place.** The builder page is a pre-season workflow: generate a draft,
review the balance report, publish. The one-off card is not part of that. Its
action, `scheduleSpecialGame` (`src/lib/actions/schedule.ts:207`), writes
`is_draft`-unset rows — published games — straight into a live season. It is a
mid-season operation parked in a pre-season screen, and it sits between the
generator and the draft preview where it interrupts the flow it isn't part of.

**Wrong thing.** It inserts games *on top of* the schedule and makes no attempt
to repair what that breaks. Its own docstring says so: "Added on top of the
schedule — the rest of the season isn't regenerated." The generator spends real
effort (`SCHEDULE_HANDOFF.md`) landing perfect weekday balance, zero bye-rule
violations, zero rematch-spacing violations and an even ice-time share. A
one-off inserted this way walks straight through all of it: the two chosen teams
gain a game nobody else got, and if "Also schedule the other teams that night" is
ticked, an entire extra night's worth of games appears with its own weekday and
ice-time consequences.

## Goals

1. Move the one-off flow out of the schedule builder and onto its own mid-season
   page.
2. Make a one-off structurally incapable of disturbing games-played, byes, or
   weekday balance.
3. Repair what it does disturb — pair-meeting counts, per-team ice-time share and
   the home/away split — by adjusting later games in the season, and let the
   manager choose how.

## Non-goals

- Regenerating the season. Nothing in this design re-runs the full generator.
- Moving any game to a different **date**. Ice times do permute within a night,
  which is how goal 3 restores ice-time share.
- Changing which teams are idle on any night.
- Playoff bracket management. This is for one-off labelled games inside a season
  (an in-season tournament final, semifinals), which continue to count toward
  standings — `game_type` stays `regular`, the `label` column carries the name.

---

## 1. The invariant

**A one-off never creates a night.** It lands on a night already in the published
schedule and takes over one of that night's games.

That single decision freezes participation: the same teams play, the same teams
are idle, the same number of games run, on the same ice times. Every balance
property that is a function of the participation matrix alone therefore cannot
move, and needs no repair:

| Preserved exactly | Why it can't drift |
|---|---|
| Games per team | Every team playing that night still plays exactly one game |
| Byes, and all three bye rules | The set of idle teams per night is untouched |
| Weekday balance | A team's games on a weekday = that weekday's nights − its byes there; neither changes |

The rest is disturbed and must be actively repaired. A night scheduled as
A–B / C–D / E–F, forced to carry B–D, leaves {A, C, E, F} to be re-paired — and
re-pairing a night changes more than who faces whom:

| Disturbed | Why | Repaired by |
|---|---|---|
| Pair-meeting counts | B–D gains a meeting; A–B and C–D each lose one | Phase M (`assignMatchups`) |
| Per-team ice-time share | The night keeps its slots, but *which team occupies which slot* moves with the pairings | Phase S (`assignSlots`) |
| Home/away split | A pairing is unordered — someone has to be home | A new orientation pass |
| Rematch spacing | Follows from the new pairings | Folded into Phase M's cost |

**Do not overstate the first table.** "The night runs the same games on the same
slots" is true of the *night* and false of the *teams*: a team can move from the
19:00 slot to the 21:30 one without its calendar changing at all. Ice-time share
is a season-long per-team total, so restoring it needs nights beyond the one that
broke it — which is why the repair below runs all three phases, not just Phase M.

## 2. The target

"The desired schedule balance" needs a precise definition to repair against. It
is **the schedule as currently published** — its pair-meeting counts, its
per-team ice-time share, and its home/away split — all read off the games table
immediately before the edit.

Nothing needs to be stored for this. The published schedule is the manager's
declared intent; the repair's job is to end the season where it would have ended.

Constraint satisfaction is primary. Churn — how many games the repair disturbs —
is a **tiebreaker** among solutions that satisfy the constraints equally well,
never a reason to leave a constraint unrepaired.

## 3. The repair

### 3.1 Reuse `assignMatchups`

`assignMatchups` (`src/lib/schedule/matchups.ts:100`) already solves exactly this
shape. Phase M of the generator takes participation as fixed, enumerates each
night's perfect matchings, and searches for the assignment that hits per-pair
meeting targets while minimising rematch spacing. Meeting-count error is weighted
at `MULT_W = 50_000` against spacing terms, so targets are effectively hard
constraints — which is what we want here.

The repair is that search, run over the remaining season with some nights pinned.

### 3.2 The one extension: per-night constraints

Add an optional `nightConstraints` to `MatchupOptions`:

```ts
/** Per night: pin it to one matching, or require a pair to appear in it. */
type NightConstraint =
  | { kind: "fixed"; pairs: [number, number][] }
  | { kind: "require"; pairs: [number, number][] };
```

Applied where candidate matchings are built (`matchups.ts:115-129`):

- **`fixed`** → `options[n]` becomes the single supplied matching.
- **`require`** → `options[n]` is filtered to matchings containing every required
  pair.
- **absent** → unchanged, all matchings.

No change to the descent. The search picks `choice[n]` from `options[n]`, so a
one-element list pins a night by construction, and the existing
`MAX_MATCHINGS` guard and `playing.length % 2` check still apply. A `require`
constraint that filters to zero matchings returns `null`, same as the existing
failure path.

Callers map onto it as:

- **Locked** nights → `fixed` at their current pairing.
- The one-off night → `require` the forced pair (two pairs for semifinals).
- Every remaining night → free.

A night is **locked** if it is in the past **or** any of its games has
`status != 'scheduled'`. One rule, used both for deciding which nights can host a
one-off and for deciding which the repair may touch. Whole-night granularity,
because re-pairing part of a night would break one-game-per-team.

### 3.3 Searching the whole remaining season

The repair considers **every remaining unplayed night**, not a capped window.

This is affordable. At 8 teams and 3 ice slots, 6 teams play a night, giving 15
perfect matchings; a 25-night remainder is a small search space, and the pinned
nights shrink it further. The existing `timeBudgetMs` (default 600ms) and
`restarts` (default 12) knobs bound it regardless.

### 3.4 Producing options, not an answer

One solver run yields one answer, and there are genuinely different good answers.
The preview runs the constrained solver under several objective weightings and
returns the distinct plans:

| Plan | Weighting | Character |
|---|---|---|
| **Swap back soonest** | penalise night-distance from the one-off | The multiset returns to target within a week or two. Nothing beyond that point changes at all. |
| **Fewest nights touched** | churn cost dominant | Usually a single later night carrying the complementary pairing, flipped back. Minimum disruption, but that night may sit far out. |
| **Best resulting spacing** | churn cost near zero, spacing normal | Free to spread the correction across a few nights and finish with better rematch spacing than the schedule had before. |
| **No repair** | not solved — the one-off alone | Baseline, always shown, so the cost of doing nothing is visible. |

Two mechanisms make this work:

- **Churn cost.** A per-night penalty for differing from what is published,
  seeded from the incumbent pairing rather than `seedGreedy`. Without it the
  solver is free to return an equally-optimal but wholly different remaining
  season. With it, it deviates only where it must, and varying the weight is what
  separates "fewest nights touched" from "best spacing".
- **Recency cost.** A penalty proportional to a changed night's distance from the
  one-off, which is what produces "swap back soonest".

Plans are **deduped by changed-night signature** — when two weightings land on
the same edit it appears once, so the manager is never asked to choose between
identical options. Fewer than four plans is a normal outcome.

Each plan is presented with a full scorecard, so the constraint cost of the
low-churn options is visible rather than implied:

- **new-opponent nights** and **same-opponent nights**, counted separately — see below
- the date the multiset is back on target
- residual per-pair drift, if exact restoration was unreachable
- before/after on per-team ice-time spread and home/away spread
- before/after on the spacing checks already in the balance report:
  `byesConsecWeek`, `rematchSameWeek`, `rematchAdjNight`, `slotConsecutive`
  (`src/lib/schedule/spacing.ts`)

Games-played, per-weekday counts and byes are **identical across every plan
including the baseline** — that is §1's exact invariant, not a dimension the
plans trade against. Everything else in the scorecard genuinely varies, which is
what makes the choice a real one.

**New opponent vs. same opponent.** Repairing ice-time share requires re-timing
games on nights whose matchups never changed — slot share is a season-long
per-team total, so it cannot be fixed on the one night that broke it. A captain
can therefore see a game move from 19:00 to 21:30 with the same opponent. That
reads very differently from a changed opponent, so the two are counted separately
rather than pooled into one "nights changed" count.

**Do not call the second category "ice time only."** The orientation pass can
flip home/away on a night whose matchups it never touched, so a same-opponent
night may be a home/away change, an ice-time change, or both — and in this league
home/away is a tracked balance goal with its own column in the balance report.
Naming it after only one of the two things it covers misdescribes a change the
manager is about to relay to a captain.

### 3.5 Residual drift

Exact restoration is not always reachable — the complementary pairing may not
recur, or the remaining nights may be too few. The solver returns its best and
the residual is reported rather than absorbed silently. A drift of one or two
meetings is an acceptable outcome; a drift in games played is not, and cannot
occur.

### 3.6 The other two phases

Phase M settles who plays whom. Two more passes settle the rest, run in the
generator's own order — matchups fix participation for slots, and orientation is
independent of both.

**Phase S — ice time.** `assignSlots` (`src/lib/schedule/slots.ts:49`) is reused
the same way Phase M is. It already scores each team's slots across the *whole*
season (`teamCost`, `slots.ts:91`), so locked nights count as fixed history and
the search re-levels the season total using only the free nights. It needs two
optional inputs mirroring §3.2: `initial` (start from the current slot of each
game rather than the identity packing at `slots.ts:81`) and `frozen` (nights the
search may not touch, skipped in `descend` and in the kick loop).

When the manager keeps "give the labelled game the last ice time", that one game
is pinned and the night's other games permute around it. This trades against
ice-time share for the teams involved, which is why it is a checkbox rather than
a rule.

**Orientation — home/away.** This one is genuinely new. The generator never
rebalances home/away; it inherits the circle method's parity alternation from
`buildBalancedPairings` (`roundRobin.ts:72`), and repaired pairings have no such
inheritance. A new `src/lib/schedule/homeAway.ts` minimises Σ(home−away)² across
teams: greedy by current imbalance, then local search on single-game flips.
Locked games contribute to the counts but cannot flip, and unchanged pairs keep
their orientation unless flipping strictly improves balance.

---

## 4. Placement and flow

### 4.1 Page

New route **`/schedule-builder/one-off`**, titled "Schedule a one-off game".

- Nav highlighting is free: `manage-nav.tsx:44` already matches on `href + "/"`,
  so the existing "Schedule" item stays active.
- Linked from the schedule builder page and from `/score`.
- Shows an empty state until the season has a published schedule — a one-off has
  nothing to attach to before that.

`ScheduleBuilderPanel` loses the card (`schedule-builder-panel.tsx:175-191`) and
its `ScheduleFinalForm` import, leaving the builder page to mean one thing:
draft → review → publish.

### 4.2 Sequence

1. **Pick the teams.** Final (one matchup, with a label) or Semifinals (two
   matchups), carried over from the current form.
2. **Pick the night.** The date field lists only unlocked nights where *all*
   involved teams are already scheduled — both teams for a Final, all four for
   Semifinals. An ineligible night is never offered, so §1's exact invariant
   holds by construction rather than by validation. If no night qualifies, say so
   and name the constraint.
3. **Preview.** Runs the solver, lists the plans from §3.4, each expandable to a
   night-by-night before/after diff.
4. **Apply.** The manager picks a plan; it is written in one transaction.
   Nothing published changes before this click.

**Relabel fast path.** If the chosen teams already play each other on the chosen
night, the one-off is a pure relabel: no repair, no drift, no plans to choose
between. This is likely common — a manager may well pick the night the top two
already meet.

The `fill_others` checkbox is dropped. It exists to populate a night that has no
games; every eligible night is already full. "Give the labelled game the last ice
time" is kept, since per §3.6 it trades against ice-time share.

### 4.3 Server actions

`scheduleSpecialGame` is replaced by two actions in
`src/lib/actions/schedule.ts`:

- `previewOneOffGame(prev, formData)` — validates, solves, returns the plans. No
  writes.
- `applyOneOffGame(prev, formData)` — takes the chosen plan's changes and
  **validates** them against freshly-read state.

Re-solving at apply time and comparing against the preview does not work:
`assignMatchups` and `assignSlots` both cut off on `Date.now() > deadline`
(`matchups.ts:113`, `slots.ts:62`), so two runs may legitimately differ and apply
would fail spuriously. Validating the submitted plan is both safer and simpler,
because the checks *are* the invariant:

1. every changed night is unlocked;
2. each night's new pairing is a perfect matching over exactly that night's
   existing participants;
3. the forced pair(s) appear on the one-off night;
4. per-team game counts are unchanged;
5. each night's set of times is unchanged — times permute within a night, never
   across nights.

Any payload passing all five is balance-preserving by construction, so a tampered
submission cannot do damage.

Existing validation carries over: teams enrolled this season, two distinct teams
per game, no team in two games the same night.

**Precondition guard.** Before solving, reject schedules the solver cannot take:
a night with an odd number of participants, a team playing twice on one night, or
`assignMatchups` returning `null` (its `MAX_MATCHINGS = 1_000` cap trips at 12
teams on a night, i.e. 6+ ice slots). This is not hypothetical — `/import` exists,
and an imported schedule carries none of the generator's structural guarantees.

This **fails closed** with a plain explanation; it does not fall back to the
no-repair baseline. The baseline is itself produced by `assignMatchups`, so when
the enumeration ceiling trips there is nothing to fall back to without a second,
solver-free pairing path — and that path would run on exactly the schedules we
understand least, producing a plan whose balance properties can't be
characterised. Refusing is the better behaviour.

### 4.4 Repair module

New `src/lib/schedule/oneOff.ts`, pure and free of Supabase:

```ts
export type OneOffPlan = {
  id: string;              // stable: the weighting that produced it
  label: string;           // "Swap back soonest", …
  /** Every night whose arrangement differs, with before and after. */
  changes: {
    night: number;
    from: [number, number][];
    to: [number, number][];
    /** False when the same teams still meet — only time or home side moved. */
    matchupChanged: boolean;
  }[];
  /** The two categories above, as night indexes, for the summary line. */
  matchupNights: number[];
  sameOpponentNights: number[];
  /** Last changed night — when the multiset is back on target. */
  settledNight: number | null;
  /** Pairs still off target, if exact restoration was unreachable. */
  drift: { pair: [number, number]; delta: number }[];
  spacingBefore: SpacingReport;
  spacingAfter: SpacingReport;
  slotSpreadBefore: number;
  slotSpreadAfter: number;
  homeAwaySpreadBefore: number;
  homeAwaySpreadAfter: number;
};

/** Reconstruct participation + pairings from published games, solve, diff. */
export function planOneOff(opts: {
  nights: { date: string; pairs: [number, number][]; locked: boolean }[];
  teamCount: number;
  oneOffNight: number;
  forcedPairs: [number, number][];
}): OneOffPlan[];
```

Split into two passes so each is independently verifiable: reconstruct-and-solve
(participation, targets, guard, fast path, the three phases) and plan-production
(the weightings, dedupe, scorecards).

The action layer reads games, maps to indices, calls this, and maps back. Keeping
the solving pure is what makes §5's assertions testable without a database.

### 4.5 Writes are updates, never delete-and-insert

Applying a plan changes `home_team_id`, `away_team_id`, `scheduled_at` and
`label` on existing `games` rows. It never deletes a game and inserts a
replacement.

A night's game count and its set of dates and times are unchanged by §1 — the
Phase S repair permutes times *within* a night, never across nights — so there is
always an existing row to carry each new pairing. Updating in place keeps ids stable,
so anything already pointing at a game — `game_rosters`, links a captain has
been sent — survives the repair. Delete-and-insert would silently drop attached
rows via `on delete cascade`.

---

## 5. Testing

**`matchups.test.ts`** — the new constraint option:

- a `fixed` night is present unchanged in the result
- a `require` pair appears in that night's matching
- an over-constrained `require` (no matching contains the pair) returns `null`
- a forced extra meeting is swapped back when a later night can carry it,
  driving `multiplicityError` to 0

**`slots.test.ts`** (new — `slots.ts` has no test file today) — `frozen` nights
keep their slots; `initial` is respected; a season perturbed on one night is
re-levelled to its original per-team slot spread when the free nights allow.

**`homeAway.test.ts`** (new) — locked games constrain but cannot flip; an even
split is reached when parity allows; unchanged pairs do not flip gratuitously.

**`oneOff.test.ts`** — the repair, on the 8-team reference scenario from
`SCHEDULE_HANDOFF.md` (Mon + Thu, 3 ice times, 48 nights, 144 games):

- **The exact invariant, asserted directly.** Games per team, per-weekday counts
  per team, and bye counts per team are *bit-identical* before and after, for
  every plan including the baseline. This is the assertion that matters most: it
  is what makes the manager's choice safe.
- **The repaired constraints.** Pair-meeting counts return to target when the
  complementary pairing recurs; per-team slot spread and home/away spread return
  to at least their pre-edit values when the free nights allow.
- Residual drift is reported, not silently absorbed, when they do not.
- Locked nights are never modified — matchups *or* times.
- The relabel fast path produces zero changes.
- The precondition guard rejects an odd night and a team playing twice a night.
- "Fewest nights touched" touches no more nights than "best spacing".
- Plans are deduped — no two returned plans share a changed-night signature.

The write-path validators are tested too, which is why they live in
`checkOneOffWrite` rather than inline in the server action: they are the last
thing between a client payload and the database, and a Supabase-bound action
isn't testable in this repo without a mocking approach it doesn't have. Pulling
them into a pure function made each rejection a plain unit test — a date that
isn't a game night, a locked one-off night with no changes at all (the relabel
path, where the lock would otherwise never be checked), a locked night being
changed, a night listed twice, a stale game count, an out-of-range team, a team
playing itself or playing twice, a team substituted onto a night they weren't on,
and a plan that drops the game being scheduled.

**e2e** — `e2e/11-schedule-builder.spec.ts:48` currently asserts the card is on
the builder page; invert it to assert the card is *gone*. Add
`e2e/14-one-off-game.spec.ts` — numbered last so it can publish games without
polluting specs 12–13, which depend on seeded data: page loads, empty state
without a published schedule, ineligible dates aren't offered, preview lists
plans with scorecards, scorekeeper is bounced.
