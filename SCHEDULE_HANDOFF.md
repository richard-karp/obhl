# OBHL schedule generator — weekday balance vs. bye spacing: **resolved**

This started as a handoff describing two goals believed to be in tension. They
aren't. All of them are satisfiable at once, and the generator now does it.

---

## 1. Outcome

Reference scenario (8 teams; Mon + Thu; 3 ice times; season opens Thu 2026-09-10;
36 games/team; off Dec 21/24/28/31 2026 and Thu Mar 4 2027 → 48 nights, 144 games,
an exact fit):

| Goal | Before | Now |
|---|---|---|
| **W.** Perfect weekday balance (18 Mon / 18 Thu, every team) | `wd=2` (2 teams at 19/17) | **`wd=0`** |
| **Bye rule 1** — no two byes in one week | 0 | **0** |
| **Bye rule 2** — no bye on the same weekday in consecutive weeks | 0 | **0** |
| **Bye rule 3** — no byes in consecutive weeks at all | `byeConsecWeek=1` | **0** |
| Rematch: same week / adjacent night / consecutive week | 0 / 0 / 1 | **0 / 0 / 0** |
| Ice-time share per team | spread 2 | **spread 0** (12/12/12) |
| Ice-time repeats (`slotConsecutive`) | 69 | **48** |
| Games per team / unscheduled | 36 all / 0 | 36 all / 0 |
| Generate time | ~475 ms | ~20.8 s (Phase S runs four candidates, each on a long budget — see §5) |
| **G1.** No bye adjacent to a game night (`byesAdjNight`) † | 1 | **0** |
| Longest layoff between games (`longestLayoffDays`) † | 24 | **21** (calendar floor) |
| **G2.** Each pairing split evenly over the weekdays it plays (`pairingWeekdayExcess`) † | 42 (9 of 28 matchups off ideal) | **8** (2 of 28) |
| **G3.** Ice-time share per team *per weekday* (`slotWeekdaySpread`) † | 44 | **0** (best-of-k; 8 is the guaranteed bound — see §5) |
| **G4.** Three-game runs in one ice time (`slotStreak3`) † | 4 | **0** |

† **These five rows use a different "before".** Every row above them compares
against the *old pre-participation pipeline*. The four-goal rows compare against
the participation pipeline as it stood immediately before this work
(`byesAdjNight=1`, `longestLayoffDays=24`, `pairingWeekdayExcess=42`,
`slotWeekdaySpread=44`, `slotStreak3=4`, `slotConsecutive=41`, ~5.5 s). Do not
read the two sets of "before" numbers as one column.

`slotConsecutive` rising from 41 to 48 is the accepted price of G3 and G4: the
same slot swaps that break up three-game runs and even out each team's ice share
per weekday put back some night-to-night repeats. Repeats were never the
higher-priority metric; see §5. (It read 46 under the single-weight Phase S; the
best-of-k candidate that takes G3 to 0 costs the extra 2.)

Byes are still exactly 12 per team, now exactly 6 Mon / 6 Thu, and perfectly
alternating.

**The old doc's claim that `byeConsecWeek=0` is infeasible was wrong.** The
counting argument in it was right as far as it went (⌈15/2⌉ + ⌈10/2⌉ = 13
non-adjacent bye-weeks available, 12 needed — one slot of slack) but it never
showed the slack was unusable. An exact solver finds a valid pattern in 26 search
nodes. Simulated annealing had simply never landed on it: the structure is nearly
unique, so it's a needle the random walk kept missing.

That solution is essentially forced, which is why it's so hard to stumble on:
2 teams bye weeks {0,2,…,14}, 4 teams bye {1,3,…,13}, 2 teams bye {2,4,…,14},
then a small family of choices over the post-holiday run.

---

## 2. Why the old approach couldn't get there

The old pipeline searched over *placed games*. Moving one team's weekday count
means moving a game, which drags its opponent and the two teams it swaps with
along too — so weekday balance and bye spacing genuinely fight each other in that
search space, and it stalls with each near-optimal.

The fix is to notice that both goals are properties of a much smaller object:
**which teams play which night.**

- A team's games on a weekday = that weekday's nights − its byes on that weekday.
  So weekday balance is a statement about byes.
- All three bye rules are statements about byes.

Both collapse into one 8×48 binary matrix, which branch-and-bound settles
exactly. Only *then* does it matter who plays whom.

---

## 3. Architecture

`assignNights` runs two independent planners and keeps the better one
(`rankSchedule` compares them lexicographically in the ranked priority order:
everything placed ▸ weekday ▸ byes ▸ rematch ▸ ice time).

**`planByParticipation`** — the primary, in three phases:

