# Ice-time clustering: de-periodising the round order

**Status:** designed, not built. Measured 2026-09-09.

## The complaint

A maintainer generated a 23-Tuesday season (6 teams, one game night a week,
3 ice times) and reported that a team had the late game 3 times in 5 weeks.

## What was measured

Reproduced exactly, deterministic over three runs of the real generator on that
shape. Definitions used throughout:

- **clustered window** — a 5-consecutive-game stretch in which one team takes the
  same ice time 3+ times. 114 (team, window) pairs exist in a 23-week season.
- **back-to-back** — a team taking the same ice time in consecutive games.
  132 chances a season.

| | clustered windows | worst single team | back-to-backs |
|---|---|---|---|
| Generator today | 33 of 114 | **14** | 6 |

The damage is concentrated, not spread: team 1 carried 14 of the 33; team 4
carried 1. Team 1's season reads `9 8 9 7 9 7 9 7 9 7 9 8 9 8 9 8 7 8 7 8 7 8 7`
— locked in a two-slot alternation for 16 weeks, then never on 9:30 again.

## Root cause

Two facts compose:

1. **Nothing measures it.** `teamCost` (`slots.ts`) prices ice time with
   `SHARE_W`/`WEEKDAY_SHARE_W` (order-blind season aggregates), `slotStreak3`
   (fires only on three *in a row*) and `slotConsecutive` (weight 6, the cheapest
   term in the file). A `9,7,9,9,7` stretch costs the search 6 points, so local
   bunching is the first thing given away. On a single-weekday league the two
   share terms are the same statement scored twice (`slots.ts:44`), so share
   dominates even harder.
2. **The pairing sequence is strictly periodic.** `roundRobinRounds` resets its
   rotation at the start of each cycle, so a 23-round even-league season is
   `A B C D E A B C D E ...` — the same three matchups every fifth week. Its
   docstring advertises this as "good temporal spread", which it is *for
   rematches*. But the clustered-window length is also 5, so each team meets a
   period-5 opponent structure and whatever slot pattern it falls into repeats
   all season with no way out.

Phase M is not misbehaving: an even cycle is optimal for its objective, and ties
among equally-good orderings are broken deterministically.

## Decision

**Reorder the rounds the generator already emits, and rank clustering strictly
below `slotConsecutive` as a tiebreaker.**

Measured effect, holding back-to-backs at today's 6 and rematch spacing at 0
adjacent meetings:

| | clustered windows | worst single team | back-to-backs |
|---|---|---|---|
| Today | 33 | 14 | 6 |
| **Reordered (this design)** | — | **5** | **6 (unchanged)** |

The maintainer chose this over a paid variant (worst team 3, back-to-backs 6→10)
on 2026-09-09, on the grounds that it costs nothing.

Ranking below `slotConsecutive` is what makes "free" structural rather than a
tuning outcome: the new term can only choose between candidates that already tie
on every existing metric, so it can never trade a back-to-back for a cluster.

## ⛔ Reordering the emitted rounds does NOT work — measured 2026-09-09

The obvious implementation is to permute the rounds `buildBalancedPairings`
returns: it preserves the matchup multiset, each round's home/away pairs, and
games per team, changing only temporal order. It was built and measured against
the real pipeline on the 23-Tuesday shape, over five seeds.

**Every seed returned a byte-identical schedule to today** — worst team 14, total
33, per-team `[14 7 6 1 3 2]`, `slotConsecutive` 6.

`assignNights` consumes `Pairing[]` as a *multiset*. `planByParticipation` — the
planner that wins on this shape — hands the matchups to Phase M, which decides
for itself which matchup lands on which night, and `round` survives only as a
field copied through (`assignNights.ts:1291`, `:1644`) and a queue sort in the
fallback planner (`:1409`). Phase M then *re-derives* the periodic cycle, because
an even cycle genuinely is optimal for rematch spacing.

So the periodicity is not inherited from `roundRobinRounds`; it is reconstructed
downstream. `roundRobin.ts` is the wrong file. **Do not try this again.**

The consequence: the week order is Phase M's decision, and reaching the free
outcome requires a tiebreaker or candidate rank-off inside Phase M
(`matchups.ts`) among orderings that already tie on every existing metric.
`AssignOptions` carries no seed today, so there is no cheap way to sample
alternative Phase M outputs; a rank-off multiplies generate time by the candidate
count (~26 s → ~78 s at three candidates on the 8-team reference).

The *target* is unaffected and still proved: orderings exist that tie on
`rematchAdjNight`, `rematchConsecWeek` and `slotConsecutive` and give worst-team
5 rather than 14. Only the route to them is harder than this section first
claimed.

## The mechanism that works: a night-order post-pass

Also falsified, 2026-09-09: **varying Phase M's seed does not escape the cycle.**
`MatchupOptions` already carries `seed`; plumbed through the `assignMatchups`
call site (`assignNights.ts:1464`) and measured over seeds 1-8, every one
returned the identical order `ABCDEABCDEABCDEABCDEABC` and the identical
schedule. Phase M's rematch terms are threshold-based — a gap of 2+ weeks costs
nothing — so the cycle is one of many zero-cost orderings and the descent always
lands on it. A seed rank-off buys nothing; escaping would need a new term in
Phase M's objective.

