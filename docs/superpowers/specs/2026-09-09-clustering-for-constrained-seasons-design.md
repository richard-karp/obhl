# Ice-time spreading for seasons that carry manager requests

**Date:** 2026-09-09
**Status:** designed, not yet built
**Follows:** `2026-09-09-schedule-variations-design.md` (PR #66), whose §6 parked
three of the four items below.

Every number here was **watched appear** on this machine. Where a claim is a
reading of the code rather than a measurement, it says so in those words.

---

## 1. The gap

Saving a single manager request costs a league most of the ice-time work.

Measured on 6 teams / one weeknight / 3 sheets / 23 weeks, against `main` as it
stands after PR #66 — worst team's five-game stretches carrying the same ice time
three or more times:

| season | worst team | total | request met? |
|---|---|---|---|
| no requests | **4** | 17 | — |
| one pinned ice time (`slot_on`) | **15** | 29 | yes |
| "prefer late", whole season (`slot_bias`) | **17** | 32 | **no** |
| "prefer late", first half only | **14** | 28 | yes |

A manager who adds one request goes from 4 to 15 and is told nothing. Worse, the
natural response to a schedule they dislike — adding a request to nudge it — is
the one action that makes the thing they dislike much worse.

Two separate gates cause it, and both are load-bearing today:

1. **The night-order pass is switched off entirely** when `resolved.empty` is
   false (`assignNights.ts`, the `if (resolved.empty)` around the
   `improveNightOrder` call). Its comment gives the reason and it is a real one:
   a request names a specific night index, no entry in `rankSchedule` encodes
   that, so a permutation can relabel which night holds a pinned block while
   every ranked metric ties. The comment also records that re-checking
   constraints inside admissibility was considered and **rejected as too
   expensive** — a constraint evaluation on each of ~6k annealing steps.
2. **Best-of-N collapses to a single draw** for constrained seasons
   (`variationsFor`'s caller), justified by gate 1: with no clustering repair
   available, ranking four draws on clustering bought nothing.

Gate 2's justification is entirely downstream of gate 1. Lift gate 1 and gate 2
must lift with it, or the fix half-works — measured below.

---

## 2. Night classes: a cheaper admissibility test

The rejected idea was to *evaluate the constraints* per step. The cheap
equivalent is to **forbid the permutations that could break one**, using a label
computed once per generate.

Give every night a class label, and admit only permutations that map each night
to a night of the same class. Node `n`'s games land at position `pos[n]`, so the
test is `nightClass[n] === nightClass[pos[n]]` — O(nights) per step, folded into
the loop that already computes the per-night ice-capacity overflow. No constraint
evaluation anywhere.

The labels come straight from `ResolvedConstraints`:

| field | shape | label effect | why |
|---|---|---|---|
| `forced` | `{team, night, plays}` | night is its own class → a **fixed point** | names one night's participation |
| `slotPins` | `{team, night, slot}` | night is its own class → a **fixed point** | names one night's ice time |
| `byeInWeek` | `{team, week}` | nights in a named week share a class | the week must keep its games |
| `biases` | `{team, nights: boolean[], prefer}` | class carries each bias's membership bit | the window must keep its games |

A bias is **not** invariant under permutation, which is the trap here:
`SlotBias.nights` is a per-night boolean window, so a permutation that moves a
game across the window boundary changes what the bias is scored over. Preserving
the membership bit is what keeps it honest — and a **whole-season** bias has the
same bit on every night, so it costs nothing at all.

With no requests every label is equal, every permutation is admissible, and the
behaviour is exactly today's. The gate becomes a special case rather than a
branch.

**Correctness argument** (a reading, not a measurement): preserving a class means
the multiset of games inside every constrained region is unchanged — a fixed
point keeps its own block; a week keeps its blocks, possibly reordered within
itself; a bias window keeps its blocks. Every constraint is evaluated over one of
those regions, so its verdict cannot change.

---

## 3. Measured effect

Spike: night classes, plus best-of-N restored for constrained seasons. Same
fixture as §1.

| season | today | night classes only | + best-of-N |
|---|---|---|---|
| no requests | 4 | 4 | **4** (unchanged) |
| one pinned ice time | 15 | 14 | **5** |
| "prefer late", whole season | 17 *(unmet)* | 11 | **5** *(and now **met**)* |
| "prefer late", first half | 14 | 10 | **10** |

Three things this says:

- **Night classes alone are nearly worthless** — 15 → 14. The freedom was never
  the binding constraint; the single draw was. Shipping gate 1's fix without
  gate 2's would have looked like a failed change.
- **Together they recover almost everything**: 15 → 5 against an unconstrained
  floor of 4.
- **A partial-window bias is the weak case** (14 → 10) and correctly so: the
  window partitions the season, and nights may only shuffle within their side.
- The whole-season bias going from **unmet to met** is a bonus from best-of-N —
  one of the four draws satisfies a request the single draw could not.

Cost: a constrained generate goes from ~6 s to ~25-29 s, which is what an
unconstrained one already costs. No new cost class.

### A fixture trap worth recording

`bye_on` is **infeasible** on this shape and reports unmet in every column. Six
teams over three sheets means all six play every night, so no team can ever bye.
A measurement built on it says nothing about either gate. It cost a full
measurement round here — see also the `teamId`/`team_id` slip in §5.

---

## 4. The two small items

**Show the number.** The builder's spacing list ends at "Back-to-back games in
the same ice time"; the metric all of this work moves is not displayed at all, so
a manager cannot tell whether the variation they just asked for is better.
`presentSpacing` spreads `...raw`, so both fields already reach the panel — this
is two rows in the existing `[label, count]` tuple array. They go **above**
back-to-back, matching the order variation selection uses.

**Survive a reload.** The variation counter is React state, so a page reload
restarts it at 1 and "Try a different schedule" re-offers a schedule already
rejected. Persist it in `localStorage` keyed by season id — **not** a column on
`seasons`. A migration for a counter is disproportionate, and the value is
per-manager-per-browser scratch, not league data. It must degrade silently:
private windows and cleared site data throw or return null, and a season with no
stored value simply starts at 1.

---

## 5. Scope

**In:**
1. `nightClass` labels; the `improveNightOrder` admissibility test extended;
   the `resolved.empty` gate on the pass removed.
2. Best-of-N restored for constrained seasons (`variationsFor` unconditional).
3. Two clustering rows in the builder panel.
4. `localStorage`-backed variation counter.

**Out:** the Phase M compound pass; clustering inside `compareIceOutcome`;
making the 8-team Mon+Thu league benefit; persisting the counter server-side.

**Why the 8-team league stays out.** It gets nothing from the pass at any restart
count (worst team 17, 94 windows) because permuting nights in a Mon+Thu league
moves games between weekdays and breaks the perfect 18/18 split, which ranks far
above ice time. That split is priority #1. Its clustering is the price of being
perfect on everything above it, and paying it is correct.

---

## 6. Acceptance

1. An unconstrained season is **byte-identical** to `main` — the gate's removal
   must be a no-op when there are no requests.
2. A `slot_on` season reaches worst-team ≤ 8 (measured 5) with the pin still
   satisfied.
3. Every existing constraint test stays green, in particular
   `constraints.test.ts` "a pinned slot survives the clustering pass" — which was
   written to fail if the pass ever moves a pin, and is now the guard for a pass
   that actually runs.
4. Mutation: removing the `nightClass` term from admissibility must turn a
   constraint test red. If it does not, the class test is not load-bearing.
5. The panel renders both clustering rows.
6. `npm test` green 3x; `e2e/11-schedule-builder.spec.ts` green.
