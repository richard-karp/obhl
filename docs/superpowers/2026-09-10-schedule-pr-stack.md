# Schedule PR stack — eight open PRs, two sessions, one collision

**Protocol — read this and nothing else to resume.**

1. This file is self-contained. Do **NOT** read `SCHEDULE_HANDOFF.md` (528 lines)
   or either 2026-09-09 spec — they describe work that is already built and
   pushed; what is unresolved is *which of these PRs merge, in what order*.
2. ⛔ **Nothing here needs building. The next action is a measurement, and the
   decision after it is the maintainer's.** Do not merge, rebase or close any PR
   without being asked — six of the eight are another session's work.
3. Every number in §3 was **watched appear** on this machine. Every claim about
   PRs #64/#65/#67/#68/#69/#70 is a **reading of that PR's description**, not a
   measurement — they are another session's and were not re-run here.
4. Verify this branch with `npm test` (560 tests, ~257 s, green 3× on
   2026-09-09) and `npx playwright test e2e/11-schedule-builder.spec.ts` (17/17).
   CI is green on both #66 and #71 including the full e2e suite.

**Status: my two PRs are finished, pushed and green. Nothing is in flight.**
#66 `fix/schedule-variations` (8 commits, base `main`) ·
#71 `feat/schedule-followups` (7 commits, base `fix/schedule-variations`).

---

## 1. The hazard, and it is the whole reason this file exists

`vitest.config.ts` pinned `OBHL_SLOT_RESTARTS=2000` while `assignNights.ts`
defaulted to `20000`. Phase S is **non-monotonic**, so those are different
programs: on 6 teams / one weeknight / 3 sheets the worst team's clustered
windows are **4** at 2,000 and **13** at 20,000. `8936d89` (in #66) drops the
default to 1,000 and makes the suite assert the variable is unset.

**Measured with `git merge-base --is-ancestor 8936d89`: none of #64, #65, #67,
#68, #69, #70 contain that fix.** Every 6-team number in those six PRs was taken
on the generator that does not work. Their 8-team numbers are unaffected — see
§4.

## 2. The PR map

Bases read from `gh pr list --json baseRefName` on 2026-09-10.

| PR | branch → base | what it does | collides with |
|---|---|---|---|
| #64 | `feat/panel-cluster-metric` → `main` | panel clustering row | **duplicates #71's Task 4** |
| #65 | `fix/schedule-cluster-constrained` → `docs/schedule-clustering-followups` | `periodicPass()` in Phase M for constrained seasons | **duplicates #71's Tasks 1-2, different mechanism** |
| #66 | `fix/schedule-variations` → `main` | restart fix + seeded variations | — |
| #67 | `docs/schedule-followups-plan` → `main` | two planning docs | its "do not narrow the gate" item |
| #68 | `spec1c/cluster-in-iceoutcome` → `main` | clustering into `compareIceOutcome` | premise changed by #66 and #71 |
| #69 | `spec4/weight-coupling` → #68 | MULT_W/SPACING_W/CHURN_W guards | clean |
| #70 | `spec2/gate-is-position-sensitive` → #65 | ⛔ note "the gate cannot be narrowed" | **#71 narrows it** |
| #71 | `feat/schedule-followups` → #66 | night classes + panel + counter | — |

`periodicPass` is **not in this tree** (`grep` returns nothing) — it arrives with
#65, so #65/#67/#70 reason about a codebase this branch does not have.

## 3. My measurements — all watched appear

6 teams / one weeknight / 3 sheets / 23 weeks, worst team's five-game stretches
carrying one ice time 3+ times. Harness in the session scratchpad (`loader.mjs`
+ `control.ts` / `constrained.ts` / `ref8.ts` / `probe.ts`); **regenerate, do not
quote, if the tree moved.**

| Phase S restarts | worst team | total | time | search ends by |
|---|---|---|---|---|
| 250 | 6 | 20 | 2.3 s | restarts |
| 500 / 1,000 / 2,000 | **4** | 17 | 3.8-12.4 s | restarts |
| 4,000 / 8,000 / 20,000 | 13 / 10 / 13 | 28 | ~25 s | clock |

Not truncation: given a 60 s budget so it completes, 4,000 still returns 13.

| constrained season | before #71 | after #71 |
|---|---|---|
| one `slot_on` pin | 15 | **5** |
| `slot_bias` whole season | 17, unmet | **5**, met |
| `slot_bias` first half | 14 | 10 |
| no requests | 4 | 4 (unchanged) |

Ablation: best-of-4 alone 15→13; night classes alone 15→14; both 15→**5**.

8-team Mon+Thu reference: **17 / 94, byte-identical at 500, 1,000, 2,000 and
20,000 restarts**, every other metric perfect (18/18, 12/12/12, byes and rematch
all 0).

## 4. What of the other session's evidence transfers

- **#67's 8-team conclusion holds.** It reports 17/94 byte-identical across four
  independent attempts, and a rule-ignoring climb reaching 9 only at season share
  25 / weekday split 40. My own sweep shows that league is insensitive to the
  restart count, so the missing fix does not affect it. This is better evidence
  than anything in `SCHEDULE_HANDOFF.md` §5 and closes the question.
- **Their 6-team numbers do not transfer** — #65's "kept its worst team at 14"
  and #67's "post-pass regressed a 6-team fixture 6 → 7" were taken where the
  baseline is 13-15, not 4.
- **#70's finding is right and supports #71.** Its table (`forced`/`slotPins` →
  night index, `byeInWeek` → week, `biases` → night-window) is exactly what
  `nightClass` labels. It disproves exempting bias-only leagues *wholesale*;
  #71 preserves position class-wise instead, which it did not consider. Its ⛔
  comment goes stale if #71 lands.
- **#68 needs re-measuring after #66.** Its premise — `compareIceOutcome` cannot
  see clustering — is precisely the cause of the non-monotonicity in §3. Fix that
  and the cliff may move, so 1,000 may stop being the right default.

## 5. Not verified, and recorded rather than glossed

- The **constraint term** in variation selection (`rankOf` in `assignNights.ts`)
  is **not** mutation-verified: on every fixture measured the four draws' unmet
  counts are `1 0 0 0`, so any rule lands on a satisfying draw. The test says so.
- The **`forced` and `byeInWeek` label paths are untested**. Every constraint
  kind reaching them is infeasible on the 6-team fixture (nobody ever byes) or
  unfalsifiable there (`play_on` is satisfied by arithmetic). The 8-team league
  has byes but is too tight to permute.
- Whether `periodicPass` (#65) and night classes (#71) **compose** is unmeasured.
  That is the next action.

## 6. Next action

Re-measure #65 against #71 on the fixed generator: worst-team clustering and
request satisfaction for `periodicPass` alone, night classes alone, and both, on
the 6-team shape at 1,000 restarts. Roughly 20 minutes with the scratchpad
harness. It turns the #65-vs-#71 choice from a coin flip into a decision.

The merge order itself is the maintainer's call. The only part worth arguing:
**#66 first**, because until it lands every 6-team measurement in this stack is
about a program nobody runs.
