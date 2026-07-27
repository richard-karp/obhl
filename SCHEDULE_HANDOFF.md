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
| Ice-time repeats (`slotConsecutive`) | 69 | **46** |
| Games per team / unscheduled | 36 all / 0 | 36 all / 0 |
| Generate time | ~475 ms | ~900 ms |

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
| **S** | `slots.ts` | which ice time | ice-time share + repeats (#4) |

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

Generate time: ~900 ms for the reference (was ~475 ms). Two awkward calendars —
Mon/Wed/Fri and one with a 3-week mid-season gap — spend ~2.6 s, because they are
the cases where the long search actually buys something (it clears a rule-1
breach on the first and takes `byeConsecWeek` 3→1 on the second). Everything else
is under ~900 ms. Both planners always run; that is the cost of the guarantee
that the result is never worse than before.

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
- **Ice-time repeats have a little headroom left.** The reference sits at
  `slotConsecutive = 46`; raising Phase S from 2 000 restarts to 20 000 reaches
  41, but costs ~5.6 s. Not taken: it is the lowest-ranked metric and 46 is
  already well under half what a random slotting gives.
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
- `src/lib/schedule/spacing.ts` — `spacingReport`, the metrics above.
- Tests: `assignNights.test.ts` (includes a full reference-season regression
  suite asserting every goal), `participation.test.ts`, `matchups.test.ts`.

Verify with `npx vitest run` (61 pass), `npm run lint`, `npx tsc --noEmit`.
