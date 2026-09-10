# Schedule generation — the remaining work

Rewritten 2026-09-09 after Spec 1 was investigated to a conclusion and closed.
`SCHEDULE_HANDOFF.md` §7 remains correct that **nothing is outstanding on the
four original goals.** Everything here is beyond them.

Four items remain. One is closed below, with its answer, because it is the
finding the other three are shaped by.

⚠️ **Two caveats that apply to every measurement here.** `vitest.config.ts` pins
`OBHL_SLOT_RESTARTS=2000` while production defaults to `20_000`, and Phase S is
non-monotonic in restarts — so these are test-config figures, not production
ones. And `clusterPass`, whose failure the CLOSED section reports, was never
committed to any ref: `git log --all -S` finds it only in this document. Its
numbers cannot be re-checked against code, only re-derived by rebuilding it.

---

# CLOSED — Why the 8-team league clusters

**17 is the price of perfectly equal ice time. It is not a defect.**

The live league (8 teams, Mon + Thu, 3 sheets, 48 nights, 36 games a team)
measures `slotClusterWorstTeam` **17**, `slotClusterWindows` **94**. Four
mechanisms were tried against it. All four failed, and together they explain why.

| # | attempt | result |
|---|---|---|
| 1 | night-order pass, gate forced on vs. off | byte-identical **17 / 94**; the 1.3 s delta proves it ran and accepted nothing |
| 2 | cluster pair added to `compareIceOutcome` | **17 / 94** — all five Phase S candidates measure 17 or 18, so there is nothing better to select |
| 3 | strict-gain post-pass, single within-night swap | **17 / 94** — 25 swaps improve clustering, **0 are legal** |
| 4 | same pass, `compoundPass`'s share-neutral two-night move | **17 / 94** |

Every figure is three runs at production budget, re-derived from `scheduledAt`.
The generator is deterministic on fixed seeds, so the spread is zero.

## Why

That league is already at the floor on everything ranked above clustering:
season ice share **0** (every team exactly 12/12/12 across three sheets),
per-weekday share **0**, three-game runs **0**. A strict-gain rule may not
regress any of them.

- A single within-night swap moves four teams to 11/13, so season share leaves 0.
  That is why 25 improving swaps are all illegal.
- `compoundPass`'s two-night move restores **team `t`**, but its two partner
  games each shift by one, so they leave 0 too.
- The only legal moves are closed cycles returning *every* affected team, a far
  narrower neighbourhood than any pass here searches.

**Priced directly:** a climb that ignores the rule reaches `clusterWorst` **9** —
but at season share **25** and weekday split **40**. That is the trade §7 records
the league rejecting twice.

⚠️ It is **not** what §5 records the Phase M anti-periodicity weight failing on;
an earlier version of this line conflated the two. That weight *works* — worst
team 14 → 7, rematch terms still 0, meetings/pair intact — and is rejected
because it only wins "by being large enough to buy a transiently-invalid state
and trust the descent to repair it". Its currency is opponent balance, not ice
share.

## ⛔ And the attempted fix regressed a fixture

`clusterPass` made the 6-team/one-weeknight fixture **worse**: 6 → 7, tripping an
existing bound. Isolated: comparator-only 30/30, pass-on 2 failures. The cause is
ordering — the pass runs before `improveNightOrder`, so it greedily improves the
pre-night-order assignment, and the night-order pass then starts elsewhere and
settles in a worse-clustering local optimum. **A strictly-improving upstream step
made the downstream result worse.**

## What survives

| | verdict |
|---|---|
| `clusterWorst`/`clusterTotal` in `iceOutcome` + `compareIceOutcome`, and 4 tests | **keep** — the pair now reaches the rank-off and is asserted to agree with `spacingReport`; changes no output today |
| `oneOff.ts` `outcomeOf` fix | **keep** — a real latent bug, see Item 3 |
| `clusterPass` (147 lines) | **delete** — helps nothing, breaks something |

---

# Order