**It does not need one.** Permuting the *night order* of a finished plan moves
clustering while leaving almost everything else invariant by construction: each
night's games and their ice times travel together, so games per team, meetings
per pair, and every team's ice share are untouched. Only the temporal metrics —
clustering, `slotConsecutive`, `slotStreak3`, rematch spacing — move.

Measured on the 23-Tuesday shape, annealing over night swaps and accepting only
permutations that regress nothing:

| | worst team | total clustered windows | slotConsecutive | streak3 | rematchAdjNight |
|---|---|---|---|---|---|
| Before | 14 | 33 | 6 | 0 | 0 |
| **After** | **4** | **18** | 6 | 0 | 0 |

Every team's share stayed 8/7/8 or 8/8/7. This beats the worst-team 5 that
motivated this design, and equals what the *paid* variant would have bought,
at no cost.

⚠️ **Safety is conditional and must be enforced, not assumed.** The invariance
above holds because on this shape every team plays every night on a single
weekday, so there are no byes to space and no weekday split to hold. On a shape
with byes or multiple weekdays, reordering nights moves bye spacing, weekday
balance and `pairingWeekdayExcess`. The pass must therefore accept a permutation
only when the **whole `rankSchedule` vector** is no worse — which makes it safe on
every shape and a no-op where it cannot help.

## Alternatives rejected

- **A convex windowed term inside `teamCost`.** Reaches worst-team 4 but costs
  back-to-backs 6→16, and lands inside the tuned Phase S search that
  `SCHEDULE_HANDOFF.md` §5 warns is coupled to `SLOT_CANDIDATES` and Phase M's
  output. Strictly dominated: reordering reaches worst-team 5 for free, and
  reordering plus a small budget reaches 3.
- **`slot_bias` manager constraints.** A directional lean over a date window,
  ranked below every real ice-time goal. Cannot express "do not bunch".
- **The one-off repair.** This is a whole-season property; the repair holds the
  season still by design.
- **Choosing pairings by running Phase S on each candidate.** §5 already prices
  this idea (as a Phase-S-aware `plateauScore`) and it multiplies generate time
  by the candidate count — ~26 s becomes ~78 s on the 8-team reference.

## Acceptance

On the 6-team / 23-Tuesday / 3-slot shape:

- worst single team's clustered windows ≤ 6 (measured floor is 5; assert the
  bound, not the floor — see §5's note on asserting search luck);
- `slotConsecutive` no worse than today's 6;
- `rematchAdjNight`, `rematchConsecWeek`, `rematchConsecWeekSameDay` all 0;
- every team still 8/8/7 across the three ice times;
- games per team, games per night and meetings per pair identical to today.

On the 8-team reference season and every row of `SCHEDULE_HANDOFF.md` §4: no
metric worse than it is today.

## Known limits

- The floors above come from an exhaustive solver over slot assignments with the
  pairings held fixed. They prove a schedule that good **exists**; the production
  search still has to find it. Verification must measure the real pipeline.
- Sampling was 14 candidate orderings on one season shape with generic teams and
  no excluded dates. A real season with holiday gaps will move the numbers.
- Home/away needs no verification under the night-order pass: reordering nights
  never touches a game's home/away, so `homeAway`'s work is carried through
  untouched. (That caveat was written against the dead round-reordering route,
  where it did apply.)

## Tuning the pass (measured 2026-09-09)

`improveNightOrder`'s `restarts`/`steps` were swept on the 8-team reference
season (generate wall-clock) against the 6-team/1-weeknight/3-slot fixture
(quality). Baseline with the pass present but doing no search: 26.26 s generate,
`slotClusterWorstTeam` 14/14/14 — matching the pre-branch number.

| restarts | steps | 8-team generate | added | 6-team `slotClusterWorstTeam` (3 runs) | verdict |
|---|---|---|---|---|---|
| 4 | 6,000 | 31.56–31.77 s | ~5.4 s | 4, 4, 4 | too slow |
| 2 | 6,000 | 28.93 s | 2.67 s | 6, 6, 6 | passes with zero margin |
| 4 | 3,000 | 28.98 s | 2.72 s | 4, 4, 4 | full quality, still > 2 s |
| 4 | 2,000 | 28.11 s | 1.85 s | 4, 4, 4 | full quality, at target |
| **4** | **1,500** | **27.62–27.67 s** | **~1.4 s** | **4, 4, 4** | **chosen** |
| 4 | 1,000 | 27.20 s | 0.94 s | 8, 8, 8 | breaks the ≤ 6 bound |
| 3 | 1,500 | 27.34 s | 1.08 s | 8, 8, 8 | breaks the ≤ 6 bound |
| 2 | 1,500 | 27.02 s | 0.76 s | 8 | breaks the ≤ 6 bound |

⚠️ **There is a cliff here, not a slope.** Between `steps` 1,500 and 1,000 the
quality collapses straight from 4 to 8 — no setting was found holding an
intermediate value. So `4/1500` is simultaneously the cheapest and the
highest-margin option on this fixture rather than a compromise, and shaving
`steps` further to save a second does not buy a slightly worse schedule, it
buys the pre-branch one. Re-measure the whole table rather than nudging a
number if this is ever revisited.

`NIGHT_ORDER_ALLOWANCE_MS` (1_500) rounds the measured ~1.4 s up, the same
convention `PHASE_PM_ALLOWANCE_MS` already uses for its own ~1.3 s.