| Phase | File | Decides | Fixes |
|---|---|---|---|
| **P** | `participation.ts` | who plays which night | weekday balance (#1), all bye rules (#2) |
| **M** | `matchups.ts` | who plays whom | opponent balance, rematch spacing (#3) |
| **S** | `slots.ts` | which ice time | ice-time share per season **and per weekday**, three-game runs in one slot, repeats (#4) |

`assignSlots` takes a `weekdayOfNight` argument, and **both** call sites pass it —
`assignNights.ts` (generation) and `oneOff.ts` (the repair). A repair that omits it
undoes what generation achieved: measured on `oneOff.test.ts`'s fixture, the repair
without `weekdayOfNight` drives season ice spread 4 → 0 while pushing per-weekday
spread 19 → 36; with it, per-weekday goes 19 → 17.

Generation calls `assignSlots` **four times**, not once — the best-of-k candidate
set in §5 — and keeps the winner by `compareIceOutcome`. The repair still calls it
once: it is a mid-season interaction where a user is waiting, not a once-a-season
job, so it does not spend four budgets.

Phase P is exact (branch and bound, admissible bound from a min-adjacency DP,
plus O(teams×weekdays) arithmetic pre-checks that refute impossible weekday
targets before any search). It is *anytime*: on calendars where the bound can't
prove optimality it keeps improving until it stalls (2 s without a better
solution) or hits a 4 s cap, and reports whether it finished. Phase P runs twice
— a cheap 300 ms pass first, which Phase M is asked to pair up before the long
search is paid for, so a calendar Phase M was never going to handle bails in
~0.4 s instead of burning the whole budget on its way to being discarded.

Ahead of that search, `chooseWeekdayByeTargets` picks each team's per-weekday bye
quota — the evenest split the row and column totals allow. That matters when a
perfectly even split is arithmetically impossible: it gets as many teams as
possible exactly even rather than parking everyone at the edge of a slack band.
On a 10-team calendar it takes the total weekday spread from 20 to 8 (its
arithmetic floor) — 6 of 10 teams perfectly even instead of none.

Games-played equality and "no team twice a night" are structural here, not
optimised for: games per team is an input, and a team either plays a night or
byes it.

**`planByWeeks`** — the original Phase W + Phase N pipeline, unchanged. It is
still the only planner for cases the participation path declines, and it
sometimes ties.

`planByParticipation` returns null (declining) when:
- capacity can't hold the games;
- a night would have more perfect matchings than can be enumerated
  (`MAX_MATCHINGS = 1000`, i.e. 12+ teams playing a night) — sampling a slice of
  them reliably misses the meeting targets, so it declines rather than guess;
- Phase M can't reproduce the caller's exact matchup multiset.

Phase P tries a ladder of six rungs, stopping at the first that solves: the
evenest per-team weekday quotas pinned exactly, at widening tolerance, then the
same tolerances with the quotas left free. The last three matter because the
pinned quotas don't depend on tolerance — without them a calendar whose optimal
quotas can't be packed onto nights would fail every pinned rung identically. The
whole ladder shares one deadline, so a rung that runs long can't multiply its
cost; every phase is bounded, and a hard instance degrades to the fallback
rather than hanging.

---

## 4. Measured across scenarios

Same-or-better than the old pipeline everywhere tested; never worse.

| Scenario | Result |
|---|---|
| reference 8t/3slot/48n/36gp | **large win** (table above) |
| 10t/4slot/45n/36gp | **large win** — old left **5 games unscheduled** with games-per-team spread 3; now 0 unscheduled, equal GP, `byeConsecWeek` 12→0, ice spread 3→0 |
| 9t/4slot/36n/32gp | **large win** — old left 4 games unscheduled; now 0, with every bye and rematch metric at 0 |
| 7t/3slot/35n/30gp | **large win** — old left 12 games unscheduled; now 0 |
| 8t Mon/Wed/Fri, 8t Thu-only, 6t, 10t/5slot | wins, mostly on ice time and byes |
| 6t/3slot/10n | marginal win (`slotConsecutive` 6→5) |
| 8t/2slot/28n/14gp, 4t/2slot | tie — e.g. with only 4 of 8 teams playing a night every team byes every week, so rule 3 is genuinely unreachable (`byeConsecWeek=104` is the floor) |
| 7t/3slot/11n, 12t/6slot/24n, over-capacity | tie — participation path declines, fallback handles them |

Generate time: ~20.8 s for the reference, of which ~20 s is Phase S deliberately
grinding on the ice-time metrics — four candidates at ~5 s each (see §5). It was
~5.76 s when Phase S ran a single candidate. The rest of the pipeline
is ~500 ms. Two awkward calendars — Mon/Wed/Fri and one with a 3-week mid-season
gap — add ~2 s in Phase P, where the long search also buys something real (a
rule-1 breach cleared on the first, `byeConsecWeek` 3→1 on the second). Both
planners always run; that is the cost of the guarantee that the result is never
worse than before. `OBHL_SLOT_BUDGET_MS` and `OBHL_SLOT_RESTARTS` tune the Phase
S effort if a deployment needs a faster round trip.

---

## 5. Known limits (all deliberate)

A code review of this work turned up two defects — the slack ladder computing
identical quotas on every rung, and nothing bounding Phase P's total time. Both
are fixed; see §3. What follows are choices, not oversights.

- **12+ teams playing per night**: Phase M declines. `planByWeeks` already
  produces a perfect schedule for that shape, so nothing is lost — but a league
  that grows into a case where it *doesn't* would need Phase M to handle larger
  1-factorisations (a proper matching-decomposition algorithm rather than
  enumerate-and-descend).
- **Phase P is blind to Phase M.** It picks a participation matrix optimising
  byes and weekday only. On 8 teams / 2 slots the matrix it picks can't support
  a balanced pairing, so Phase M fails and the whole plan is discarded. Retrying
  Phase P with different seeds was tried and does not help there — it needs
  feedback from M into P, not more sampling. Only worth building if a real league
  config lands in that gap.
- **Runtime doubles** because both planners always run. If that ever matters,
  the cheap fix is to skip `planByWeeks` when the participation plan already
  scores zero on every soft metric. Note the server action's retry loops only
  fire when games are left unscheduled, and in that case Phase P declines on
  arithmetic in well under a millisecond — so retries stay cheap.
- **Ice-time repeats are not at a floor, and `slotConsecutive` is not a plateau
  number.** It reads **48** on the reference today. It has read 46, 41 (before the
  per-weekday and run goals landed), 39, and anywhere in 32–46 across a sweep of
  search parameters — it moves with whatever else Phase S is being asked to
  satisfy. Do not treat any particular value as "the search's limit". What *is*
  settled: simulated annealing is not the fix (62 at the same budget, and at
  temperatures low enough to beat 41 it only got there by breaking the even
  ice-time share), and the compound move this section used to predict — swapping
  slots across two nights at once so each team's share is restored in the same
  step — **is built**, as `compoundPass` in `slots.ts`. Repeats are the
  lowest-priority ice-time metric; they are allowed to rise when share or runs
  improve.
- **G3's 8 was a `STREAK3_W` draw — now selected, not tuned (built 2026-08-12).**
  No single weight wins: 140 flattens the reference season's `slotWeekdaySpread` to 0
  where the old fixed 160 read 8, but 160 beats 140 by 4 on Mon/Wed/Fri, and 144–152 are
  worse than both. So `assignNights` runs Phase S at **four candidates** — 160 once, then
  140 on seeds 1/2/3 — and keeps the winner by `compareIceOutcome`. 160 leads the set,
  which is what makes the result provably never worse than the single weight that
  shipped. Do not re-tune the weight on one fixture; add or drop candidates instead.
  **160 must stay in the set or the guarantee is gone.**
  - *Why 140 is sampled three times and 160 once:* 160 is stable — measured three times
    over it returns the identical result. 140 is not: it reaches the flat split every
    time but leaves a three-game run in **two runs out of three**. Since the comparator
    declines any sample carrying a run, extra samples are what turn 140's good basin
    from a one-in-three chance into the common case. Measured after the change, three
    seasons in a row: `slotWeekdaySpread` 0, `slotStreak3` 0.
  - *Guarantee vs. prize:* the reference test asserts `slotWeekdaySpread <= 8`, not
    `=== 0`. Eight is what the candidate set guarantees; 0 is what it usually gets.
    Asserting 0 would be asserting search luck, and it would fail intermittently.
- **The ice-time sub-order puts three-game runs above the per-weekday split.**
  `compareIceOutcome` ranks: season share ▸ `slotStreak3` ▸ `slotWeekdaySpread` ▸
  `slotConsecutive`. The middle two are in that order deliberately and the plan that
  introduced this ranking had them the other way round: goal 4 is stated as a *never*,
  the weekday split is a target, and with the terms reversed the comparator spent the
  first to buy the second on two seasons in three. Swapping them back will not fail
  loudly — it fails as an occasional three-game run in a shipped schedule.
- **The generator and the one-off repair rank ice time by different rules, on purpose.**
  Generation uses `compareIceOutcome` (lexicographic, above). The repair compares **each
  of the four metrics separately** against its no-repair baseline. A lexicographic rule
  there would keep a plan that wins on season share while losing on everything else,
  which is exactly what the repair's own test rejects. These are not two copies of one
  rule that drifted; **do not unify them.**
- **The one-off repair flags regressions rather than dropping them** (was a known
  defect; fixed 2026-08-12). It can still return a plan worse than no repair on some ice
  metric — dropping those outright would leave seasons with no repair offered at all —
  but every such plan now carries `worseThan`, naming the metrics it regresses, and the
  dialog prints the warning alongside both the season and per-weekday numbers. The
  original defect was masked by the suite running Phase S at 400 ms, which built a
  different fixture season than production's 5 s; the test budget is now 5000 ms so the
  fixture matches what production meets.
- **`MULT_W` and the `SPACING_W` rematch weights are coupled to `oneOff.ts`.**
  Rescaling either one requires rescaling `oneOff.ts`'s `nightPenalty` churn term in
  the *same* change, or the repair's sense of what a costly move is silently drifts
  out of step with generation's. **No test covers this coupling** — it fails quietly,
  with a plausible-looking schedule.
- **Unexplored: a Phase-S-aware term in `plateauScore`.** `plateauScore`
  (`assignNights.ts`) selects among bye-optimal participation matrices while knowing
  nothing about how they will slot. It is the obvious lever if a future cadence
  leaves Phase S short — but it is expensive: `plateauScore` ranks ~8 sampled
  matrices at 10–30 ms each, against Phase S's ~20 s, so scoring them on Phase S means
  running Phase S once per candidate. Never tried; selection and seeding reached
  every target without it.
- **`planByWeeks` (the fallback) keeps its week-only bye logic.** It only runs for
  shapes `planByParticipation` declines, and `rankSchedule` now penalises adjacency,
  so it can only win by being better on higher-priority terms. But when participation
  declines *entirely* (12+ teams a night), the fallback is the only planner and
  `byesAdjNight` may be non-zero with no recourse.
- **Perfect ice-time balance needs a season that exactly fills the ice.** An
  under-filled night drops its latest slot, so that slot runs on fewer nights and
  equal per-team counts stop being arithmetically possible. Measured on the
  reference calendar at 46–52 nights: exact fits (48, 52) give spread 0, the rest
  give 1 or 2, and each is already at its arithmetic floor — 49 nights provably
  cannot beat 2. The schedule builder now says so on screen rather than leaving
  it to look like a search failure.
- **Some ties are genuine floors, not failures.** `byeConsecWeek = 104` on
  8 teams / 2 sheets and `rematchConsecWeek = 22` on a 4-team league are forced
  by the calendar; no search will improve them. Adding a sheet of ice, or teams,
  is the only fix — worth saying out loud to the league rather than tuning for.

---

## 6. Files

- `src/lib/schedule/participation.ts` — Phase P. `solveParticipation`,
  `chooseWeekdayByeTargets`, `describeParticipation`.
- `src/lib/schedule/matchups.ts` — Phase M. `assignMatchups`.
- `src/lib/schedule/slots.ts` — Phase S. `assignSlots`.
- `src/lib/schedule/assignNights.ts` — `planByParticipation`, `planByWeeks`,
  `rankSchedule`, entry point `assignNights`.
- `src/lib/schedule/spacing.ts` — `spacingReport`, the metrics above, and
  `iceOutcome` / `compareIceOutcome`, which rank an ice-time result without
  building a season for it.
- `src/lib/schedule/oneOff.ts` — the mid-season repair. See `EXPORTS_HANDOFF.md` §4
  before touching it.
- Tests: `assignNights.test.ts` (includes a full reference-season regression
  suite asserting every goal), `participation.test.ts`, `matchups.test.ts`.
  Cadence coverage for the *slot* metrics lives in `matchups.test.ts` too, under
  `describe("assignSlots weekday split")`, alongside Phase M's — not in a
  `slots.test.ts`.

Verify with `npx vitest run` (222 pass), `npm run lint`, `npx tsc --noEmit`.

The suite runs Phase S at production's 5 s budget (`vitest.config.ts`), so it takes
~30 s. That is deliberate: a shorter budget once hid a real defect by building
fixture seasons production never sees. Do not lower it to speed the suite up.

---

## 7. Open work

One item left. Its brief is self-contained and says what *not* to read.

| Work | Status | Brief |
|---|---|---|
| G2 — `pairingWeekdayExcess` 8 → 0 via a compound move in Phase M | analysed, not planned | `docs/superpowers/plans/2026-08-12-g2-pairing-weekday-split.md` |

Phase S best-of-k and the one-off repair defect are **done** (2026-08-12, branch
`feat/schedule-goals`). Their plan is kept as a record of the reasoning, but two of
its decisions were overruled during execution and are marked ⛔ in its Global
Constraints — read those before trusting anything else in it. What shipped is in §5
here.