| # | Item | Status |
|---|---|---|
| **0** | Cleanup | ✅ **done** — `3df5fa5` (PR #68) |
| **1** | Guard the `MULT_W` ↔ `CHURN_W` coupling | ✅ **done** — `94b0262` (PR #69), 2 of 3 guards; the behavioural third is `it.todo` with the measurement showing why |
| **2** | Let a constrained season keep the night-order pass | ✅ **built as night classes** — PR #71. The *kind*-narrowing this row originally proposed is false; constraining the permutation is not. PR #70's test survives, its ⛔ gate note does not |
| **3** | Make `slot_bias` winnable | ✅ **justified by measurement** — see below. Not built. |
| **4** | Worst team vs. league total | ✅ **answered — levelling.** Follow-up below |

---

# 0. Cleanup

Branch `spec1c/cluster-in-iceoutcome`, shipped as `3df5fa5` (PR #68).

- Delete `clusterPass` from `slots.ts` and its four tests from `slots.test.ts`.
- Delete the `OBHL_CLUSTER_PASS` env gate and the call site in `assignNights.ts`.
- Keep the `iceOutcome`/`compareIceOutcome` cluster pair, the agreement
  assertions, and the four `compareIceOutcome` ordering tests.
- Keep `oneOff.ts`'s two added lines.
- Write the closed finding above into `SCHEDULE_HANDOFF.md` §5, replacing the
  "some other cause" bullet.

**Done:** `npx vitest run src/lib/schedule` green, typecheck clean, and §5 no
longer poses a question that has been answered.

---

# 1. Guard the `MULT_W` ↔ `CHURN_W` coupling

## Problem

§5 records it: rescaling `MULT_W` or the `SPACING_W` rematch weights requires
rescaling `oneOff.ts`'s churn term **in the same change**, or the repair's sense
of a costly move drifts out of step with generation's. **No test covers it.**

## ⚠️ Correction — an earlier version of this section was wrong

It claimed that adding two fields to `IceOutcome` had made the repair's
comparator evaluate `undefined - undefined` to `NaN` and fall through silently.
**That never happened.** `outcomeOf`'s result never reaches `compareIceOutcome`:
its only consumer is `ICE_METRICS.filter((m) => mine[m] > base[m])`, and
`compareIceOutcome` has exactly one non-test call site — the Phase S rank-off.
The claim was inferred from a TypeScript error rather than traced through the
call sites, then repeated in two commit messages and two PR bodies before a
reviewer caught it.

What is real, and what the guard now targets: `ICE_METRICS` names **4 of the 7**
`IceOutcome` fields, so a repair plan that materially worsens clustering is never
flagged in `plan.worseThan` and never reaches the repair dialog. That exclusion
is now a documented decision at `ICE_METRICS` rather than an accident — §5 says
the generator and repair rank ice time by different rules on purpose.

## The constants, today

| constant | file | value |
|---|---|---|
| `MULT_W` | `matchups.ts:16` | 50 000 |
| `SPACING_W.rematchSameWeek` | `spacing.ts:157` | 120 |
| `SPACING_W.rematchAdjNight` | | 100 |
| `SPACING_W.rematchConsecWeekSameDay` | | 70 |
| `SPACING_W.rematchConsecWeek` | | 40 |
| `CHURN_W.FEWEST` | `oneOff.ts:66` | 5 000 |
| `CHURN_W.SOONEST` | | 200 |
| `CHURN_W.SPACING` | | 1 |

## Build

**(a) Ratio tripwire.** Pin the ratios that carry the intent, each with a comment
naming what it encodes — `CHURN_W.FEWEST / SPACING_W.rematchSameWeek` ≈ 41.7
("disturbing a game outweighs any single rematch penalty"),
`CHURN_W.SOONEST / SPACING_W.rematchConsecWeek` = 5, `MULT_W / CHURN_W.FEWEST`
= 10. Microseconds to run, fails the moment one side is edited alone.

⚠️ Honest limit: it encodes *today's* ratios as intent. If a ratio is itself
wrong, the tripwire freezes the bug. Its comment must say "pinned so that
changing one side is deliberate", never "these ratios are correct".

**(b) Structural guard.** A test that constructs `outcomeOf`'s output and asserts
it carries every key `IceOutcome` declares — so the next field added to the
shared type fails loudly in the repair rather than degrading to `NaN`.

**(c) Behavioural.** A repair fixture where a rematch-spacing gain and a churn
cost are in direct tension, asserting which the repair picks.

## Verify

⛔ (c) proves nothing until it has been **seen** to fail: scale `MULT_W` ×2 with
`CHURN_W` untouched, run it, record the failure, revert. (a) and (b) are
trivially failable.

---

# 2. Let a constrained season keep the night-order pass — ✅ BUILT AS NIGHT CLASSES (PR #71)

The plan was to narrow `resolved.empty` to "no night-indexed requests", so a
league whose only constraint is a `slot_bias` would keep the night-order pass.

**That narrowing is wrong**, and why it is wrong is what the shipped fix is built
on. `SlotBias.nights` is a per-night mask — *"over THESE weeks, lean my games
late"* — and `biasCost` charges only the games whose night index falls inside it.
A permutation relabels which games are in the window, so the cost moves.
`biasCost` is **not** invariant under night permutation.

All four resolved kinds are position-sensitive:

| kind | sensitive to | what `nightClass` puts in the label |
|---|---|---|
| `forced`, `slotPins` | the night index | `FIX${n}` — a class of one |
| `byeInWeek` | the week a night sits in | `W${week}` |
| `biases` | the night-window the request names | one membership bit per bias |

## ⛔ "So the gate cannot be narrowed" does NOT follow — an earlier version of this section said it did

Every kind being position-sensitive rules out narrowing the gate **by constraint
kind**. It says nothing about constraining the **permutation** instead, and that
is the door PR #71 walked through: `nightClass` labels every night, a permutation
may only swap nights carrying the same label, and position-sensitivity then holds
by construction. The cost is one O(nights) comparison folded into the
ice-capacity loop that already runs — not the per-annealing-step constraint
evaluation (~6k steps) that the gate's own comment considered and rejected.

The table above is exactly what makes that sound. The label is correct **only
because it covers all four kinds**; miss one and the pass silently moves a
request off the night it was honoured on.

## Measured

6 teams / one weeknight / 3 sheets / 23 nights, one `slot_on` pinned on night 15:

| | worst team | total windows |
|---|---|---|
| old gate — pass switched off | 15 | — |
| night classes alone | 14 | — |
| night classes + best-of-N restored | 4–5 | 18 |
| unconstrained control | 4 | 17 |

15 → 14 and 15 → 5 measured 2026-09-09 on PR #71; worst 4 / 18 windows and the
control re-measured 2026-09-10, three runs, identical each time. **A constrained
season now spreads ice time at the unconstrained floor.**

## ⚠️ `periodicPass` must NOT run underneath it

Same fixture, 2026-09-10, three runs, identical every time:

| | worst team | total windows |
|---|---|---|
| night classes alone | 4 | 18 |
| night classes **and** `periodicPass` | 6 | 20 |

The two fixes do not compose — the same result §4 and PR #65 measured on
*unconstrained* seasons, now reproduced on the constrained ones `periodicPass`
was written for. `nightClass` lets the night-order pass run everywhere, so the
collision moved with it. See §4.

## What survives from the false premise

⚠️ Had the *kind*-narrowing shipped, the failure would not have been a crash:
`evaluateConstraints` runs afterwards off the final games, so it would have
honestly reported a request as unmet that Phase S had honoured — a silent
downgrade.

PR #70's test — `biasCost` −8 inside the window, 0 after a pure permutation of
the same nights — is what pins the `biases` row of the table, and is the reason
`nightClass` carries a membership bit per bias rather than ignoring them. It
stands. What does not stand is the ⛔ note PR #70 put at the gate saying the gate
could not be narrowed: that note would talk the next reader out of the approach
that works.

---

# 3. Make `slot_bias` winnable without buying it with ice share

## Problem

`SLOT_BIAS_W = 4` (`spacing.ts:311`) against `SHARE_W = 60` (`slots.ts:35`) for
one step of ice share. On a busy constraint set `slot_bias` is the request most
likely to be declined. §7 is explicit that raising the number is the wrong lever
and names the right one: a second Phase S candidate weighted for it.

## The correction that matters

`biasCost` **already reaches** `compareIceOutcome` — `slots.test.ts:151-155`
asserts it. The missing piece is not visibility: a bias-heavy candidate loses the
rank-off whenever it traded anything ranked above bias. **Adding a candidate on
its own does nothing.**

⚠️ And today's probe raises the bar. On the reference season the winner takes it
at 0/0/0/48 — a clean sweep of every metric above bias. A sixth candidate must
match all four *and* beat it on bias, or it never wins.

## Build

1. Thread `slotBiasW` through `assignSlots`'s options, keeping the "one
   definition, two readers" property (`slots.ts:155`).
2. Add a sixth `SLOT_CANDIDATES` entry with a raised `slotBiasW`, **gated on
   `resolved.biases.length > 0`**.
3. `estimatedGenerateMs` takes the bias count the way it already takes
   `opts?.constrained`.

## Cost

`SLOT_BUDGET_MS = 5_000` per candidate; a sixth is **+5 s (+20 %)** on every
generate that runs it. The gate confines that to leagues that asked.

## Verify

- ⛔ **A fixture whose bias is currently declined now reports
  `satisfied === true`.** Without this the feature is cost with nothing to show,
  and it does not merge.
- Ice share on that fixture no worse than before — asserted explicitly, not
  inferred from the comparator's ordering.
- The 8-team reference with no biases **bit-identical**, runtime unchanged.
- Progress estimate matches actual runtime in both cases.

## Traps

- ⛔ Don't raise `SLOT_BIAS_W` globally. That is the rejected trade.
- ⛔ Don't add the term to the descent cost only (`slots.ts:153-156`).

---

## Measured 2026-09-09: biases ARE declined, well short of achievable

6 teams on 3 sheets, 23 nights. Every team plays every night, so the per-night
slot sum is 2·(0+1+2) = 6 and the league mean is exactly 1.0 — the midpoint. At
most **three** teams can sit below it, so 1-3 "early" requests are achievable and
4+ are arithmetically impossible whatever the generator does.

| scenario | satisfied | achievable |
|---|---|---|
| 1 early | 1/1 | 1 |
| 2 early | **1/2** | 2 |
| 3 early | **2/3** | 3 |
| **3 early + 3 late** | **2/6** | **6 — all of them** |

The last row is the finding: three early teams can take all 46 slot-0 seats plus
23 middles for a mean of 0.33, and three late teams the mirror at 1.67. Both
sides clear the midpoint comfortably. The generator delivers 2 of 6, and the
teams that fail land on a mean of *exactly* 1.0 — no lean at all.

That gives this item both a demonstrated problem and the merge condition its
spec demands: **2/6 → 6/6 on a fixture that provably admits a full solution.**

⛔ A warning for whoever builds it: adding the clustering pair to
`compareIceOutcome` made this WORSE — 3-early fell 2/3 → 1/3 — which is why
PR #68 computes the pair without ranking it.

---

# 4. Worst team vs. league total — ✅ ANSWERED: LEVELLING, but ⛔ SUPERSEDED

⛔ **This section measures `periodicPass`, which is being retired.** The levelling
finding below is true and worth keeping as a record of what that pass did. It is
no longer a description of what ships: PR #71's night classes let the night-order
pass run on constrained seasons too, and the two do not compose — night classes
alone reach worst 4 / 18 windows on the 23-night fixture where both together
reach 6 / 20 (§2). The verdict "the trade in PR #65 is a good one" was correct
against the alternative available when it was taken, which was *no clustering fix
at all* for a constrained season. That is no longer the alternative.


Measured 2026-09-09 on the 40-night constrained fixture, per-team clustered
windows re-derived from `scheduledAt`:

| | per-team | worst | total |
|---|---|---|---|
| `periodicPass` off | `[3, 8, 4, **25**, 5, 3]` | 25 | 48 |
| `periodicPass` on | `[11, 9, 11, 9, 9, 9]` | 11 | 58 |

**Levelling, decisively.** One team carried **25 of 48** windows — over half the
league's damage on one of six teams. Afterwards the spread is 9–11, nearly flat.
The rising total is the arithmetic of levelling, not the pass moving a complaint
from one manager to another. Against the alternative of the day — a constrained
season getting no clustering fix at all — the trade was a good one. Night classes
reach worst 4 without the trade, so it is no longer the one on offer.

⚠️ **This fixture varies run to run**, unlike the 8-team reference. A third run
gave `[12, 3, 10, 8, 10, 7]`, worst 12, total 50 — `periodicPass` is wall-clock
bounded, so a single run would have reported 58 or 50 and looked precise.

## Follow-up, not yet built

Add a **bound** on the total to the 40-night test — it currently asserts nothing
about it, so a drift back toward concentration is invisible in the suite, and the
panel showed only the worst-team figure so it was invisible there too — PR #64
now reports the league total alongside it.

⛔ Size the bound off the measured **range**, not one run: worst spans 11–12 and
total spans 50–58, so a pin fails intermittently. Something like
`total <= 70`, `worst <= 16` (the existing worst bound already holds).
