# Execution record — the schedule follow-ups

Companion to `2026-09-09-schedule-generation-followups.md`, which says what each
item is. This was written as a forward plan; it is now a record of what actually
landed, because the plan was executed the same day.

## What shipped

| PR | Branch | Outcome |
|---|---|---|
| **#68** | `spec1c/cluster-in-iceoutcome` → `main` | `clusterWorst`/`clusterTotal` computed in `iceOutcome`, sharing one `clusteredWindows` helper with `spacingReport`. **Deliberately not ranked** in `compareIceOutcome`. |
| **#69** | `spec4/weight-coupling` → #68 | Two coupling guards, each mutation-tested. The third repointed at `ICE_METRICS`, which is the coupling that actually exists. |
| **#70** | `spec2/gate-is-position-sensitive` → #65 | The planned gate narrowing, **not built** — premise disproved — with a test and a ⛔ note recording why. |
| **#65** | `fix/schedule-cluster-constrained` → #63 | The periodicity pass, plus review fixes: bounds given real margin, pass cap scaled with season length, `winAt` restored under `finally`. |
| **#67** | `docs/schedule-followups-plan` → `main` | These two documents. |

## How the collisions were handled

Two independent chains, split on which files each item touched, so nothing
waited on a merge:

```
main ─┬─▶ #68 ─▶ #69          (spacing.ts / oneOff.ts / matchups.ts)
      └─▶ #67                 (docs only)

#63 ─▶ #65 ─▶ #70             (assignNights.ts gate sites, matchups.ts)
```

Stacking rather than waiting worked. What it cost: amending #68 after review
forced a `--onto` rebase of #69 (a plain rebase tries to replay the pre-amend
base), and changing #65 forced a rebase of #70. Both were mechanical.

⛔ **You cannot check out the same branch in two worktrees**, so each stacked
branch took a new name based on the ref below it.

## What the plan got wrong

Worth recording, because the pattern repeated:

- **Two of the four items should not be built at all**, and neither was
  discoverable by reading — the gate narrowing rests on `slot_bias` being
  position-free (it is not), and the clustering post-pass helps nothing and
  regressed a fixture. Both cost about an hour to disprove and would have cost a
  day each to discover after building.
- **A claim inferred from a type error propagated into two commit messages, two
  PR bodies and both of these documents** before a reviewer traced the call sites
  and found it false. Each restatement made it look better established rather
  than better verified.
- **"At production budget" was wrong** for every measurement taken through
  vitest: the config pins `OBHL_SLOT_RESTARTS=2000` against production's
  `20_000`, and Phase S is non-monotonic in restarts. The budget matched; the
  restart count did not, and only one of the two was checked.

## Rules that earned their place

- **Three runs, not one.** The 40-night fixture varies run to run; the 8-team
  reference does not. A single run of either looks equally precise.
- **Read from `scheduledAt`**, never `report.spacing`.
- **Prove every new test can fail**, by mutation, before trusting it green.
- **A bound is not a reading.** `<= 8` against a measured 8 goes red on slower
  hardware; size bounds off the range across degraded environments.
- **No temporary harness in a commit.** One measurement file nearly went in under
  `git add -A`; it would have failed CI on every run.
- **Count the tests after a mechanical edit.** A splice anchored on a
  non-unique `describe(` name silently deleted seven pre-existing tests, and the
  suite went green because deleted tests do not fail.

## Still open

- **Item 3 (`slot_bias`)** — now justified by measurement (2/6 satisfied against
  6 achievable) and not built. It has a merge condition: 6/6 on that fixture.
- **Item 4's follow-up** — the trade is levelling, so the 40-night test should
  gain a *bound* on the league total. Sized off the measured range, not one run.
- **#63's `22 of 237`** — arithmetically impossible for that season shape, and
  sourced nowhere in the repo.
- **#66 vs #68** — #66 caps `SLOT_RESTARTS` on the premise that the comparator
  cannot see clustering. #68 leaves that premise true by not ranking it, so the
  two no longer collide; #66 still conflicts textually with #65 in
  `planByParticipation`.
