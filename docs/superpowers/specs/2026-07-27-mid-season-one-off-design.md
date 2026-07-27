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
2. Make a one-off structurally incapable of disturbing games-played, byes,
   weekday balance, or ice-time share.
3. Repair the one thing it does disturb — which pairs meet how often — by
   adjusting later games in the season, and let the manager choose how.

## Non-goals

- Regenerating the season. Nothing in this design re-runs the full generator.
- Moving any game to a different date or ice time.
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
property the generator optimises is a function of participation and therefore
cannot move:

| Property | Why it can't drift |
|---|---|
| Games per team | Every team playing that night still plays exactly one game |
| Byes, and all three bye rules | The set of idle teams per night is untouched |
| Weekday balance | A team's games on a weekday = that weekday's nights − its byes there; neither changes |
| Ice-time share | The night runs the same games on the same slots |

What *does* move is the **pair-meeting multiset** — how many times each pair
faces each other over the season. A night scheduled as A–B / C–D / E–F, forced to
carry B–D, leaves {A, C, E, F} to be re-paired. B–D gains a meeting; A–B and C–D
each lose one.

This is the whole problem, and it is a small one.

## 2. The target

"The desired schedule balance" needs a precise definition to repair against. It
is the **pair-meeting counts of the schedule as currently published**, read off
the games table immediately before the edit.

Nothing needs to be stored for this. The published schedule is the manager's
declared intent; the repair's job is to end the season with the same pair-meeting
counts it would have had.

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

- Nights already played (status `final` or `in_progress`, or a date in the past)
  → `fixed` at their current pairing.
- The one-off night → `require` the forced pair (two pairs for semifinals).
- Every remaining night → free.

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

Each plan is presented with the facts that distinguish it:

- nights changed (count, and the diff per night)
- the date the multiset is back on target
- residual per-pair drift, if exact restoration was unreachable
- before/after on the spacing checks already in the balance report:
  `byesConsecWeek`, `rematchSameWeek`, `rematchAdjNight`, `slotConsecutive`
  (`src/lib/schedule/spacing.ts`)

Games-played, per-weekday counts, byes and ice-time share are **identical across
every plan including the baseline**. That is section 1's invariant, not a
dimension the plans trade against. The manager's choice is only ever about
matchups and churn.

### 3.5 Residual drift

Exact restoration is not always reachable — the complementary pairing may not
recur, or the remaining nights may be too few. The solver returns its best and
the residual is reported per pair. A drift of one or two meetings is an
acceptable outcome; a drift in games played is not, and cannot occur.

### 3.6 Orientation and slots

The matching is unordered, so home/away and ice time must be resolved:

- **Unchanged pairs** keep their exact orientation and scheduled time.
- **New pairs** take the orientation that levels each team's home/away count.
- The night's games take the night's **existing** slot times. The labelled game
  takes the last slot, preserving the current form's "the Final takes the feature
  time" behaviour.

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
2. **Pick the night.** The date field lists only remaining nights where *all*
   involved teams are already scheduled — both teams for a Final, all four for
   Semifinals. An ineligible night is never offered, so the section 1 invariant
   holds by construction rather than by validation. If no night qualifies, say so
   and name the constraint.
3. **Preview.** Runs the solver, lists the plans from §3.4, each expandable to a
   night-by-night before/after diff.
4. **Apply.** The manager picks a plan; it is written in one transaction.
   Nothing published changes before this click.

The `fill_others` checkbox is dropped. It exists to populate a night that has no
games; every eligible night is already full.

### 4.3 Server actions

`scheduleSpecialGame` is replaced by two actions in
`src/lib/actions/schedule.ts`:

- `previewOneOffGame(prev, formData)` — validates, solves, returns the plans. No
  writes.
- `applyOneOffGame(prev, formData)` — takes the chosen plan id, re-solves
  deterministically (same seed and weights), verifies the resulting plan still
  matches what was previewed, and writes. Re-solving rather than trusting a
  round-tripped plan keeps the client from being able to submit an arbitrary
  schedule rewrite; a mismatch (the schedule changed under the manager between
  preview and apply) is reported rather than applied.

Existing validation carries over: teams enrolled this season, two distinct teams
per game, no team in two games the same night.

### 4.4 Repair module

New `src/lib/schedule/oneOff.ts`, pure and free of Supabase:

```ts
export type OneOffPlan = {
  id: string;              // stable: the weighting that produced it
  label: string;           // "Swap back soonest", …
  /** Nights whose pairing changes, with before and after. */
  changes: { night: number; from: [number, number][]; to: [number, number][] }[];
  /** Last changed night — when the multiset is back on target. */
  settledNight: number | null;
  /** Pairs still off target, if exact restoration was unreachable. */
  drift: { pair: [number, number]; delta: number }[];
  spacingBefore: SpacingReport;
  spacingAfter: SpacingReport;
};

/** Reconstruct participation + pairings from published games, solve, diff. */
export function planOneOff(opts: {
  nights: { date: string; pairs: [number, number][]; played: boolean }[];
  teamCount: number;
  oneOffNight: number;
  forcedPairs: [number, number][];
}): OneOffPlan[];
```

The action layer reads games, maps to indices, calls this, and maps back. Keeping
the solving pure is what makes §5's assertions testable without a database.

### 4.5 Writes are updates, never delete-and-insert

Applying a plan changes `home_team_id`, `away_team_id` and `label` on existing
`games` rows. It never deletes a game and inserts a replacement.

A night's game count, dates and times are unchanged by §1, so there is always an
existing row to carry each new pairing. Updating in place keeps game ids stable,
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

**`oneOff.test.ts`** — the repair, on the 8-team reference scenario from
`SCHEDULE_HANDOFF.md` (Mon + Thu, 3 ice times, 48 nights, 144 games):

- **The invariant, asserted directly.** Games per team, per-weekday counts per
  team, and bye counts per team are *bit-identical* before and after, for every
  plan including the baseline. This is the assertion that matters most: it is
  what makes the manager's choice safe.
- Pair-meeting counts return to target when the complementary pairing recurs.
- Residual drift is reported, not silently absorbed, when it does not.
- Played nights are never modified.
- "Fewest nights touched" touches no more nights than "best spacing".
- Plans are deduped — no two returned plans share a changed-night signature.

**e2e** — `e2e/11-schedule-builder.spec.ts:48` currently asserts the card is on
the builder page. That assertion moves to a new spec for `/schedule-builder/one-off`:
pick teams → only eligible dates offered → preview lists plans → apply → the
schedule reflects the chosen plan. Add an assertion to the builder spec that the
card is *gone* from that page.
