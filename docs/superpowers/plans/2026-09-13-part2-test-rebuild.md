# Audit follow-through, part 2: the finished-app test rebuild

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Cut both suites to what protects the next change on a finished app. Fold the seven verify scripts into e2e, and close the test gaps the audit found.

**Architecture:** The schedule unit tests lose their search-quality bounds and share three calendar builders. Four gaps get value tests, and `applyOneOffGame` starts auditing its successes. The 34 e2e specs become 10 files, built one per task in ascending order; each file keeps one local `admin()` and one `signInAs()`. Three verify scripts are ported and four are mapped to tests that already exist. All seven are then deleted.

**Tech Stack:** Next.js 16 App Router, Supabase Postgres + RLS, Vitest 4, Playwright 1.61.0 (CommonJS e2e tsconfig, Node 22.18).

**Spec:** `docs/worklists/2026-09-13-01yemj-audit-follow-through.md`, sections _Owner decisions, 2026-09-13_ and _Part 2_.

## Global Constraints

- Start from a fresh branch off `main` once part 1 has merged. Never bare `git stash`.
- **Commit only when the owner has approved committing on this branch.** Push and PR only when asked.
- No `.github/workflows/` edits.
- e2e only via `PORT=3101 scripts/e2e-locked.sh <full file names>`, never a glob. The full-suite checkpoints name every file too.
- Nothing `--linked`. `workers: 1` stays.
- The `OBHL_SLOT_RESTARTS`-is-unset test is never deleted: `runs Phase S at the production default, not a test-only one` in `src/lib/schedule/assignNights.test.ts`. No search constant goes into a test config.
- Every new or ported security test is shown red with its guard loosened, then restored.
- RLS refusals asserted on the row read back through `admin()`, never on `error`.
- Find code by symbol or test title, never by line number.
- **Survival rule.** A test stays only if it is one of:
  - (a) the one happy-path smoke of a real flow;
  - (b) an access refusal;
  - (c) a value assertion on scores, standings, stats or three stars;
  - (d) a schedule invariant: every pair plays, no double-booking, per-night sheet capacity, weekday balance ≤ 1, or dates moving with nightIndex;
  - (e) a named data-integrity trap: postponement date, `checkOneOffWrite`, `planRepair`, the audit null-league trap, stale publish, or audit revert.
- A red-proof migration is always `supabase/migrations/0051_tmp_red_proof.sql`. It is deleted before the green run and never committed. `git status --short supabase/migrations` prints nothing at the end of any task.
- Order that must survive the merge (measured 2026-09-13):
  - Spec 22 transfers a goalie and never restores it, and 13's Path 20 counts goalie suggestions. So 22's tests (`10-roster-changes`) must run after 13's (`05-scoring-night`).
  - 21's teardown ignored errors, and a leftover imported league would become 16's `LEAD_OUT`. The merged teardown asserts the delete.
  - 17 creates no league.

## Before you start: confirm part 1 landed

- [ ] Run each and compare:

| Command | Expected |
|---|---|
| `grep -rn "League Update\|AI league summary\|AI game recap" e2e` | no output |
| `grep -c "^test(" e2e/17-roster-import.spec.ts` | `1` |
| `grep -n "a session cannot rewrite its own role or player link through the API" e2e/16-league-membership.spec.ts` | one hit |
| `ls src/lib/import/distribute.test.ts` | `No such file or directory` |
| `ls src/lib/actions/people.test.ts src/lib/utils/logo-type.test.ts` | both listed |
| `ls supabase/migrations/0050_profile_privileged_columns.sql` | listed |

If any row differs, stop: this plan's counts assume part 1's end state.

## File map

| After part 2 | Built from | Task |
|---|---|---|
| `src/lib/schedule/calendars.test-support.ts` | new | 2 |
| `src/lib/utils/three-stars.test.ts` | new | 3 |
| `src/lib/auth/guards.test.ts` | new | 3 |
| `src/lib/safe-next-path.ts`, `src/lib/safe-next-path.test.ts` | the `next` checks in `src/app/auth/confirm/route.ts` and `src/lib/actions/season-context.ts` | 3 |
| `e2e/01-public.spec.ts` | 01, part of 15, part of 27; 25 deleted | 5a |
| `e2e/02-auth.spec.ts` | 02, 24, 26 | 5b |
| `e2e/03-season-setup.spec.ts` | 03, 17, 21, 32 | 5c |
| `e2e/04-rosters.spec.ts` | 04, 06, 18 | 5d |
| `e2e/05-scoring-night.spec.ts` | 05, 12, 13, 33, 34; ports `verify-scoring` | 5e |
| `e2e/07-staff.spec.ts` | 07, 08, 10, 20, one test of 15 | 5f |
| `e2e/09-access.spec.ts` | 09, rest of 15, rest of 27 (5g); 16, ports `verify-auth` and `verify-transfers` #3/#4 (5h) | 5g, 5h |
| `e2e/10-roster-changes.spec.ts` | 19, 22; ports `verify-transfers` #1, #2 and #5 | 5i |
| `e2e/11-schedule-build.spec.ts` | 11, 23, 28, 31 | 5j |
| `e2e/14-schedule-changes.spec.ts` | 14, 29, 30 | 5k |
| _deleted_ | `scripts/verify-*.mjs` ×7 and their `package.json` entries | 6 |

---

### Task 1: Cut the schedule unit tests to invariants

**Files:**
- Modify: `src/lib/schedule/assignNights.test.ts`, `src/lib/schedule/constraints.test.ts`, `src/lib/schedule/participation.test.ts`, `src/lib/schedule/matchups.test.ts`, `src/lib/schedule/roundRobin.test.ts`, `src/lib/schedule/spacing.test.ts`, `src/lib/schedule/slots.test.ts` (one comment pointer)

**Interfaces:**
- Produces nothing. Task 2 replaces the calendar copies that survive this task.

- [ ] **Step 1: Record the baseline**

Run: `npx vitest run src/lib/schedule/assignNights.test.ts src/lib/schedule/constraints.test.ts src/lib/schedule/participation.test.ts src/lib/schedule/matchups.test.ts src/lib/schedule/roundRobin.test.ts src/lib/schedule/spacing.test.ts 2>&1 | tail -6`
Expected: 192 passed (39 + 57 + 20 + 22 + 11 + 43; `constraints.test.ts`'s `it.each` counts twice). Write down the Duration line.

- [ ] **Step 2: Delete the seven named tests**

| File | Test title | Reason |
|---|---|---|
| `constraints.test.ts` | `never picks a draw that honours fewer requests` | Its own comment says it stays green with the term it guards deleted. |
| `constraints.test.ts` | `draws a block, not a single schedule` | Regenerates an earlier fixture. |
| `constraints.test.ts` | `clamps a request above the automatic count` | Guards one `Math.min`. Also delete the now-empty `describe("assignNights — variations can be reduced but never raised")`, its `shortNs`/`shortPairings`/`shortResolved`/`stamps` fixture, and the comment block above it. |
| `assignNights.test.ts` | `is deterministic for a given input` | Duplicates `returns the same schedule for the same seed`. |
| `assignNights.test.ts` | `is the lexicographic minimum of the four seeds it draws from, by the selection order` | Re-implements the private ranking ("Must stay in step with `rankFromReport`"). Also delete `spread`, `rankOf`, `lessOrEqual` and the comments on them. |
| `spacing.test.ts` | `agrees with spacingReport on a generated season` | Also delete the now-empty `describe("iceOutcome")`. |
| `matchups.test.ts` | `holds a pinned game on its slot while the night permutes around it` | A weaker duplicate of `slots.test.ts`'s `holds a pinned game on its ice time while the night permutes around it`. |

- [ ] **Step 3: Strip the quality bounds from `assignNights.test.ts`**

| Test | Assertion to remove | What stays | Then |
|---|---|---|---|
| `balances slot-time share per team (max-min <= 1)` | `expect(max - min).toBeLessThanOrEqual(1);` over `report.slotShareByTeam` | nothing | delete the test |
| `balances weekday and slot share when slots < teams/2 (spilled rounds)` | the `for (const s of report.slotShareByTeam)` loop asserting `toBeLessThanOrEqual(2)`, with its comment | `expect(report.unscheduled).toBe(0);` `expect(report.weekdays.length).toBe(2);` `expect(t.count).toBe(14)` and the `nightShareByTeam` loop's `toBeLessThanOrEqual(1)` | rename to `balances weekday share when slots < teams/2 (spilled rounds)` |
| `gives every team an equal number of byes` | `expect(Math.max(...byes) - Math.min(...byes)).toBe(0);` | nothing: equal byes over one calendar restate equal games per team | delete the test |
| `keeps each team's times balanced and shares the worst time evenly` | both `toBeLessThanOrEqual(1)`: per team, and on `worst` | nothing | delete the test |
| `spreads rematches apart (never on back-to-back game nights)` | `expect(report.minRematchGapNights).not.toBeNull();` `expect(report.minRematchGapNights!).toBeGreaterThanOrEqual(2);` | only `unscheduled` 0, which the first test already asserts | delete the test |
| `satisfies all three bye rules` | `byesMultiWeek`, `byesConsecWeekSameDay`, `byesConsecWeek` `toBe(0)` | nothing | delete the test |
| `gives every team the same 12 byes, split evenly across weekdays` | `expect(byes.length).toBe(12);` `…).toBe(6);` | nothing: both follow from `fills the calendar exactly, 36 games a team` and the 18/18 split | delete the test |
| `never repeats an opponent in the same week or in back-to-back weeks` | the four `rematch*` `toBe(0)` | nothing | delete the test |
| `shares the ice times perfectly evenly (12 of each)` | `expect(s.counts).toEqual([12, 12, 12]);` | nothing | delete the test |
| `goal 1: never byes a team on two game nights in a row` | `byesAdjNight` `toBe(0)`, `longestLayoffDays` `toBe(21)` | nothing | delete the test, and the `// ----` "four goals" comment block above it |
| `goal 2: splits all 28 matchups evenly across weekdays` | `expect(off.length).toBe(0);` `expect(report.spacing.pairingWeekdayExcess).toBe(0);` | only `counts.size` 28, which duplicates `report.pairingCounts.length` 28 | delete the test |
| `goal 3: shares each ice time evenly within each weekday too` | `slotWeekdaySpread` `toBeLessThanOrEqual(8)`, `slotStreak3` `toBe(0)` | nothing | delete the test |
| `goal 4: never runs a team three games deep in one ice time` | `slotStreak3` `toBe(0)`, `slotConsecutive` `toBeLessThanOrEqual(55)` | nothing | delete the test |
| `never returns worse clustering than the plain first draw` | `slotClusterWorstTeam` `toBeLessThanOrEqual(first…)` | nothing | delete the test, `describe("assignNights — best-of-N never trades clustering away")` and the ⛔ comment above it |
| `is unchanged on a season with no requests` | `slotClusterWorstTeam` `toBe(4)`, `slotClusterWindows` `toBe(17)` | nothing | delete the test and its comment |
| `keeps no team far worse off than the rest on ice time` | `toBeLessThanOrEqual(6)` | nothing | delete the test |
| `delivers that clustering through scheduledAt, not just the report` | `expect(derived.slotClusterWorstTeam).toBeLessThanOrEqual(6);` | `expect(derived.slotClusterWorstTeam).toBe(report.spacing.slotClusterWorstTeam);` and `expect(derived.slotClusterWindows).toBe(report.spacing.slotClusterWindows);` | rename to `reports the clustering the stored scheduledAt actually has` |
| `buys that without giving up back-to-backs or runs` | `slotConsecutive` ≤ 6, `slotStreak3` 0, `rematchAdjNight` 0, `rematchConsecWeek` 0 | nothing | delete the test |
| `still gives every team an even share of the three ice times` | `toBeLessThanOrEqual(1)` over `slotShareByTeam` | nothing | delete the test |

These invariant assertions stay exactly as they are:
- `schedules all 6-team games, no team twice a night, 5 games each`: `expect(set.has(g.home)).toBe(false);` and `expect(t.count).toBe(5)`.
- `handles 7 teams (byes) without scheduling a team twice a night` and `never books a team twice on one night`: the same `set.has` pair.
- `balances games per night-of-week across two weekly nights (max-min <= 1)`: `expect(max - min).toBeLessThanOrEqual(1);` over `report.nightShareByTeam`.
- `gives every team a perfectly even weekday split (18 Mon / 18 Thu)`: `expect(n.counts).toEqual([18, 18])`. With 36 games over two weekdays this is exactly weekday balance ≤ 1.
- `keeps opponents balanced — 36 games over 7 opponents is 5s and one 6` (every pair plays), and `fills the calendar exactly, 36 games a team`.
- `moves scheduledAt with nightIndex`: `expect(g.scheduledAt.slice(0, 10)).toBe(ns[g.nightIndex].date);`
- `never stamps an ice time its night does not have`, `places the whole season`, `reports unscheduled games when capacity is insufficient`.
- The three seed tests, `returns a schedule that is actually one of the four` and `variation 2 draws a different block than variation 1` are not bounds, and stay untouched.

- [ ] **Step 4: Strip the quality bounds from the other four files**

`constraints.test.ts`:

| Test | Assertion to remove | What stays | Then |
|---|---|---|---|
| `spreads ice time nearly as well as an unconstrained season` | `slotClusterWorstTeam` `toBeLessThanOrEqual(8)` | nothing | delete the test and its ⛔ comment block |
| `does not force Phase P for a bias-only set` | `biased.spacing.byesConsecWeek` and `byesMultiWeek` `toBeLessThanOrEqual(bare…)` | nothing | delete the test |

These stay: `invariant 1: total games per team is untouched` (`expect(t.count).toBe(12)`), `invariant 2: games per night is untouched` (`expect(perNight).toEqual(new Array(ns.length).fill(3));` and `expect(new Set(on).size).toBe(on.length);`), and `invariant 3: each pair meets exactly as often as it was asked to` (`expect(got).toEqual(want);`). So do the constraint-satisfaction tests: `keeps the whole week off it was asked for`, `keeps the pinned slot_on satisfied`, `keeps the pin satisfied`, and `a %s request survives the night-order pass`.

`participation.test.ts`:

| Test | Assertion to remove | What stays | Then |
|---|---|---|---|
| `splits weekdays evenly and keeps byes out of consecutive weeks` | `byeMultiWeek`, `byeConsecWeek`, `byeConsecWeekSameDay` `toBe(0)` | `not.toBeNull()`, `expect(res!.weekdaySpread).toBe(0);` | rename to `splits weekdays evenly` |
| `solves with the per-weekday quotas left unpinned` | `expect(res!.byeMultiWeek).toBe(0);` | not-null, row sums 18, per-night `2 * n.games`, `weekdaySpread` 0 | — |
| `still solves when a holiday gap splits the season into two runs` | `byeConsecWeek` `toBe(0)`, `byeAdjNight` `toBe(0)` and the comment above the latter | not-null, `weekdaySpread` 0 | — |
| `counts back-to-back byes on a single-weekday calendar` | `byeAdjNight` `toBe(0)`, `byeConsecWeek` `toBe(0)` and the comment above them | not-null, row sums 12, `weekdaySpread` 0 | rename to `solves a single-weekday calendar` |
| `trades rule 2 for rule 4 when a bye every week leaves no other option` | `byeMultiWeek` `toBe(0)`, `byeAdjNight` `toBeLessThanOrEqual(8)`, `byeConsecWeekSameDay` `toBeGreaterThan(0)` and the "Bounds, not exact values" comment | not-null, `weekdaySpread` 0 | rename to `still splits weekdays evenly when every team byes every week` |
| `solves the same calendar once the weekday target is loosened` | `expect(Math.max(...spreads)).toBe(3);` `expect(spreads.filter((s) => s === 3).length).toBe(2);` the `spreads` computation and its comment | not-null, `expect(row.filter(Boolean).length).toBe(9)` | — |
| `lands a forced bye's weekday cost on as few other teams as the totals allow` | `expect(others.filter((s) => s !== 0).length).toBeLessThanOrEqual(1);` with `spreadOf` and `others` | not-null, the four `expect(res.plays[0][night]).toBe(false)`, `expectStructureHolds(res.plays, opts.nights, 18)` | rename to `puts four forced byes on one weekday once the band widens by a game`; delete the docblock above it, which explains only the removed bound |

These stay: `honours the games-per-team row sums and per-night bye quotas` (`expect(row.filter(Boolean).length).toBe(18)` and `expect(playing).toBe(2 * n.games)`), and every `expectStructureHolds` call.

`matchups.test.ts`:

| Test | Assertion to remove | What stays | Then |
|---|---|---|---|
| `splits every pairing evenly over three weekdays` | `expect(off).toBe(0);` `expect(excess).toBe(0);` | `multiplicityError` 0, `expect(pairs).toBe(15);` | rename to `meets every target over three weekdays` |
| `splits every pairing proportionally when the weekdays run unequally` | `off` 0, `excess` 0, the `countsByWeekday(...)` `toEqual([2, 1])` loop and its comments | the two night-count premises (10 and 5), `multiplicityError` 0 | rename to `meets every target when the weekdays run unequally` |
| `does not buy the weekday split with rematch spacing` | `r.sameWeek` 0, `r.adjNight` 0 | nothing | delete the test and the `rematchCounts` helper |
| `shares the ice times evenly across teams` | `toBeLessThanOrEqual(1)` over `share` | nothing | delete the test |
| `splits the ice times as evenly as it can within each of three weekdays` | the floor bounds, the blind comparison, `streak3` ≤ 1 | nothing | delete the test |
| `splits them as evenly within each of two weekdays` | the floor bounds, the blind comparison, `streak3` 0 | nothing | delete the test |
| `does not double-count the season share on a single-weekday cadence` | `floor` 0, `aware.weekdaySpread` 0, `aware` equals `seasonSpread` | nothing | delete the test |
| `reaches the flattest split allowed when the weekdays run unequally` | the floor bounds, the blind comparison, `streak3` 0 | nothing | delete the test |
| `takes the three-game-run weight as an option` | `expect(a.aware.weekdaySpread).not.toBe(b.aware.weekdaySpread);` | nothing: two search results differing is search luck | delete the test |
| `targets the ice a night actually has, not a uniform share of it` | `floor` `toBeGreaterThan(0)`, the blind comparison | nothing | delete the test |
| `still works, and stays season-flat, when no weekdays are given` | `expect(slotMetrics(T, pairsByNight, slotOf, wd, 3).seasonSpread).toBe(0);` | `expect([...slots].sort()).toEqual(pairsByNight[n].map((_, gi) => gi))` | rename to `still gives each night a valid ice-time permutation when no weekdays are given` |

Then delete `weekdayFloor`, `slotMetrics`, `run`, the long docblock above `describe("assignSlots weekday split")`, and the `proportionalSplit` import. Rename that describe to `assignSlots without weekdays`. Keep `slotCadence`, `BOUNDED`, `countsByWeekday`, `pairingExcess` and `weekdayExcessScaled`.

These stay: `hits the requested meeting counts exactly` (`expect(counts(T, res!.pairsByNight)).toEqual(targets);`), `plays exactly the teams the participation matrix says, once each` (`expect(new Set(seen).size).toBe(seen.length);`), and `uses each of a night's slots exactly once` (`expect([...slots].sort()).toEqual([0, 1, 2]);`). So does `is a no-op on a single-weekday cadence rather than double-counting it`: its `excess` of 0 is definitional, not a search result.

`roundRobin.test.ts`:

| Test | Assertion to remove | What stays | Then |
|---|---|---|---|
| `home/away counts are roughly balanced (diff <= 2)` | `toBeLessThanOrEqual(2)` | nothing | delete the test |

The four spread assertions in `roundRobinRounds` and `buildBalancedPairings` stay. They pin the construction the generator is handed (every pair plays, equal games), not a search.

- [ ] **Step 5: Lint away the stragglers**

Run: `npx eslint src/lib/schedule/assignNights.test.ts src/lib/schedule/constraints.test.ts src/lib/schedule/participation.test.ts src/lib/schedule/matchups.test.ts src/lib/schedule/roundRobin.test.ts src/lib/schedule/spacing.test.ts`

Delete every import or declaration it reports unused, and repeat until it reports none. Expected reports:
- `assignNights.test.ts`: `weekdayOf`, `weekdayExcessScaled`.
- `spacing.test.ts`: the `assignNights` value import (keep `type Night`), `buildBalancedPairings`, `enumerateNights`.

- [ ] **Step 6: Verify nothing points at a deleted test**

Run: `grep -rn -E "assignSlots weekday split|best-of-N never trades clustering|variations can be reduced but never raised|never picks a draw that honours|agrees with spacingReport|is the lexicographic minimum|goal [1-4]: " src e2e AGENTS.md`

Expected: one hit, the header docblock of `src/lib/schedule/slots.test.ts` pointing at `describe("assignSlots weekday split")`. Delete that clause, which is a comment-only edit, and re-run: no output. Handle any other hit the same way: delete the pointer, never the code.

- [ ] **Step 7: Run the six files**

Run: `npx vitest run src/lib/schedule/assignNights.test.ts src/lib/schedule/constraints.test.ts src/lib/schedule/participation.test.ts src/lib/schedule/matchups.test.ts src/lib/schedule/roundRobin.test.ts src/lib/schedule/spacing.test.ts`
Expected: 157 passed (20 + 52 + 20 + 13 + 10 + 42).

Run: `grep -n "runs Phase S at the production default, not a test-only one" src/lib/schedule/assignNights.test.ts`
Expected: one hit.

- [ ] **Step 8: Commit (only if approved)**

```bash
git add src/lib/schedule
git commit -m "test(schedule): cut the generator tests to invariants"
```

---

### Task 2: One module for the shared calendars

**Files:**
- Create: `src/lib/schedule/calendars.test-support.ts`
- Modify: `src/lib/schedule/assignNights.test.ts`, `src/lib/schedule/constraints.test.ts`, `src/lib/schedule/oneOff.test.ts`

**Interfaces:**
- Produces: `twoNightsPerWeek(weeks: number, slots?: string[]): Night[]`, `sixTeamTuesdays(maxNights: number): Night[]`, `eightTeamMonThu(maxNights: number, excluded?: string[]): Night[]`.

**Background (measured):** the seed leagues are `obhl` (Oceanview, 6 teams, Tue+Thu) and `harbor` (4 teams), so these calendars are named by their shape. After Task 1 the copies left are:
- the 6-team Tuesday calendar ×5: 3 in `assignNights`, 2 in `constraints`;
- the 8-team Mon+Thu calendar ×2: 1 in each of those files;
- `twoNightsPerWeek` ×2: `assignNights` and `oneOff`.

The file name does not match vitest's `include` (`src/**/*.test.ts`), so it is imported, never collected.

- [ ] **Step 1: Record the counts to hold**

Run: `npx vitest run src/lib/schedule/oneOff.test.ts 2>&1 | tail -4`
Write down the passed count. The six Task 1 files hold 157.

- [ ] **Step 2: Create the module**

Create `src/lib/schedule/calendars.test-support.ts`:

```ts
/**
 * The calendars the schedule tests build over and over, named by shape.
 * Imported by tests only; `vitest.config.ts` collects `*.test.ts`, not this.
 */
import type { Night } from "./assignNights";
import { enumerateNights } from "./capacity";

const THREE_SHEETS = ["19:00", "20:15", "21:30"];

/** Tuesday and Thursday for `weeks` weeks from Tue 2026-09-01, in order. */
export function twoNightsPerWeek(
  weeks: number,
  slots: string[] = THREE_SHEETS,
): Night[] {
  const ns: Night[] = [];
  const base = Date.UTC(2026, 8, 1);
  for (let w = 0; w < weeks; w++) {
    for (const off of [0, 2]) {
      const d = new Date(base + (w * 7 + off) * 86400000);
      ns.push({ date: d.toISOString().slice(0, 10), slots });
    }
  }
  return ns;
}

/** One Tuesday a week from 2026-09-08 on three sheets: six teams all play every week. */
export function sixTeamTuesdays(maxNights: number): Night[] {
  return enumerateNights("2026-09-08", {
    weekdays: new Set([2]),
    slotTimes: THREE_SHEETS,
    excluded: new Set<string>(),
    maxNights,
  });
}

/** Monday and Thursday from 2026-09-10 on three sheets: eight teams, two byes a night. */
export function eightTeamMonThu(
  maxNights: number,
  excluded: string[] = [],
): Night[] {
  return enumerateNights("2026-09-10", {
    weekdays: new Set([1, 4]),
    slotTimes: THREE_SHEETS,
    excluded: new Set(excluded),
    maxNights,
  });
}
```

- [ ] **Step 3: Replace the copies**

| File | Replace | With |
|---|---|---|
| `assignNights.test.ts` | the local `function twoNightsPerWeek(…)` and its comment | `import { eightTeamMonThu, sixTeamTuesdays, twoNightsPerWeek } from "./calendars.test-support";` (existing calls unchanged) |
| `assignNights.test.ts` | `describe("assignNights — full-season reference schedule")`'s `enumerateNights("2026-09-10", {…maxNights: 48})` | `eightTeamMonThu(48, ["2026-12-21", "2026-12-24", "2026-12-28", "2026-12-31", "2027-03-04"])` |
| `assignNights.test.ts` | the `enumerateNights("2026-09-08", {…maxNights: 23})` in `describe("assignNights — seeds produce different schedules")` | `sixTeamTuesdays(23)` |
| `assignNights.test.ts` | the `enumerateNights("2026-09-08", {…maxNights: 10})` in `describe("assignNights — a variation is the best of its block")` | `sixTeamTuesdays(10)` |
| `assignNights.test.ts` | the `enumerateNights("2026-09-08", { …slotTimes: SLOT_TIMES… maxNights: 23 })` in `describe("assignNights — ice-time clustering, 6 teams on one weeknight")` | `sixTeamTuesdays(23)` (keep `SLOT_TIMES`: `fromScheduledAt` reads it) |
| `constraints.test.ts` | `describe("assignNights with manager constraints")`'s `enumerateNights("2026-09-10", {…maxNights: 16})` | `eightTeamMonThu(16)` |
| `constraints.test.ts` | the `enumerateNights("2026-09-08", {…maxNights: 23})` in `describe("assignNights — a pinned slot survives the clustering pass")` | `sixTeamTuesdays(23)` |
| `constraints.test.ts` | the `enumerateNights("2026-09-08", {…maxNights: 23})` in `describe("assignNights — a constrained season still gets its ice time spread")` | `sixTeamTuesdays(23)` |
| `oneOff.test.ts` | the local `function twoNightsPerWeek(weeks: number)` and its docblock | `import { twoNightsPerWeek } from "./calendars.test-support";` |

Add the matching import to `constraints.test.ts`: `import { eightTeamMonThu, sixTeamTuesdays } from "./calendars.test-support";`

Run: `npx eslint src/lib/schedule/assignNights.test.ts src/lib/schedule/constraints.test.ts src/lib/schedule/oneOff.test.ts`
Expected: `enumerateNights` reported unused in `assignNights.test.ts` and `constraints.test.ts`, and possibly `SLOTS` in `oneOff.test.ts`. Delete what it reports; re-run until clean.

- [ ] **Step 4: Confirm nothing is left and the counts held**

Run: `grep -rn "function twoNightsPerWeek\|enumerateNights(\"2026-09-08\"\|enumerateNights(\"2026-09-10\"" src/lib/schedule --include=*.test.ts`
Expected: no output.

Run: `npx vitest run src/lib/schedule 2>&1 | tail -6`
Expected: every file passes. The six Task 1 files still hold 157, and `oneOff.test.ts` holds the Step 1 count.

- [ ] **Step 5: Record the suite time against the 250 s baseline**

Run: `npm test 2>&1 | tail -6`
Write down the Tests and Duration lines. They are compared with the 2026-09-13 baseline (51 files, 643 passed + 1 todo, 250.7 s) in Task 7's report. Reported, not gated.

- [ ] **Step 6: Commit (only if approved)**

```bash
git add src/lib/schedule
git commit -m "test(schedule): share the calendar builders"
```

---

### Task 3: Unit tests outside the schedule

**Files:**
- Modify: `src/lib/actions/revalidate-paths.test.ts`, `src/lib/games/finalize.test.ts`, `src/app/auth/confirm/route.ts`, `src/lib/actions/season-context.ts`
- Create: `src/lib/utils/three-stars.test.ts`, `src/lib/auth/guards.test.ts`, `src/lib/safe-next-path.ts`, `src/lib/safe-next-path.test.ts`

**Interfaces:**
- Produces: `safeNextPath(raw: string | null | undefined, fallback: string): string`.

**Background (read 2026-09-13, and it corrects the design):** the design said to share the `next` check "once their fallbacks are confirmed equal". They are not equal:
- `/auth/confirm` falls back to `"/"`;
- `selectSeason` falls back to `` `/${slug}/dashboard` ``.

The parsing logic is identical in both, so the shared function takes the fallback as a parameter. Each call site keeps its own fallback, and behaviour does not change.

- [ ] **Step 1: Drop the temp-route-tree test**

In `src/lib/actions/revalidate-paths.test.ts`, delete `it("maps every App Router directory convention to the right URL", …)`. The app has no intercepting, parallel or catch-all routes. Then run `npx eslint src/lib/actions/revalidate-paths.test.ts` and delete the imports it reports unused. Expected: `mkdirSync`, `mkdtempSync`, `rmSync`, `writeFileSync` and `tmpdir`.

Run: `npx vitest run src/lib/actions/revalidate-paths.test.ts`
Expected: 7 passed.

- [ ] **Step 2: Three stars get a value test**

Create `src/lib/utils/three-stars.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { computeThreeStars } from "./three-stars";

const row = (
  player_id: string | null,
  goals: number,
  assists: number,
  pim: number,
) => ({
  player_id,
  first_name: "F",
  last_name: player_id ?? "none",
  goals,
  assists,
  pim,
});

describe("computeThreeStars", () => {
  it("scores a goal 3, an assist 2 and a penalty minute -1, and keeps the top three", () => {
    const stars = computeThreeStars([
      row("p1", 1, 1, 2), // 3
      row("p2", 0, 0, 0), // 0
      row("p3", 2, 1, 0), // 8
      row("p4", 0, 2, 0), // 4
    ]);
    expect(stars).toEqual([
      { player_id: "p3", first_name: "F", last_name: "p3", g: 2, a: 1, pim: 0, score: 8 },
      { player_id: "p4", first_name: "F", last_name: "p4", g: 0, a: 2, pim: 0, score: 4 },
      { player_id: "p1", first_name: "F", last_name: "p1", g: 1, a: 1, pim: 2, score: 3 },
    ]);
  });

  it("breaks a tied score on goals, then on assists", () => {
    const stars = computeThreeStars([
      row("zero-goals", 0, 3, 0), // 6
      row("one-goal-two-assists", 1, 2, 1), // 6
      row("two-goals", 2, 0, 0), // 6
      row("one-goal-three-assists", 1, 3, 3), // 6
    ]);
    expect(stars.map((s) => s.score)).toEqual([6, 6, 6]);
    expect(stars.map((s) => s.player_id)).toEqual([
      "two-goals",
      "one-goal-three-assists",
      "one-goal-two-assists",
    ]);
  });

  it("leaves out a row with no player, however many points it has", () => {
    const stars = computeThreeStars([row(null, 5, 0, 0), row("p1", 0, 1, 0)]);
    expect(stars.map((s) => s.player_id)).toEqual(["p1"]);
  });
});
```

Run: `npx vitest run src/lib/utils/three-stars.test.ts`
Expected: 3 passed.

Prove it can fail. In `src/lib/utils/three-stars.ts`, change `score: r.goals * 3 + r.assists * 2 - r.pim` to `score: r.goals * 2 + r.assists * 2 - r.pim`, and re-run. Expected: the first two tests FAIL. Then change `b.g - a.g` to `a.g - b.g`, restoring the score first, and re-run. Expected: `breaks a tied score on goals, then on assists` FAILS. Restore both edits and re-run: 3 passed. `git diff src/lib/utils/three-stars.ts` prints nothing.

- [ ] **Step 3: Finalize's goal totals get a value assertion**

In `src/lib/games/finalize.test.ts`:

1. Change the `fakeClient` signature and its two `opts` uses:

```ts
function fakeClient(
  updated: Array<{ id: string }>,
  opts?: { gameMissing?: boolean; rosters?: unknown[]; updates?: unknown[] },
) {
```

2. In `settle`, change the `game_rosters` branch to return `opts?.rosters ??` in front of the existing one-home-goal array: `data: opts?.rosters ?? [ { team_id: "home", goals: 1, … } ],` (the existing literal unchanged).

3. Change the `update` arm of the proxy to record its payload:

```ts
          if (prop === "update") {
            isUpdate = true;
            return (payload: unknown) => {
              opts?.updates?.push(payload);
              return chainable;
            };
          }
```

4. Append inside `describe("finalizeGameById", …)`:

```ts
  it("writes each side's score as the sum of its roster's goals", async () => {
    const updates: unknown[] = [];
    const line = (
      team_id: string,
      player_id: string,
      goals: number | null,
      is_substitute = false,
    ) => ({
      team_id,
      goals,
      assists: 0,
      pim: 0,
      is_substitute,
      player_id,
      players: { first_name: "A", last_name: player_id },
    });
    await finalizeGameById(
      "g1",
      "u1",
      fakeClient([{ id: "g1" }], {
        updates,
        rosters: [
          line("home", "h1", 2),
          line("home", "h2", 1),
          line("home", "h3", 1, true), // a substitute's goal still counts for the side
          line("away", "a1", 1),
          line("away", "a2", null),
        ],
      }),
    );
    expect(updates).toHaveLength(1);
    expect(updates[0]).toMatchObject({
      status: "final",
      home_goals: 4,
      away_goals: 1,
    });
    expect(logAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "finalize_game",
        new_data: { home_goals: 4, away_goals: 1 },
      }),
    );
  });
```

Run: `npx vitest run src/lib/games/finalize.test.ts`
Expected: 5 passed.

Prove it can fail. In `src/lib/games/finalize.ts`'s UPDATE payload, change `home_goals: sum(game.home_team_id),` to `home_goals: sum(game.away_team_id),` and re-run. Expected: the new test FAILS on `home_goals`. Restore it and re-run: 5 passed.

- [ ] **Step 4: The guards get a unit test**

Create `src/lib/auth/guards.test.ts`:

```ts
/**
 * `guards.ts` with its lookups stubbed. `redirect` and `notFound` throw, as they
 * do in Next, so a refusal is an exception naming where it sends the caller.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { SessionUser } from "./session";
import type { OfficeTier } from "./office";

const getSessionUser = vi.fn<() => Promise<SessionUser | null>>();
const isLeagueMember =
  vi.fn<(profileId: string, leagueId: string | null | undefined) => Promise<boolean>>();
const officeTierOf = vi.fn<(profileId: string) => Promise<OfficeTier | null>>();

vi.mock("next/navigation", () => ({
  redirect: (to: string) => {
    throw new Error(`REDIRECT ${to}`);
  },
  notFound: () => {
    throw new Error("NOT_FOUND");
  },
}));
vi.mock("./session", () => ({ getSessionUser: () => getSessionUser() }));
vi.mock("./membership", () => ({
  isLeagueMember: (p: string, l: string | null | undefined) => isLeagueMember(p, l),
}));
vi.mock("./office", () => ({ officeTierOf: (p: string) => officeTierOf(p) }));
vi.mock("@/lib/league/visibility", () => ({
  decideLeagueVisible: (isPublic: boolean, isMember: boolean) =>
    isPublic || isMember,
}));

import {
  requireCommissioner,
  requireLeagueManager,
  requireLeagueManagerOf,
} from "./guards";

/** Exactly the picker. `/login` also starts with "/", so a substring would pass it. */
const TO_PICKER = /^REDIRECT \/$/;

const manager: SessionUser = {
  id: "mgr-1",
  email: "manager@example.test",
  role: "league_manager",
};

beforeEach(() => {
  vi.clearAllMocks();
  getSessionUser.mockResolvedValue(manager);
  isLeagueMember.mockResolvedValue(true);
  officeTierOf.mockResolvedValue(null);
});

describe("requireLeagueManager", () => {
  it("refuses the right role without membership of the league", async () => {
    isLeagueMember.mockResolvedValue(false);
    await expect(requireLeagueManager("league-b")).rejects.toThrow(TO_PICKER);
    expect(isLeagueMember).toHaveBeenCalledWith("mgr-1", "league-b");
  });
});

describe("requireLeagueManagerOf", () => {
  it("refuses ids that name different leagues, before asking about membership", async () => {
    await expect(
      requireLeagueManagerOf(
        async () => "league-a",
        async () => "league-b",
      ),
    ).rejects.toThrow(TO_PICKER);
    expect(isLeagueMember).not.toHaveBeenCalled();
  });

  it("refuses an id that resolves to no league", async () => {
    await expect(requireLeagueManagerOf(async () => null)).rejects.toThrow(
      TO_PICKER,
    );
    expect(isLeagueMember).not.toHaveBeenCalled();
  });

  it("admits a manager when every id names a league they belong to", async () => {
    await expect(
      requireLeagueManagerOf(
        async () => "league-a",
        async () => "league-a",
      ),
    ).resolves.toEqual(manager);
    expect(isLeagueMember).toHaveBeenCalledWith("mgr-1", "league-a");
  });
});

describe("requireCommissioner", () => {
  it("refuses a deputy", async () => {
    officeTierOf.mockResolvedValue("deputy");
    await expect(requireCommissioner()).rejects.toThrow(TO_PICKER);
  });

  it("admits a commissioner", async () => {
    officeTierOf.mockResolvedValue("commissioner");
    await expect(requireCommissioner()).resolves.toEqual(manager);
  });
});
```

Run: `npx vitest run src/lib/auth/guards.test.ts`
Expected: 6 passed.

Show each refusal red with its guard loosened. Edit `src/lib/auth/guards.ts` once per row, run, confirm the named test FAILS, then restore before the next row:

| Loosen | Expected FAIL |
|---|---|
| In `requireLeagueRole`, delete the line `if (!(await isLeagueMember(user.id, await resolveLeague(league))))` and the `redirect("/");` under it | `refuses the right role without membership of the league` |
| In `requireLeagueManagerOf`, change `if (!first \|\| rest.some((id) => id !== first)) redirect("/");` to `if (!first) redirect("/");` | `refuses ids that name different leagues, before asking about membership` |
| In `requireLeagueManagerOf`, change the same line to `if (rest.some((id) => id !== first)) redirect("/");` | `refuses an id that resolves to no league` |
| In `requireCommissioner`, change `!== "commissioner"` to `=== null` | `refuses a deputy` |

After the last row: `git diff src/lib/auth/guards.ts` prints nothing, and the file runs 6 passed.

- [ ] **Step 5: Write the failing `safeNextPath` test**

Create `src/lib/safe-next-path.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { safeNextPath } from "./safe-next-path";

const FALLBACK = "/fallback";

describe("safeNextPath", () => {
  it("keeps a same-origin path and its query", () => {
    expect(safeNextPath("/obhl/schedule?view=results", FALLBACK)).toBe(
      "/obhl/schedule?view=results",
    );
  });

  it("returns what the parser made of the path, not the raw string", () => {
    expect(safeNextPath("/a/../b", FALLBACK)).toBe("/b");
    expect(safeNextPath("/obhl#section", FALLBACK)).toBe("/obhl");
  });

  it.each([
    ["a protocol-relative URL", "//evil.com"],
    ["a backslash the parser folds into a slash", "/\\evil.com"],
    ["a tab the parser strips before parsing", "/\t\\evil.com"],
    ["a newline the parser strips before parsing", "/\n/evil.com"],
    ["an absolute URL", "https://evil.com"],
    ["an empty string", ""],
  ])("falls back on %s", (_label, raw) => {
    expect(safeNextPath(raw, FALLBACK)).toBe(FALLBACK);
  });

  it("falls back when there is no value at all", () => {
    expect(safeNextPath(null, FALLBACK)).toBe(FALLBACK);
    expect(safeNextPath(undefined, FALLBACK)).toBe(FALLBACK);
  });
});
```

Run: `npx vitest run src/lib/safe-next-path.test.ts`
Expected: FAIL, because `./safe-next-path` cannot be resolved.

- [ ] **Step 6: Implement it and use it at both call sites**

Create `src/lib/safe-next-path.ts`:

```ts
/**
 * A redirect target that stays on this site, or `fallback`.
 *
 * ⛔ Decided by the URL parser, not by inspecting characters: the parser folds
 * `\` into `/` and strips tab/CR/LF first, which every hand-written check missed.
 */
export function safeNextPath(
  raw: string | null | undefined,
  fallback: string,
): string {
  if (!raw || !raw.startsWith("/")) return fallback;
  try {
    const probe = new URL(raw, "http://a.invalid");
    return probe.origin === "http://a.invalid"
      ? probe.pathname + probe.search
      : fallback;
  } catch {
    return fallback;
  }
}
```

In `src/app/auth/confirm/route.ts`, add `import { safeNextPath } from "@/lib/safe-next-path";`. Replace everything from the comment `// Only allow same-origin relative paths` through the closing `}` of the `if (rawNext.startsWith("/")) { … }` block with:

```ts
  // No league-agnostic dashboard exists and a magic link cannot know which
  // league was meant, so both the default and the fallback are the picker.
  const next = safeNextPath(searchParams.get("next"), "/");
```

A missing `next` used to become `"/"` and parse to `"/"`. It now falls back to `"/"`: the same answer.

In `src/lib/actions/season-context.ts`, add `import { safeNextPath } from "@/lib/safe-next-path";`. Replace from `const raw = String(formData.get("next") ?? "");` through the closing `}` of the `if (raw.startsWith("/")) { … }` block, including the comments between, with:

```ts
  // Same-origin relative paths only, so a hand-made form cannot turn the
  // switcher into an open redirect. Not reachable cross-site today.
  const next = safeNextPath(
    String(formData.get("next") ?? ""),
    `/${slug}/dashboard`,
  );
```

Run: `npx vitest run src/lib/safe-next-path.test.ts`
Expected: 9 passed.

Run: `grep -rn "a.invalid" src --include=*.ts --include=*.tsx | grep -v safe-next-path`
Expected: no output.

Run: `npx tsc --noEmit && npx eslint src/lib/safe-next-path.ts src/app/auth/confirm/route.ts src/lib/actions/season-context.ts && npx vitest run src/lib/actions/league-guards.test.ts src/lib/actions/revalidate-paths.test.ts`
Expected: no errors; both files pass.

- [ ] **Step 7: Commit (only if approved)**

```bash
git add src/lib/utils/three-stars.test.ts src/lib/games/finalize.test.ts src/lib/auth/guards.test.ts src/lib/safe-next-path.ts src/lib/safe-next-path.test.ts src/app/auth/confirm/route.ts src/lib/actions/season-context.ts src/lib/actions/revalidate-paths.test.ts
git commit -m "test: value tests for three stars, finalize totals and the guards; one next-path check"
```

---

### Task 4: `applyOneOffGame` audits a successful write

**Files:**
- Modify: `src/lib/actions/schedule.ts` (`applyOneOffGame`), `src/app/[league]/(manage)/audit/page.tsx` (`entryLabel`), `e2e/14-one-off-game.spec.ts`

**Interfaces:**
- Produces: audit action `schedule_one_off`, `entity_type: "season"`, `new_data: { date, label, games_rewritten }`. Task 5k moves the e2e assertion into `14-schedule-changes`.

**Background (measured):**
- `writeGames` audits only failures, as `` `${action}_failed` `` (`auditFailure` in `src/lib/schedule/writeGames.ts`). Logging `schedule_one_off` on success therefore cannot double-log.
- `logAudit` resolves the league from `entity_type: "season"`, as `applyScheduleRepair`'s `repair_schedule` entry already does.
- `entryLabel` has no `schedule_one_off` case, so an entry would render as the bare "schedule one off".

- [ ] **Step 1: Write the failing assertion**

In `e2e/14-one-off-game.spec.ts`, in `manager can schedule a one-off and pick how the season absorbs it`, append after the final `await expect(page.getByText(/Scheduled the game|Labelled the game/)).toBeVisible({ timeout: 30000 });`:

```ts
    // The success is audited, under this league. An entry filed under a null
    // league is hidden from every view that would show it.
    const db = admin();
    const { data: league } = await db
      .from("leagues")
      .select("id")
      .eq("slug", "obhl")
      .single();
    const { data: season } = await db
      .from("seasons")
      .select("id")
      .eq("league_id", league!.id)
      .eq("name", SEASON)
      .single();
    const { data: entries } = await db
      .from("audit_log")
      .select("league_id")
      .eq("action", "schedule_one_off")
      .eq("entity_id", season!.id);
    expect(entries, "a one-off that landed wrote no audit entry").toHaveLength(1);
    expect(entries![0].league_id).toBe(league!.id);

    await page.goto("/obhl/audit");
    await expect(
      page.getByText(/Scheduled a one-off game on \d{4}-\d{2}-\d{2}/).first(),
    ).toBeVisible();
```

Run: `PORT=3101 scripts/e2e-locked.sh e2e/14-one-off-game.spec.ts`
Expected: FAIL at `a one-off that landed wrote no audit entry` (received length 0). `scorekeeper cannot reach the one-off page` passes.

- [ ] **Step 2: Implement**

In `src/lib/actions/schedule.ts`, inside `applyOneOffGame`, insert directly after `if (problem) return { ok: false, message: problem };`:

```ts
  // Filed under the season, which `logAudit` resolves to its league — the same
  // shape as `repair_schedule`. `writeGames` audits only the failures.
  await logAudit({
    user_id: manager.id,
    action: "schedule_one_off",
    entity_type: "season",
    entity_id: seasonId,
    old_data: { nights: input.changes.map((c) => c.date) },
    new_data: {
      date: input.date,
      label: input.label,
      games_rewritten: rows.length,
    },
  });
```

In the same function, the five `revalidatePath` calls contain `revalidatePath("/[league]/schedule", "page");` twice in a row. Delete one.

In `src/app/[league]/(manage)/audit/page.tsx`, inside `entryLabel`'s `switch`, add directly before `default:`:

```ts
      case "schedule_one_off": {
        const on = typeof nd?.date === "string" ? ` on ${nd.date}` : "";
        return `Scheduled a one-off game${on}`;
      }
```

- [ ] **Step 3: Run it and watch it pass**

Run: `npx tsc --noEmit && npx vitest run src/lib/actions/revalidate-paths.test.ts src/lib/actions/league-guards.test.ts`
Expected: no type errors; both pass.

Run: `PORT=3101 scripts/e2e-locked.sh e2e/14-one-off-game.spec.ts`
Expected: 2 passed.

- [ ] **Step 4: Commit (only if approved)**

```bash
git add src/lib/actions/schedule.ts "src/app/[league]/(manage)/audit/page.tsx" e2e/14-one-off-game.spec.ts
git commit -m "fix(schedule): a one-off game that lands is audited"
```

---

### Task 5: e2e consolidation — the conventions every sub-task follows

This section changes no file. Tasks 5a–5k apply it.

**Build order.** One sub-task per new file, ascending:
- `01-public`, `02-auth` and `09-access` are edited in place; `09-access` takes two sub-tasks (5g, 5h).
- `10-roster-changes` is created only after `10-rules` has been merged into `07-staff` and deleted (5f).
- Each sub-task runs its new file plus the dependents it names.
- The full suite runs twice: after 5i, and in Task 7.

**Split-source rule.** A source spec split across several new files (15, 27) loses only the tests being moved. It is deleted in the task that moves its last test, which for both is 5g.

**Verbs in the tables.**
- **keep**: stays where it is, unchanged except for the renames below.
- **move**: copy the test and its comments verbatim, then apply the renames below.
- **delete**: remove the test, then every helper, constant or import nothing left in the file uses; `npx eslint <file>` reports them.
- **fold**: the sub-task gives the resulting code.

Every row names the survival-rule letter that keeps a test, or the reason it goes. "Design" means the design named the cut; anything else is the survival rule applied here.

**A hidden control counts as (b) only while no kept test drives the refusal behind it.** Rendering is not a restriction. Once a kept test drives the server or RLS refusal, a test that a button is absent adds nothing, and goes.

**The source headers move too.** Each source spec's header docblock is placed, verbatim, above the `test.describe` that holds its tests, so no ⛔ warning is lost before part 3 trims comments. Each merged file then opens with the one-line docblock its sub-task gives.

**One `admin()` per file** (it is identical in every source spec):

```ts
function admin() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SECRET_KEY!,
    { auth: { autoRefreshToken: false, persistSession: false } },
  );
}
```

**One `signInAs` per file** that signs anyone in, replacing every sign-in helper and inline dev-panel sign-in:

```ts
type Role =
  | "Manager"
  | "Scorekeeper"
  | "Captain"
  | "One-league mgr"
  | "One-league scorer"
  | "No-league mgr"
  | "Commissioner"
  | "Deputy";

/** Dev-panel sign-in. A scorekeeper lands on `/tonight`, everyone else on the picker. */
async function signInAs(page: Page, role: Role, then?: string) {
  await page.goto("/login");
  await page.getByRole("button", { name: role, exact: true }).click();
  await page.waitForURL(
    role === "Scorekeeper" || role === "One-league scorer" ? "/tonight" : "/",
  );
  if (then) await page.goto(then);
}
```

| In the source | Becomes |
|---|---|
| `signedInAs(page, R)` whose helper ends in `page.goto("/obhl/dashboard")` (02, 03, 04, 05, 06, 07, 08, 09, 10, 11, 12, 13, 14, 30, 31) | `signInAs(page, R, "/obhl/dashboard")` |
| `signedInAsManager(page)` ending on a dashboard (23's `/obhl/manage/dashboard`, 28, 29) | `signInAs(page, "Manager", "/obhl/dashboard")` |
| A helper that stops at the landing: `signInAs(page, L)` (16, 20, 22, 27, 32), `signInAsManager(page)` (15, 19, 26), `signedInAsManager(page)` (21), `signedInAs(page, R)` (33) | `signInAs(page, L)` |
| Inline `page.goto("/login")` + `getByRole("button", { name: L }).click()` + `waitForURL(…)` (15, 17, 18) | `signInAs(page, L)` |
| 23's `/obhl/manage/seasons` | `/obhl/seasons` |

**File-level hooks go inside their spec's describe:**
- 16's `test.beforeAll` → inside `Path 17 — Per-league membership`.
- 21's `test.beforeAll`/`test.afterAll(teardown)` → inside `Path 23 — season gating`.
- 24's `test.describe.configure({ mode: "serial" })`, `beforeAll`, `afterAll` and its `EMAIL`, `PASSWORD` and `userId` → inside a new `test.describe("Path 24 — password sign-in")`.
- 34's `test.afterEach`, `restoreGame` and `restoreRoster` → inside `Closing the night`.
- The top-level tests of 17, 18 and 19 go inside `test.describe("New league")`, `test.describe("Merge duplicates")` and `test.describe("Transfers")`.

**Spec-name pointers.** A comment naming a source spec is rewritten to the new file (comment-only). At the end of each sub-task, `grep -rn` the deleted source names over `e2e src`; expected: no output.

| Old spec | New file |
|---|---|
| `01-public`, `25-team-logo-ink` (deleted) | `01-public` |
| `02-auth`, `24-password-auth`, `26-sign-out-destination` | `02-auth` |
| `03-seasons`, `17-roster-import`, `21-season-gating`, `32-create-league` | `03-season-setup` |
| `04-rosters`, `06-audit`, `18-merge-duplicates` | `04-rosters` |
| `05-scoring`, `12-captain-lineup`, `13-goalie`, `33-scorekeeper-day`, `34-close-night` | `05-scoring-night` |
| `07-announcements`, `08-people`, `10-rules`, `20-league-office` | `07-staff` |
| `09-access`, `15-league-routing`, `16-league-membership`, `27-one-chrome` | `09-access` (15's public tests: `01-public`; its switcher test: `07-staff`) |
| `19-transfer`, `22-roster-editing` | `10-roster-changes` |
| `11-schedule-builder`, `23-schedule-constraints`, `28-schedule-form-state`, `31-stale-draft` | `11-schedule-build` |
| `14-one-off-game`, `29-schedule-repair`, `30-schedule-edits` | `14-schedule-changes` |

**Every sub-task also runs, before its e2e:** `npm run typecheck` (which includes `tsc -p e2e/tsconfig.json`) and `npx eslint <the files it touched>`. Expected: no errors.

---

### Task 5a: `01-public`

**Files:**
- Modify: `e2e/01-public.spec.ts`, `e2e/15-league-routing.spec.ts` (tests leave), `e2e/27-one-chrome.spec.ts` (one test leaves)
- Delete: `e2e/25-team-logo-ink.spec.ts`

**Interfaces:**
- Produces: `e2e/01-public.spec.ts` with `admin()`. It signs nobody in, so it has no `signInAs`.

The file opens with: `/** The public site as an anonymous visitor sees it: league pages, stats, the schedule and its exports. */`

- [ ] **Step 1: Apply the tables**

`e2e/01-public.spec.ts`:

| Test | Action | Why |
|---|---|---|
| `renders league name, standings, stat leaders, upcoming games, and announcements` | keep | (a) league home |
| `the selected tab is visually distinguishable from the unselected one` | delete | a styling guard; no letter |
| `skater stats load and rows are sortable by clicking column headers` | keep | (a) stats page |
| `Goalies tab loads and shows rows` | delete | a second smoke of the stats page |
| `clicking a skater from stats opens their profile with chart and game log` | keep | (a) player page |
| `status badges render for the Sharks captain on the team page` | delete | presence; 04-rosters' `toggle captain sets and removes C badge` drives the badge |
| `schedule page shows upcoming by default and results in their own view` | keep | (a) schedule |
| `clicking a finalized game opens its detail page with a score` | keep | (a) game page |
| `picking a team exports only that team's games` | keep + fold (below) | (a) exports |
| `an export for a team outside the season is a 404, not the season` | keep | (b) |
| `teams list shows all 6 Oceanview teams` | keep | (a) teams list |
| `Sharks team page shows roster with 14+ players` | delete | 04-rosters' `goalies are listed even with no games played` smokes the public team page |

From `e2e/15-league-routing.spec.ts`. Every other 15 test stays in 15 for now (split-source rule).

| Test | Action | Why |
|---|---|---|
| `the root landing page lists both leagues and links to each` | move into a new `test.describe("Path 16 — Leagues, as an anonymous visitor finds them")` at the end of 01 | (a) the picker (design) |
| `the two leagues do not bleed into each other` | move, same describe | (b) (design) |
| `each league home shows its own name and announcements` | move, same describe | (b) (design) |
| `an unknown league slug 404s` | move, same describe | (b) (design) |
| `a slug resolves case-insensitively` | move, same describe | (a) (design) |
| `an export for a season that does not exist is a 404, not an empty file` | move into `Path 4 — Schedule and game detail`, after the team-404 test | (b) (design) |
| `a league's calendar and CSV are named for that league` | fold into 01's export test | (a) (design: the only test of the league name in exports) |
| `an anonymous visitor gets no league switcher, only a way back to the picker` | fold into 27's anonymous test | ruling |

From `e2e/27-one-chrome.spec.ts`. The other five 27 tests stay for now.

| Test | Action | Why |
|---|---|---|
| `an anonymous visitor gets no staff row and the header they always had` | move into `Path 16 — Leagues, as an anonymous visitor finds them` + fold (below) | (b) (design) |

`e2e/25-team-logo-ink.spec.ts` is deleted whole (design). Its tests are `the schedule shows dark letters and the uploaded crest`, `the league home shows dark letters in the points leaders`, `the standings table shows the uploaded crest` and `the stats tables show dark letters and the uploaded crest`.

- [ ] **Step 2: Fold 15's export naming into `picking a team exports only that team's games`**

Append at the end of that test's body. Add `admin()` to the top of the file first.

```ts
    // ── Folded in from 15: each league's SEASON export is named for that
    // league. `buildIcs` always took the name as an argument, but the routes
    // passed a literal, so both leagues' feeds arrived in a subscriber's
    // calendar app called "OBHL Schedule". The event UIDs are deliberately
    // unchanged — see EXPORTS_HANDOFF §3.
    const db = admin();
    for (const slug of ["harbor", "obhl"]) {
      const { data: league } = await db
        .from("leagues")
        .select("id, name")
        .eq("slug", slug)
        .single();
      const { data: season } = await db
        .from("seasons")
        .select("id")
        .eq("league_id", league!.id)
        .eq("is_active", true)
        .single();

      const ics = await request.get(`/api/schedule/${season!.id}`);
      expect(ics.ok()).toBeTruthy();
      expect(await ics.text()).toContain(`${league!.name} Schedule`);
      expect(ics.headers()["content-disposition"]).toContain(
        `${slug}-schedule.ics`,
      );

      const csv = await request.get(`/api/schedule/${season!.id}/schedule.csv`);
      expect(csv.ok()).toBeTruthy();
      expect(csv.headers()["content-disposition"]).toContain(
        `${slug}-schedule.csv`,
      );
    }
```

- [ ] **Step 3: Fold 15's switcher assertion into 27's anonymous test**

The moved test's body becomes:

```ts
  test("an anonymous visitor gets no staff row and the header they always had", async ({
    page,
  }) => {
    for (const url of ["/obhl", "/obhl/standings", "/obhl/schedule"]) {
      await page.goto(url);
      await expect(
        page.getByRole("navigation", { name: "League" }).first(),
      ).toBeVisible();
      await expect(
        page.getByRole("navigation", { name: "Staff tools" }),
      ).toHaveCount(0);
      await expect(page.getByRole("button", { name: "Sign out" })).toHaveCount(
        0,
      );
      // Folded in from 15: no league switcher. ⚠️ ANONYMOUS ONLY — a signed-in
      // member of two leagues DOES get one on this URL, in the staff row.
      await expect(page.getByLabel("Select league")).toHaveCount(0);
    }
    // …only a way back to the picker.
    await page.goto("/obhl");
    await expect(
      page.getByRole("link", { name: "All leagues" }),
    ).toHaveAttribute("href", "/");
  });
```

- [ ] **Step 4: Add the team feed test**

Add inside `test.describe("Path 4 — Schedule and game detail")`, after the moved season-404 test, where `unfold` is in scope:

```ts
  test("a team's calendar feed answers with its games", async ({ request }) => {
    const { data: team } = await admin()
      .from("teams")
      .select("id, leagues!inner(slug)")
      .eq("leagues.slug", "obhl")
      .eq("slug", "sharks")
      .single();
    const res = await request.get(`/api/schedule/team/${team!.id}/feed.ics`);
    expect(res.status()).toBe(200);
    expect(res.headers()["content-type"]).toContain("text/calendar");
    const body = unfold(await res.text());
    expect(body).toContain("BEGIN:VEVENT");
    expect(body).toContain("Oceanview Beer Hockey League — Team Schedule");
  });
```

- [ ] **Step 5: Delete 25 and prove the feed test can fail**

```bash
git rm e2e/25-team-logo-ink.spec.ts
```

Temporarily change the feed URL to `/api/schedule/team/00000000-0000-0000-0000-000000000000/feed.ics`.
Run: `PORT=3101 scripts/e2e-locked.sh e2e/01-public.spec.ts -g "calendar feed"`
Expected: FAIL at `expect(res.status()).toBe(200)` (received 404). Restore the URL.

- [ ] **Step 6: Run**

Run: `PORT=3101 scripts/e2e-locked.sh e2e/01-public.spec.ts e2e/15-league-routing.spec.ts e2e/27-one-chrome.spec.ts`
Expected: 39 passed (01-public 16; 15 is down to 18; 27 is down to 5).

- [ ] **Step 7: Verify nothing references the removed tests**

Run: `grep -rn "the selected tab is visually distinguishable\|Goalies tab loads and shows rows\|status badges render for the Sharks captain\|Sharks team page shows roster with 14\|a league's calendar and CSV are named for that league\|an anonymous visitor gets no league switcher\|25-team-logo-ink" e2e src`
Expected: no output. If `src/components/shared/team-logo.test.ts` names 25 in a comment, delete that clause and re-run.

Run: `grep -rc "the root landing page lists both leagues and links to each\|an anonymous visitor gets no staff row and the header they always had" e2e | grep -v ":0"`
Expected: exactly one line, `e2e/01-public.spec.ts:2`.

- [ ] **Step 8: Commit (only if approved)**

```bash
git add -A e2e
git commit -m "test(e2e): one public-site spec"
```

---

### Task 5b: `02-auth`

**Files:**
- Modify: `e2e/02-auth.spec.ts`
- Delete: `e2e/24-password-auth.spec.ts`, `e2e/26-sign-out-destination.spec.ts`

**Interfaces:**
- Produces: `e2e/02-auth.spec.ts` with `admin()`, `signInAs()`, `tamper()`, `accessTokenClaims()`, `signInWithPassword(page, email, password)` (24's `signIn`, renamed), `newestMailIdFor()`, `MAIL`, and 26's `signOut`, `assertLandedSignedOutOn`, `PICKER`, `LEAGUE_HOME`.

The file opens with: `/** Signing in and out: the dev panel, a claimless token, passwords and the reset mail. */`

- [ ] **Step 1: Apply the tables**

`e2e/02-auth.spec.ts`:

| Test | Action | Why |
|---|---|---|
| `dev quick sign-in lands on the league picker, not a dead /dashboard` | keep | (a) |
| `the manage dashboard shows the manager's tools` | delete | duplicate of 09-access's `a manager of one league reaches their own league's tools` |
| `sign out returns to the league's public home, not the sign-in screen` | delete | design: sign-out is kept once, as 26's `from a league page it lands on that league's public home` |
| `unauthenticated access to a manage route redirects to /login` | delete | duplicate of 09's `unauthenticated user cannot reach /dashboard` |
| `scorekeeper dashboard shows Score Games card but not People & Roles` | delete | presence |
| `captain dashboard shows team card` | delete | presence; 05-scoring-night's captain test starts from this dashboard's `Set lineup` link |
| `a signed-in manager carries their badge onto the public site` | delete | presence; 26's tests click that Sign out button on a public page |
| `an anonymous visitor sees none of it` | delete | duplicate of the anonymous test now in 01-public |
| `the public header does not overflow at md, signed in or out` | delete | design |
| `an account with no role claim but a role in profiles reaches the manage tools` | keep | (b) refused without a role, admitted by `profiles.role`; replaces `verify-role-fallback` |
| `login offers the magic link first, with the password path as a fallback` | delete | presence; the password path and the reset mail are driven below |
| `/set-password offers a fresh link when there is no recovery session` | delete | presence; the mail-loop test fills that same form |

From `e2e/24-password-auth.spec.ts`, into `test.describe("Path 24 — password sign-in")`:

| Test | Action | Why |
|---|---|---|
| `signs in with a password and lands on the league picker` | move | (a) |
| `refuses a wrong password without saying which half was wrong` | move | (b) |
| `sets its own password on the session, and the new one works` | move | (a), with its audit read-back |
| `enforces the 8-character floor in the action, not just the browser` | delete | input validation; no letter |
| `a sessionless landing offers a fresh link instead of dead-ending` | delete | presence; the mail-loop test fills the same form |
| `the emailed link lands on /set-password and finishes the flow` | move | (a) |

From `e2e/26-sign-out-destination.spec.ts`, keeping its `Sign-out destination` describe:

| Test | Action | Why |
|---|---|---|
| `from a league page it lands on that league's public home` | move | (a) |
| `from the league picker, which has no league, it lands on /` | delete | a second smoke of the same flow |
| `a posted slug that does not resolve lands on / rather than on itself` | move | (b) an open redirect refused |

02's `signedInAs`, `signOut` function and `badge` constant are used only by deleted tests: delete them. 26's `const signOut = (page: Page) => …` then has no clash.

- [ ] **Step 2: Delete the sources**

```bash
git rm e2e/24-password-auth.spec.ts e2e/26-sign-out-destination.spec.ts
```

- [ ] **Step 3: Run**

Run: `PORT=3101 scripts/e2e-locked.sh e2e/02-auth.spec.ts`
Expected: 8 passed. If the local mail API is down: 7 passed, 1 skipped (`the emailed link lands on /set-password and finishes the flow`).

- [ ] **Step 4: Verify nothing references the removed tests**

Run: `grep -rn "the manage dashboard shows the manager's tools\|sign out returns to the league's public home\|scorekeeper dashboard shows Score Games\|captain dashboard shows team card\|carries their badge onto the public site\|an anonymous visitor sees none of it\|does not overflow at md\|login offers the magic link first\|offers a fresh link when there is no recovery session\|enforces the 8-character floor\|a sessionless landing offers a fresh link\|from the league picker, which has no league\|24-password-auth\|26-sign-out-destination" e2e src`
Expected: no output after the pointer rewrites. A comment that names `24-password-auth` or `26-sign-out-destination` now names `02-auth`.

- [ ] **Step 5: Commit (only if approved)**

```bash
git add -A e2e src
git commit -m "test(e2e): one auth spec"
```

---

### Task 5c: `03-season-setup`

**Files:**
- Rename: `e2e/03-seasons.spec.ts` → `e2e/03-season-setup.spec.ts`
- Delete: `e2e/17-roster-import.spec.ts`, `e2e/21-season-gating.spec.ts`, `e2e/32-create-league.spec.ts`

**Interfaces:**
- Produces: `e2e/03-season-setup.spec.ts` with `admin()`, `signInAs()`, `goToActiveSeasonSetup()`, 21's `SLUG`/`LEAGUE`/`SEASON`/`TEAM`/`FIRST`/`LAST`, fixture ids and `teardown()`, and 32's `NEW_LEAGUE` and `heading()`.
- 5g removes `the old per-league URL redirects here` from this file.

The file opens with: `/** Setting up a season, creating a league, and working in a season nobody activated. */`

- [ ] **Step 1: Rename and apply the tables**

```bash
git mv e2e/03-seasons.spec.ts e2e/03-season-setup.spec.ts
```

From 03:

| Test | Action | Why |
|---|---|---|
| `seasons list shows Spring 2026 with Active badge` | delete | presence; the audit test drives the same list |
| `season setup page shows step chips and 6 enrolled teams` | keep | (a) the setup page |
| `carry-forward button is present on season setup` | delete | design: presence; the audit test clicks the button |
| `every season action lands in this league's audit log` | keep | (a) + (e) the audit null-league trap |

From 17, into `test.describe("New league")`:

| Test | Action | Why |
|---|---|---|
| `the new-league page offers a rosters-only import` | move | (a) |

From 21, keeping `Path 23 — season gating` with its hooks inside:

| Test | Action | Why |
|---|---|---|
| `the fixture is the shape these tests need` | fold into `beforeAll` (below) | a precondition, not a test |
| `a season nobody activated is still editable` | move | (a) |
| `switching season in manage does not move the public site` | move | (a) the season switcher |
| `a manager's season choice does not follow a visitor` | move | (b) |
| `?season= scopes one page without disturbing the rest` | delete | a URL-parameter detail; no letter |
| `a season from another league is ignored, not fatal` | move | (b) |

From 32, keeping both of its describes:

| Test | Action | Why |
|---|---|---|
| `` `${who} reaches the create page` `` (a loop) | move; the loop becomes `for (const who of ["One-league mgr", "No-league mgr"] as const)` | (b) the admission control for the refusals below; `"Manager"` duplicates 17's test |
| `a scorekeeper is refused` | move | (b) |
| `an anonymous visitor is sent to sign in rather than 404ing` | move | (b) |
| `the old per-league URL redirects here` | move now; 5g folds it into 09-access's legacy table | a legacy redirect the owner kept |
| `the League Office is not swallowed by that redirect` | delete | design: duplicate of 15's `the League Office keeps its prefix, which is not a league` |
| `a manager sees the link in the staff row, a scorekeeper does not` | delete | presence |
| `the root page offers it to a manager who belongs to nothing` | move | (a) the only way in on an empty instance |

- [ ] **Step 2: Fold 21's teardown and fixture check**

Replace `teardown` with:

```ts
/**
 * Remove the fixture league and the global player it rostered.
 *
 * ⛔ THE DELETE IS ASSERTED. A league left behind here is still there when
 * 09-access runs, and it becomes that file's `LEAD_OUT` — every refusal there
 * would then aim at a league nobody is a member of, for the wrong reason.
 */
async function teardown() {
  const db = admin();
  // The league cascades to its seasons, teams, roster rows and memberships.
  const { error: leagueError } = await db
    .from("leagues")
    .delete()
    .eq("slug", SLUG);
  // `players` is global and hangs off no league, so it does not cascade.
  const { error: playerError } = await db
    .from("players")
    .delete()
    .eq("first_name", FIRST)
    .eq("last_name", LAST);
  if (leagueError || playerError) {
    throw new Error(
      `teardown failed: ${leagueError?.message ?? playerError?.message}`,
    );
  }
  const { data: left } = await db.from("leagues").select("id").eq("slug", SLUG);
  expect(left ?? [], `the ${SLUG} fixture league survived its teardown`).toHaveLength(0);
}
```

At the end of `beforeAll`, after `harborSeasonId = harborSeason!.id;`, add:

```ts
  // Was the test "the fixture is the shape these tests need". A fixture season
  // that IS active would make every assertion in the first test vacuous.
  const { data: shape } = await db
    .from("seasons")
    .select("is_active")
    .eq("id", seasonId)
    .single();
  expect(shape!.is_active, "the fixture season must be inactive").toBe(false);
  expect(springId, "no seeded Spring 2026").toBeTruthy();
  expect(fallId, "no seeded Fall 2026").toBeTruthy();
  expect(harborSeasonId, "no active Harbor season").toBeTruthy();
```

- [ ] **Step 3: Delete the sources**

```bash
git rm e2e/17-roster-import.spec.ts e2e/21-season-gating.spec.ts e2e/32-create-league.spec.ts
```

- [ ] **Step 4: Run with the file that reads `LEAD_OUT`**

Run: `PORT=3101 scripts/e2e-locked.sh e2e/03-season-setup.spec.ts e2e/16-league-membership.spec.ts`
Expected: 41 passed (03-season-setup 13; 16 unchanged at 28).

- [ ] **Step 5: Verify nothing references the removed tests**

Run: `grep -rn "seasons list shows Spring 2026 with Active badge\|carry-forward button is present\|the fixture is the shape these tests need\|?season= scopes one page\|the League Office is not swallowed by that redirect\|a manager sees the link in the staff row\|03-seasons\|17-roster-import\|21-season-gating\|32-create-league" e2e src`
Expected: no output after the pointer rewrites.

- [ ] **Step 6: Commit (only if approved)**

```bash
git add -A e2e src
git commit -m "test(e2e): one season-setup spec"
```

---

### Task 5d: `04-rosters`

**Files:**
- Modify: `e2e/04-rosters.spec.ts`
- Delete: `e2e/06-audit.spec.ts`, `e2e/18-merge-duplicates.spec.ts`

**Interfaces:**
- Produces: `e2e/04-rosters.spec.ts` with `admin()`, `signInAs()`, `manageRoster()`, `rosterRows()`, `openDialogFor()`, and 06's `suspendVia()`.

The file opens with: `/** Rosters: the public team page, the editor and its audit trail, revert, and duplicates. */`

- [ ] **Step 1: Apply the tables**

From 04:

| Test | Action | Why |
|---|---|---|
| `the roster is split into three sections` | delete | presence; the next test reads the Goalies region |
| `goalies are listed even with no games played` | keep | (c) GP 0 for a goalie who has not played |
| `a two-night league pills the night; a one-night league does not` | delete | the display of a roster field; no letter |
| `roster page shows 14 players with jersey numbers` | delete | presence |
| `add a new player and they appear in the roster` | delete | duplicate: the removal test adds a player first |
| `removing a player is visible in this league's audit log` | keep | (a) + (e) the audit null-league trap |
| `a removed player can be added back to the same team` | delete | a regression pin on re-adding; no letter |
| `toggle captain sets and removes C badge` | keep + fold 06 (below) | (a) + (e) |
| `suspend a player shows SUSP badge, lift removes it` | keep + fold 06 (below) | (a) + (e) |
| `logo upload card is visible` | delete | presence |
| `the editor is on the page, behind no tab and no query parameter` | delete | a UI decision; no letter |

From 06:

| Test | Action | Why |
|---|---|---|
| `suspension action appears in the audit log` | fold into the suspend test | (e) (design) |
| `captain toggle appears in audit log` | fold into the captain test | (e) (design) |
| `revert button is present when session entries exist` | move into `test.describe("Path 12 — Audit revert")` | (e) audit revert — the only e2e of `revertAuditEntries` (ruling) |

From 18, into `test.describe("Merge duplicates")`:

| Test | Action | Why |
|---|---|---|
| `duplicates page loads and is scoped to this league` | move | (b) no other league's names |
| `the review list renders, and People & Roles links to it` | delete | presence |

- [ ] **Step 2: Fold the audit assertions into the two toggle tests**

Append to the end of `toggle captain sets and removes C badge`:

```ts
    // ── Folded in from 06-audit: both directions are audited, under this
    // league. `logAudit` resolves the league from the entity, and an entry
    // filed under none is hidden from every view that would show it.
    await page.goto("/obhl/audit");
    await expect(page.getByText(/Made .+ captain/).first()).toBeVisible();
    await expect(page.getByText(/Removed captain from /).first()).toBeVisible();
    const db = admin();
    const { data: league } = await db
      .from("leagues")
      .select("id")
      .eq("slug", "obhl")
      .single();
    const { data: entries } = await db
      .from("audit_log")
      .select("league_id")
      .eq("action", "toggle_captain")
      .order("created_at", { ascending: false })
      .limit(2);
    expect(entries).toHaveLength(2);
    for (const e of entries!) expect(e.league_id).toBe(league!.id);
```

Append to the end of `suspend a player shows SUSP badge, lift removes it`:

```ts
    // ── Folded in from 06-audit: both writes are audited, under this league.
    await page.goto("/obhl/audit");
    await expect(
      page.getByText(/Updated is suspended for /).first(),
    ).toBeVisible();
    const db = admin();
    const { data: league } = await db
      .from("leagues")
      .select("id")
      .eq("slug", "obhl")
      .single();
    const { data: entries } = await db
      .from("audit_log")
      .select("league_id")
      .eq("action", "update_player_status")
      .order("created_at", { ascending: false })
      .limit(2);
    expect(entries).toHaveLength(2);
    for (const e of entries!) expect(e.league_id).toBe(league!.id);
```

- [ ] **Step 3: Delete the sources**

```bash
git rm e2e/06-audit.spec.ts e2e/18-merge-duplicates.spec.ts
```

- [ ] **Step 4: Run with the two specs that read Sharks' roster**

Run: `PORT=3101 scripts/e2e-locked.sh e2e/04-rosters.spec.ts e2e/05-scoring.spec.ts e2e/13-goalie.spec.ts`
Expected: 17 passed (04-rosters 6; 05 has 4; 13 has 7).

- [ ] **Step 5: Verify nothing references the removed tests**

Run: `grep -rn "the roster is split into three sections\|a two-night league pills the night\|roster page shows 14 players\|add a new player and they appear\|a removed player can be added back\|logo upload card is visible\|behind no tab and no query parameter\|suspension action appears in the audit log\|captain toggle appears in audit log\|the review list renders, and People\|06-audit\|18-merge-duplicates" e2e src`
Expected: no output after the pointer rewrites.

- [ ] **Step 6: Commit (only if approved)**

```bash
git add -A e2e src
git commit -m "test(e2e): one rosters spec"
```

---

### Task 5e: `05-scoring-night`

**Files:**
- Rename: `e2e/05-scoring.spec.ts` → `e2e/05-scoring-night.spec.ts`
- Delete: `e2e/12-captain-lineup.spec.ts`, `e2e/13-goalie.spec.ts`, `e2e/33-scorekeeper-day.spec.ts`, `e2e/34-close-night.spec.ts`

**Interfaces:**
- Produces: `e2e/05-scoring-night.spec.ts` with `admin()`, `signInAs()`, 13's `sharksGameOn()`, 33's `anOldGameId()`, and 34's `CRON_SECRET`, `sweep()`, `window()`, `borrowGame()`, `hoursInto()`. 33's own `type Role` is deleted in favour of the file's.
- Consumes: `v_standings_raw` (`gp`, `points`), `v_skater_stats` (`gp`, `g`; final, regular, non-draft games only), `seasons.point_system` (`win`, `loss`).

The file opens with: `/** Game night: scoring and finalizing, lineups and goalies, the scorekeeper's page, and the nightly sweep. */`

Order inside the file: 05, 12, 13, 33, 34.

- [ ] **Step 1: Rename and apply the tables**

```bash
git mv e2e/05-scoring.spec.ts e2e/05-scoring-night.spec.ts
```

From 05:

| Test | Action | Why |
|---|---|---|
| `dress players, record a goal, finalize, verify on public schedule` | keep + port (Step 2) | (a) + (c) |
| `cancel a scheduled game and restore it` | keep | (a) |
| `a visitor is not shown cancelled games` | keep | (b) |
| `postpone a game and restore it` | keep | (a) |

From 12:

| Test | Action | Why |
|---|---|---|
| `captain can check players and save lineup on their team's game` | move | (a) + (b): exactly one lineup form |
| `captain cannot save opponent lineup (form count stays at 1)` | delete | design: the test above asserts the count |

From 13:

| Test | Action | Why |
|---|---|---|
| `goalie section shows buttons not a dropdown after dressing players` | delete | the control's shape; 33's `picking a goalie dresses them…` drives the pick |
| `a two-goalie team suggests a different goalie on each of its nights` | move | (a) the night's goalie |
| `a one-goalie team suggests its goalie whatever the night` | move | (a); this is the count 22 must run after |
| `captain sees goalie buttons for their own team` | delete | presence; the next test clicks one |
| `captain can click a goalie button and it persists` | move | (a) |
| `captain does not see empty-net GA controls` | move | (b); no kept test drives the server refusal behind it |
| `a game whose goalies are both subs completes without a warning` | delete | a regression pin on the finalize gate; no letter |

From 33:

| Test | Action | Why |
|---|---|---|
| `signing in lands on tonight, not the league picker` | delete | `signInAs` waits for `/tonight` on every scorekeeper sign-in |
| `lists tonight's games, each with a way into its scoresheet` | move | (a) |
| `a scorekeeper sees only the leagues they keep score for` | move | (b) |
| `a game that is not today is refused, and says where to go` | move | (b) the day rule, which has no RLS half |
| `a manager may still open that same game` | move | (b) its control |
| `the scorekeeper can set a lineup and score tonight's game` | delete | duplicate of 05's scoring smoke: same account, same page |
| `picking a goalie dresses them, and a lineup save does not undress them` | move | (c) the dressed goalie row is what `v_goalie_stats` credits |
| `a scoresheet gives the scorekeeper the minimal chrome and a way back` | move | (b) a shared login gets no Password link and no Sign out |

From 34, keeping `Closing the night` with its `afterEach` inside:

| Test | Action | Why |
|---|---|---|
| `refuses a request with no secret, and changes nothing` | move | (b) |
| `closes a game left open last night, with the roster's score and no actor` | move | (a) + (c) + the anon-client trap |
| `leaves a game reopened on an EARLIER night alone` | move | (e) the undo that audit revert depends on |

- [ ] **Step 2: Port `verify-scoring`'s deltas into the scoring smoke**

In `dress players, record a goal, finalize, verify on public schedule`, insert directly after `const scoresheet = page.url();`:

```ts
    // ── Ported from scripts/verify-scoring.mjs: a finalize must MOVE the
    // standings and the stats. Deltas, because the seed already has final
    // games; read now, because every view counts final games only.
    const db = admin();
    const gameId = new URL(scoresheet).pathname.split("/")[3];
    const { data: game } = await db
      .from("games")
      .select("season_id, home_team_id, away_team_id")
      .eq("id", gameId)
      .single();
    const { data: season } = await db
      .from("seasons")
      .select("point_system")
      .eq("id", game!.season_id)
      .single();
    const points = season!.point_system as { win: number; loss: number };
    const { data: lines } = await db
      .from("game_rosters")
      .select("player_id, team_id, goals")
      .eq("game_id", gameId);
    const scored = (lines ?? []).filter((r) => (r.goals ?? 0) > 0);
    expect(scored, "exactly one player holds the one goal recorded above").toHaveLength(1);
    const scorer = scored[0];
    const bench = (lines ?? []).find(
      (r) => r.team_id === scorer.team_id && r.player_id !== scorer.player_id,
    )!;
    const loserTeam =
      scorer.team_id === game!.home_team_id
        ? game!.away_team_id
        : game!.home_team_id;
    const standing = async (teamId: string) => {
      const { data } = await db
        .from("v_standings_raw")
        .select("gp, points")
        .eq("season_id", game!.season_id)
        .eq("team_id", teamId)
        .single();
      return data!;
    };
    const skater = async (playerId: string, teamId: string) => {
      const { data } = await db
        .from("v_skater_stats")
        .select("gp, g")
        .eq("season_id", game!.season_id)
        .eq("player_id", playerId)
        .eq("team_id", teamId)
        .maybeSingle();
      return data ?? { gp: 0, g: 0 };
    };
    const winnerBefore = await standing(scorer.team_id);
    const loserBefore = await standing(loserTeam);
    const scorerBefore = await skater(scorer.player_id, scorer.team_id);
    const benchBefore = await skater(bench.player_id, bench.team_id);
```

Then insert directly after the `await expect(page.getByText("Final").first()).toBeVisible();` that follows the `Complete anyway` click:

```ts
    const winnerAfter = await standing(scorer.team_id);
    const loserAfter = await standing(loserTeam);
    expect(winnerAfter.gp, "the scoring side's GP").toBe(winnerBefore.gp + 1);
    expect(loserAfter.gp, "the other side's GP").toBe(loserBefore.gp + 1);
    expect(winnerAfter.points, "a 1-0 win's points").toBe(
      winnerBefore.points + points.win,
    );
    expect(loserAfter.points, "a regulation loss's points").toBe(
      loserBefore.points + points.loss,
    );
    const scorerAfter = await skater(scorer.player_id, scorer.team_id);
    expect(scorerAfter.g, "the scorer's goals").toBe(scorerBefore.g + 1);
    expect(scorerAfter.gp).toBe(scorerBefore.gp + 1);
    const benchAfter = await skater(bench.player_id, bench.team_id);
    expect(benchAfter.gp, "dressed but did not score: GP still counts").toBe(
      benchBefore.gp + 1,
    );
    expect(benchAfter.g).toBe(benchBefore.g);
```

- [ ] **Step 3: Delete the sources and prove the port can fail**

```bash
git rm e2e/12-captain-lineup.spec.ts e2e/13-goalie.spec.ts e2e/33-scorekeeper-day.spec.ts e2e/34-close-night.spec.ts
```

Temporarily change `winnerBefore.points + points.win` to `winnerBefore.points + points.loss`.
Run: `PORT=3101 scripts/e2e-locked.sh e2e/05-scoring-night.spec.ts -g "dress players, record a goal"`
Expected: FAIL at `a 1-0 win's points`. Restore.

- [ ] **Step 4: Run**

Run: `PORT=3101 scripts/e2e-locked.sh e2e/05-scoring-night.spec.ts`
Expected: 18 passed.

- [ ] **Step 5: Verify nothing references the removed tests**

Run: `grep -rnE "captain cannot save opponent lineup|goalie section shows buttons not a dropdown|captain sees goalie buttons for their own team|goalies are both subs completes without a warning|signing in lands on tonight, not the league picker|the scorekeeper can set a lineup and score tonight's game|(05-scoring|12-captain-lineup|13-goalie|33-scorekeeper-day|34-close-night)([^a-z-]|$)" e2e src`
Expected: no output after the pointer rewrites. The `([^a-z-]|$)` tail keeps `05-scoring-night` from matching `05-scoring`.

- [ ] **Step 6: Commit (only if approved)**

```bash
git add -A e2e src
git commit -m "test(e2e): one game-night spec; port verify-scoring"
```

---

### Task 5f: `07-staff`

**Files:**
- Rename: `e2e/07-announcements.spec.ts` → `e2e/07-staff.spec.ts`
- Modify: `e2e/15-league-routing.spec.ts` (one test leaves)
- Delete: `e2e/08-people.spec.ts`, `e2e/10-rules.spec.ts`, `e2e/20-league-office.spec.ts`

**Interfaces:**
- Produces: `e2e/07-staff.spec.ts` with `admin()`, `signInAs()`, 10's `openEditor()` and `RULES_TEXT`, and 20's `COMMISSIONER`, `DEPUTY`, `tamper()`, `canSignIn()`, `profileIdFor()`.
- 5g removes `the old /rules/edit URL still lands on the merged page` from this file.

The file opens with: `/** Staff tools: announcements, People & Roles, league rules, and the League Office. */`

- [ ] **Step 1: Rename and apply the tables**

```bash
git mv e2e/07-announcements.spec.ts e2e/07-staff.spec.ts
```

From 07:

| Test | Action | Why |
|---|---|---|
| `post an announcement, verify on homepage, then delete it` | delete | duplicate flow: the next test posts and deletes, and 09-access's `an announcement posted in one league does not appear in the other` reads the league home |
| `posting and deleting an announcement both land in this league's audit log` | keep | (a) + (e) the audit null-league trap |

From 08, keeping `Path 14 — People & Roles` and its `beforeEach`:

| Test | Action | Why |
|---|---|---|
| `renders staff table with seeded accounts and role labels` | delete | design: presence |
| `Add a staff account form is present with role selector` | delete | design: presence |
| `each staff row has at least one action button` | delete | design: presence |
| `a manager account offers no role control, and no remove when last` | move | (b); no kept test drives the server refusal behind it |
| `adding a staff account appears in this league's audit log` | move | (a) + (e) |
| `the add-account form cannot demote an existing manager` | move | (b) |
| `granting an existing manager a second league is audited` | move | (e) |

From 10, keeping `Path 16 — League Rules`:

| Test | Action | Why |
|---|---|---|
| `a manager opens the editor from the public page itself` | delete | presence |
| `manager saves rules and they appear on the public rules page` | move | (a) |
| `saving rules appears in this league's audit log` | move | (e) |
| `public rules page is accessible without login` | move | (a); also the control that stops the next test passing on a `/login` redirect |
| `an anonymous visitor is offered no way to edit` | move | (b) |
| `the editor closes back to the page a visitor sees` | delete | a UI detail; no letter |
| `the old /rules/edit URL still lands on the merged page` | move now; 5g folds it into 09-access's legacy table | a legacy redirect |

From 20, keeping `Path 20 — League Office`:

| Test | Action | Why |
|---|---|---|
| `the office fixtures hold no membership rows, so the rest means something` | fold into the next test (below) | a precondition |
| `a commissioner opens a league they hold no membership row for` | move + fold | (b) admission through the office tier |
| `the office is reachable from the nav, and only by the office` | delete | the link's presence; 02-auth's claimless test drives `/manage/office` refusing a manager |
| `office members are listed in a league's staff, read-only` | delete | UI; the two forging tests drive the server refusals |
| `a commissioner demotes a league manager, which no manager can do` | move | (a) |
| `a manager forging a commissioner's id does not land — role direction` | move | (b) |
| `a manager forging a commissioner's id is refused — remove direction` | move | (b) |
| `a deputy sees the office roster and can change nothing` | move | (b); no kept test drives a deputy's appoint or remove |
| `a commissioner can revoke a deputy's tier, and put it back` | move | (a) |
| `removeStaff refuses an office member, and the row says why` | move | (b) |
| `a commissioner sets a staff password and the account signs in with it` | move | (a) + (e) filed under a null league on purpose |
| `a deputy is offered no set-password control` | delete | UI; the replay test drives the refusal |
| `setStaffPassword refuses a replayed POST from a deputy and from a manager` | move | (b) |
| `a commissioner cannot set another commissioner's password, but can set their own` | move | (b) |

From 15, into `test.describe("League switcher")`:

| Test | Action | Why |
|---|---|---|
| `the manage switcher moves between leagues` | move | (a) (ruling) |

- [ ] **Step 2: Fold 20's fixture check**

Insert at the top of `a commissioner opens a league they hold no membership row for`, before `await signInAs(page, "Commissioner");`:

```ts
    // Was "the office fixtures hold no membership rows, so the rest means
    // something". The office accounts are seeded with NO memberships; if one
    // ever gains a row, every office test here passes while measuring nothing.
    const db = admin();
    for (const email of [COMMISSIONER, DEPUTY]) {
      const { data } = await db
        .from("profile_leagues")
        .select("league_id")
        .eq("profile_id", await profileIdFor(email));
      expect(data ?? [], `${email} must belong to no league`).toHaveLength(0);
    }
```

- [ ] **Step 3: Delete the sources**

```bash
git rm e2e/08-people.spec.ts e2e/10-rules.spec.ts e2e/20-league-office.spec.ts
```

- [ ] **Step 4: Run**

Run: `PORT=3101 scripts/e2e-locked.sh e2e/07-staff.spec.ts e2e/15-league-routing.spec.ts e2e/16-league-membership.spec.ts`
Expected: 66 passed (07-staff 21; 15 is down to 17; 16 unchanged at 28).

- [ ] **Step 5: Verify nothing references the removed tests**

Run: `grep -rn "post an announcement, verify on homepage\|renders staff table with seeded accounts\|Add a staff account form is present\|each staff row has at least one action button\|a manager opens the editor from the public page\|the editor closes back to the page a visitor sees\|the office fixtures hold no membership rows\|the office is reachable from the nav\|office members are listed in a league's staff\|a deputy is offered no set-password control\|07-announcements\|08-people\|10-rules\|20-league-office" e2e src`
Expected: no output after the pointer rewrites.

- [ ] **Step 6: Commit (only if approved)**

```bash
git add -A e2e src
git commit -m "test(e2e): one staff-tools spec"
```

---

### Task 5g: `09-access`, part 1 — move 15 and 27 in

**Files:**
- Modify: `e2e/09-access.spec.ts`, `e2e/03-season-setup.spec.ts` (one test out), `e2e/07-staff.spec.ts` (one test out)
- Delete: `e2e/15-league-routing.spec.ts`, `e2e/27-one-chrome.spec.ts`

**Interfaces:**
- Produces: `e2e/09-access.spec.ts` with `admin()`, `signInAs()`, 15's `leaguesOfAccount()`, `setHarborPublic()`, `sharedSlug()`, `harborId()`, and 27's `staffRow()`, `leagueNav()`. 15's inner `signInAsManager` becomes `signInAs(page, "Manager")`.

The file opens with: `/** Who may reach what: page guards, league scoping, and the refusals the database makes itself. */`

Order inside the file: 09's describe, then 15's tests in their original order (staged-league, cross-league and audit-scope tests), then 27's, then `Legacy URLs`. 5h adds 16's tests after all of these.

- [ ] **Step 1: Apply the tables**

From 09, keeping `Path 15 — Role-based access control`:

| Test | Action | Why |
|---|---|---|
| `scorekeeper cannot reach /seasons` | keep | (b); 5h turns it into a table row |
| `scorekeeper cannot reach /audit` | keep | (b); same |
| `scorekeeper cannot reach /people` | keep | (b); same |
| `scorekeeper CAN reach the games they score` | delete | duplicate of 05-scoring-night's `lists tonight's games, each with a way into its scoresheet` |
| `captain sees only their team's lineup form on the scoresheet` | delete | design: duplicate of 05-scoring-night's `captain can check players and save lineup on their team's game` |
| `unauthenticated user cannot reach /dashboard` | keep | (b); 5h turns it into a table row |

The 17 tests left in 15, into `test.describe("Path 16 — Per-league routing")`:

| Test | Action | Why |
|---|---|---|
| `a game cannot be viewed under another league's URL` | move | (b) |
| `the league name carries into the page title` | delete | design |
| `nav links point into the league and mark the current section` | delete | design |
| `a staged league is invisible to the public and open to its own people` | move | (b) (design) |
| `a staged league opens for a member who is not a manager` | move | (b) (design) |
| `a staged league stays 404 for a signed-in stranger to it` | move | (b) (design) |
| `an announcement posted in one league does not appear in the other` | move | (b): the one write-lands-in-its-league test (ruling) |
| `a season created in one league does not appear in the other` | delete | ruling: the announcement test is the one kept |
| `a season from another league is not editable under this one` | move | (b) (design) |
| `a team from another league is not reachable under this one` | move | (b) (design) |
| `the old /rosters/<id> URL redirects, and only under its own league` | move | (b) (design) |
| `a game from another league is not scoreable under this one` | move | (b): a URL mismatch → 404, unlike 16's membership → redirect |
| `the audit log shows only this league's actions` | move | (b) + (e) (design) |
| `a section stays marked on its detail pages` | delete | design |
| `every old /manage/ URL still lands on its page` | fold into the legacy table | ruling |
| `the bare schedule-builder URL lands on that season's setup page` | fold into the legacy table | ruling |
| `the League Office keeps its prefix, which is not a league` | fold into the legacy table | ruling |

The five tests left in 27, into `test.describe("One chrome everywhere")`:

| Test | Action | Why |
|---|---|---|
| `a manager sees the same header, with a staff row, on public and staff pages alike` | delete | presence (the audit's "27's first block") |
| `the staff row names no URL the league nav already names` | delete | UI; no letter |
| `no Manage link and no View site link exist anywhere` | delete | UI; no letter |
| `a manager of another league browsing this one gets no staff row` | move | (b) (design) |
| `a page that left the nav is still refused by its own guard` | move | (b) (design); 5h folds it into the refusal table |

Also out, folded into the legacy table:
- `e2e/03-season-setup.spec.ts`: delete `the old per-league URL redirects here`.
- `e2e/07-staff.spec.ts`: delete `the old /rules/edit URL still lands on the merged page`.

- [ ] **Step 2: Write the legacy table**

Append to `e2e/09-access.spec.ts`:

```ts
/**
 * Every URL a manager may have bookmarked before a move. The redirects in
 * `next.config.ts` are the only thing keeping them alive, and nothing else in
 * the suite would notice one deleted.
 */
test.describe("Legacy URLs", () => {
  test("every legacy URL still lands on its page", async ({ page, request }) => {
    // `location` may be relative, so resolve it against a base before reading
    // the parts off it rather than assuming either shape.
    const locationOf = (res: { headers(): Record<string, string> }) =>
      new URL(res.headers()["location"], "http://localhost");

    const moved = [
      ["/obhl/manage/dashboard", "/obhl/dashboard"],
      ["/obhl/manage/people/duplicates", "/obhl/people/duplicates"],
      // Two hops: the prefix rule strips `/manage/`, and the schedule-builder
      // rows below move it under `/schedule`. This row asserts the first.
      ["/obhl/manage/schedule-builder/one-off", "/obhl/schedule-builder/one-off"],
      ["/obhl/manage/rules/edit", "/obhl/rules/edit"],
      // …and the second hop of that one: `/rules/edit` merged into `/rules`.
      ["/obhl/rules/edit", "/obhl/rules"],
      // A dynamic segment rides along rather than being swallowed.
      ["/harbor/manage/seasons/abc-123", "/harbor/seasons/abc-123"],
      // Zero trailing segments: the bare prefix lands on the league home.
      ["/obhl/manage", "/obhl"],
      // ⛔ Two explicit config rules, never one `:rest*` wildcard — zero-or-more
      // would also match the bare `/schedule-builder` and send it to the games
      // list instead of the season setup page (asserted at the end).
      ["/obhl/schedule-builder/repair", "/obhl/schedule/repair"],
      ["/obhl/schedule-builder/one-off", "/obhl/schedule/one-off"],
      // The score pages merged away; a game keeps the same id at either URL.
      ["/obhl/score", "/obhl/schedule"],
      ["/harbor/score/abc-123", "/harbor/games/abc-123/score"],
      // Creating a league belongs to no league, so it left `/:league/import`.
      ["/obhl/import", "/manage/leagues/new"],
    ];
    for (const [from, to] of moved) {
      const res = await request.get(from, { maxRedirects: 0 });
      expect(res.status(), `${from} should be a permanent redirect`).toBe(308);
      expect(locationOf(res).pathname, `${from} should move to ${to}`).toBe(to);
    }

    // A query string survives the move; a manager's filtered link keeps working.
    const withQuery = await request.get("/obhl/manage/people?q=smith", {
      maxRedirects: 0,
    });
    expect(locationOf(withQuery).pathname).toBe("/obhl/people");
    expect(locationOf(withQuery).search).toBe("?q=smith");

    // The League Office keeps its `/manage/` prefix and is not a league: its
    // first segment is `manage`, so a careless source pattern eats it.
    // Anonymous, its own guard sends it to /login — it reached the route.
    const office = await request.get("/manage/office", { maxRedirects: 0 });
    expect(locationOf(office).pathname).toBe("/login");

    // ⛔ The bare builder URL is a redirect PAGE, not a config rule: a rule
    // cannot look up WHICH season to land on. Anonymous it would bounce to
    // /login, so it is driven signed in.
    await signInAs(page, "Manager");
    await page.goto("/obhl/schedule-builder");
    await expect(page).toHaveURL(/\/obhl\/seasons\/[0-9a-f-]{36}$/);
    await expect(
      page.getByRole("heading", { name: /Season setup/ }),
    ).toBeVisible();
  });
});
```

- [ ] **Step 3: Delete the sources**

```bash
git rm e2e/15-league-routing.spec.ts e2e/27-one-chrome.spec.ts
```

- [ ] **Step 4: Run**

Run: `PORT=3101 scripts/e2e-locked.sh e2e/09-access.spec.ts e2e/16-league-membership.spec.ts`
Expected: 45 passed (09-access 17; 16 unchanged at 28). `npm run typecheck` has already covered the two files that only lost a test.

- [ ] **Step 5: Verify nothing references the removed tests**

Run: `grep -rn "scorekeeper CAN reach the games they score\|captain sees only their team's lineup form\|the league name carries into the page title\|nav links point into the league and mark\|a season created in one league does not appear\|a section stays marked on its detail pages\|every old /manage/ URL still lands\|the bare schedule-builder URL lands\|the League Office keeps its prefix\|a manager sees the same header, with a staff row\|the staff row names no URL\|no Manage link and no View site link\|the old per-league URL redirects here\|the old /rules/edit URL still lands\|15-league-routing\|27-one-chrome" e2e src`
Expected: no output after the pointer rewrites.

- [ ] **Step 6: Commit (only if approved)**

```bash
git add -A e2e src
git commit -m "test(e2e): move routing and chrome access tests into 09-access"
```

---

### Task 5h: `09-access`, part 2 — 16 in, table-driven, with the auth and transfer ports

**Files:**
- Modify: `e2e/09-access.spec.ts`
- Delete: `e2e/16-league-membership.spec.ts`
- Temporary, never committed: `supabase/migrations/0051_tmp_red_proof.sql`, and one edit to `src/app/[league]/(manage)/audit/page.tsx`

**Interfaces:**
- Produces: `PAGE_REFUSALS`, `API_REFUSALS`, `type Db`, `anonClient()`, `captainFixture()`, `TOTALS_VIEWS`, plus 16's `signedInClient()`, `leagueId()`, `leaguesOf()`, `theOneLeague()`, `tamper()`, `submitAndSettle()`, `crossLeagueRosterRows()`, `teamRosterUrl()` and `openRosterEditor()`, all moved to module level unchanged. 15's `leaguesOfAccount(name)` calls become `leaguesOf(name)`.
- Consumes: `LEAD_IN`, `LEAD_OUT`, `SCORER_IN` and `SCORER_OUT`, resolved in `beforeAll`.

**Background (measured):**
- `verify-auth`'s one check no spec made: a captain inserting `game_rosters` for the other team is refused.
- `verify-transfers` #3: RLS reaches through a `security_invoker` view nested inside another (`v_skater_season_totals` over `v_skater_stats`; `v_goalie_season_totals` over `v_goalie_stats`, in `0044`).
- `verify-transfers` #4: no migration grants anon SELECT on those two views, so a probe is the only proof.

Final order in the file:
1. `Path 16 — Per-league routing` (from 5g).
2. `One chrome everywhere` (from 5g, minus its page-guard test).
3. `Path 17 — Per-league membership`, holding `beforeAll`, the page table, its control, 16's kept tests, the API table and the API controls.
4. `Legacy URLs`.

09's own `Path 15` describe dissolves into the page table.

- [ ] **Step 1: Apply the tables**

From 09 (as left by 5g), and 27's remaining test:

| Test | Action | Why |
|---|---|---|
| `scorekeeper cannot reach /seasons` | fold into `PAGE_REFUSALS` | (b) |
| `scorekeeper cannot reach /audit` | fold into `PAGE_REFUSALS` | (b) |
| `scorekeeper cannot reach /people` | fold into `PAGE_REFUSALS` | (b) |
| `unauthenticated user cannot reach /dashboard` | fold into `PAGE_REFUSALS` | (b) |
| `a page that left the nav is still refused by its own guard` | delete | duplicate of the row `One-league mgr is refused at /<another league>/seasons`: that account is Harbor-only, so `LEAD_OUT` is `obhl` |

From 16:

| Test | Action | Why |
|---|---|---|
| `the fixture still has the shape these tests need` | fold into `beforeAll` (Step 2) | a precondition |
| `a manager of one league reaches their own league's tools` | move | (b) the control for the page table |
| `` `a manager of another league is refused at ${path}` `` ×7 | fold into `PAGE_REFUSALS` | (b) |
| `a manager of another league reads the rules and cannot edit them` | delete | UI; the rules row of `API_REFUSALS` drives the refusal |
| `...and the database refuses the write even so` | fold into `API_REFUSALS` (`overwriting another league's rules`) and the own-league control | (b) |
| `a manager of another league sees a team page with no editor` | delete | UI; `a roster add cannot name another league's team` drives the refusal |
| `a scorekeeper cannot score another league's games` | move | (b) |
| `a game in another league is not scoreable` | move | (b) |
| `the switcher offers only the leagues the account belongs to` | delete | it refuses nothing; the page table drives the refusals |
| `People & Roles lists this league's staff only` | move | (b) |
| `Remove takes a person out of this league and leaves the account` | move | (a) |
| `adding an existing account cannot rewrite the role it holds elsewhere` | move | (b) |
| `a manager cannot change the role of someone who works a league they don't share` | move | (b) |
| `a manager can still promote someone whose leagues they all share` | move | (b) control |
| `a session cannot write another league's rows through the API` | fold into two `API_REFUSALS` rows | (b) |
| `a session cannot mint a manager of another league through the API` | fold into `API_REFUSALS` | (b) |
| `a session cannot rewrite its own role or player link through the API` | fold into `API_REFUSALS` | (b) (part 1) |
| `a session can still write its OWN league's rows through the API` | move + fold (Step 4) | (b) control |
| `the audit log of another league is not readable through the API` | fold into `API_REFUSALS` | (b) |
| `another league's staff are not readable through the API` | fold into `API_REFUSALS` | (b) |
| `a roster add cannot name another league's team` | move | (b) |
| `a manager can be removed from a league, but never yourself` | move | (b) |

16's two free-standing comment blocks move verbatim to the same places: `⚠️ The SERVER path…` and `⛔ TWO TESTS STOOD HERE AND ARE GONE`.

If part 1's fix loop changed the own-role or the mint test after this plan was written, its final assertions win: port those into the rows below.

- [ ] **Step 2: Write the shared pieces and `beforeAll`**

At module level, next to `admin()`:

```ts
type Db = ReturnType<typeof admin>;

/** An anonymous visitor's client: the publishable key and no session. */
function anonClient(): Db {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!,
    { auth: { autoRefreshToken: false, persistSession: false } },
  );
}

const TOTALS_VIEWS = ["v_skater_season_totals", "v_goalie_season_totals"] as const;

/**
 * The seeded captain's team, one of its scheduled games with nobody dressed
 * yet, and a skater from each side. An empty scoresheet, so a count after the
 * attempt means the attempt and nothing else.
 */
async function captainFixture(db: Db) {
  const { data: users } = await db.auth.admin.listUsers();
  const captainId = users!.users.find((u) => u.email === "captain@obhl.test")!.id;
  const { data: profile } = await db
    .from("profiles")
    .select("player_id")
    .eq("id", captainId)
    .single();
  const { data: row } = await db
    .from("team_players")
    .select("team_id, season_id")
    .eq("player_id", profile!.player_id)
    .eq("is_captain", true)
    .is("left_on", null)
    .limit(1)
    .single();
  const { data: games } = await db
    .from("games")
    .select("id, home_team_id, away_team_id")
    .eq("season_id", row!.season_id)
    .eq("status", "scheduled")
    .eq("is_draft", false)
    .or(`home_team_id.eq.${row!.team_id},away_team_id.eq.${row!.team_id}`)
    .order("scheduled_at", { ascending: false });
  let game: { id: string; home_team_id: string; away_team_id: string } | undefined;
  for (const g of games ?? []) {
    const { count } = await db
      .from("game_rosters")
      .select("id", { count: "exact", head: true })
      .eq("game_id", g.id);
    if (!count) {
      game = g;
      break;
    }
  }
  expect(game, "no scheduled game of the captain's team has an empty scoresheet").toBeTruthy();
  const otherTeamId =
    game!.home_team_id === row!.team_id ? game!.away_team_id : game!.home_team_id;
  const firstSkater = async (teamId: string) => {
    const { data } = await db
      .from("team_players")
      .select("player_id")
      .eq("season_id", row!.season_id)
      .eq("team_id", teamId)
      .is("left_on", null)
      .neq("position", "G")
      .limit(1)
      .single();
    return data!.player_id as string;
  };
  return {
    gameId: game!.id,
    ownTeamId: row!.team_id as string,
    ownPlayerId: await firstSkater(row!.team_id),
    otherTeamId,
    otherPlayerId: await firstSkater(otherTeamId),
  };
}
```

16's `beforeAll` moves inside `Path 17 — Per-league membership`. Append to its end:

```ts
    // Was the test "the fixture still has the shape these tests need".
    expect(LEAD_OUT, "need a second league to be refused from").toBeTruthy();
    expect(SCORER_OUT).toBeTruthy();
    // People & Roles compares two leagues' staff lists, which says nothing
    // unless the two confined accounts sit in different ones.
    expect(SCORER_IN).not.toBe(LEAD_IN);
```

- [ ] **Step 3: Write the page table**

First inside `Path 17 — Per-league membership`, after `beforeAll`. Carry 16's comments from inside `MANAGE_PATHS` verbatim above the seven `One-league mgr` rows: the ones on why `/teams`, `/rules`, `/import`, the bare `/schedule` and `/schedule-builder` are not listed.

```ts
  /** Swapped for `LEAD_OUT` inside each test: titles exist before `beforeAll` runs. */
  const OUT = "__another_league__";

  const PAGE_REFUSALS: {
    who: Role | "anonymous";
    path: string;
    lands: string | RegExp;
  }[] = [
    // A manager of another league: the role is right, the membership is not.
    { who: "One-league mgr", path: `/${OUT}/dashboard`, lands: "/" },
    { who: "One-league mgr", path: `/${OUT}/people`, lands: "/" },
    { who: "One-league mgr", path: `/${OUT}/seasons`, lands: "/" },
    { who: "One-league mgr", path: `/${OUT}/schedule/one-off`, lands: "/" },
    { who: "One-league mgr", path: `/${OUT}/schedule/repair`, lands: "/" },
    { who: "One-league mgr", path: `/${OUT}/announcements`, lands: "/" },
    { who: "One-league mgr", path: `/${OUT}/audit`, lands: "/" },
    // A scorekeeper: the membership is right, the role is not.
    { who: "Scorekeeper", path: "/obhl/seasons", lands: "/" },
    { who: "Scorekeeper", path: "/obhl/audit", lands: "/" },
    { who: "Scorekeeper", path: "/obhl/people", lands: "/" },
    // Nobody at all.
    { who: "anonymous", path: "/obhl/dashboard", lands: /\/login/ },
  ];

  for (const r of PAGE_REFUSALS) {
    test(`${r.who} is refused at ${r.path.replace(OUT, "<another league>")}`, async ({
      page,
    }) => {
      // The picker, where a wrong role or a wrong league lands: the one page
      // that needs no league.
      if (r.who !== "anonymous") await signInAs(page, r.who);
      await page.goto(r.path.replace(OUT, LEAD_OUT));
      await expect(page).toHaveURL(r.lands);
    });
  }
```

Then `a manager of one league reaches their own league's tools`, then 16's nine moved tests in their original order.

- [ ] **Step 4: Write the API table and its controls**

After 16's moved tests:

```ts
  /**
   * The refusals the DATABASE makes, to a session talking to PostgREST with no
   * page in between. `arrange` runs on the admin client and returns the attempt,
   * the read-back that proves nothing landed, and the restore for a red run.
   *
   * ⛔ READ THE ROW, NOT THE ERROR. An RLS-refused UPDATE matches no rows and
   * reports no error, so an assertion on `error` passes whether the policy is
   * there or not.
   */
  type ApiRefusal = {
    title: string;
    /** The session's email, or null for an anonymous visitor. */
    as: string | null;
    arrange: (db: Db) => Promise<{
      attempt: (client: Db) => Promise<void>;
      assertRefused: (db: Db) => Promise<void>;
      restore?: (db: Db) => Promise<void>;
    }>;
  };

  const API_REFUSALS: ApiRefusal[] = [
    {
      title: "renaming a season in another league",
      as: "single-league-lead@obhl.test",
      arrange: async (db) => {
        const { data: foreign } = await db
          .from("seasons")
          .select("id, name")
          .eq("league_id", await leagueId(LEAD_OUT))
          .limit(1)
          .single();
        return {
          attempt: async (client) => {
            await client
              .from("seasons")
              .update({ name: "Hijacked" })
              .eq("id", foreign!.id);
          },
          assertRefused: async (db) => {
            const { data } = await db
              .from("seasons")
              .select("name")
              .eq("id", foreign!.id)
              .single();
            expect(data!.name).toBe(foreign!.name);
          },
          restore: async (db) => {
            await db
              .from("seasons")
              .update({ name: foreign!.name })
              .eq("id", foreign!.id);
          },
        };
      },
    },
    {
      title: "posting an announcement into another league",
      as: "single-league-lead@obhl.test",
      arrange: async () => {
        const title = `Hijack ${Date.now()}`;
        const foreignLeague = await leagueId(LEAD_OUT);
        return {
          attempt: async (client) => {
            await client
              .from("announcements")
              .insert({ league_id: foreignLeague, title, body: "no" });
          },
          assertRefused: async (db) => {
            const { data } = await db
              .from("announcements")
              .select("id")
              .eq("title", title);
            expect(data ?? []).toHaveLength(0);
          },
          restore: async (db) => {
            await db.from("announcements").delete().eq("title", title);
          },
        };
      },
    },
    {
      title: "overwriting another league's rules",
      as: "single-league-lead@obhl.test",
      arrange: async (db) => {
        const foreignLeague = await leagueId(LEAD_OUT);
        const { data: before } = await db
          .from("league_rules")
          .select("content")
          .eq("league_id", foreignLeague)
          .maybeSingle();
        return {
          attempt: async (client) => {
            await client
              .from("league_rules")
              .upsert(
                { league_id: foreignLeague, content: { hijacked: true } },
                { onConflict: "league_id" },
              );
          },
          assertRefused: async (db) => {
            const { data: after } = await db
              .from("league_rules")
              .select("content")
              .eq("league_id", foreignLeague)
              .maybeSingle();
            expect(after?.content ?? null).toEqual(before?.content ?? null);
          },
          restore: async (db) => {
            if (before) {
              await db
                .from("league_rules")
                .update({ content: before.content })
                .eq("league_id", foreignLeague);
            } else {
              await db.from("league_rules").delete().eq("league_id", foreignLeague);
            }
          },
        };
      },
    },
    {
      title: "writing a profile that also works a league the session does not",
      as: "single-league-lead@obhl.test",
      arrange: async (db) => {
        const shared = await leagueId(LEAD_IN);
        const { data: victim } = await db
          .from("profiles")
          .select("id, role, display_name")
          .eq("display_name", "Single League Scorer")
          .single();
        expect(victim!.role, "victim must start as a non-manager").toBe("scorekeeper");
        return {
          attempt: async (client) => {
            // Step 1 is PERMITTED, and asserted so: granting someone a league
            // you manage is the flow the membership model exists for. Refused,
            // step 2 would fail for that reason and prove nothing.
            const granted = await client
              .from("profile_leagues")
              .insert({ profile_id: victim!.id, league_id: shared })
              .select();
            expect(
              granted.error,
              "granting a league you manage should still be allowed",
            ).toBeNull();
            // `display_name`, not `role`: 0050 refuses every session role write,
            // so a role write here would pass without 0033's containment policy.
            await client
              .from("profiles")
              .update({ display_name: "Minted By Another League's Manager" })
              .eq("id", victim!.id);
          },
          assertRefused: async (db) => {
            const { data: after } = await db
              .from("profiles")
              .select("display_name")
              .eq("id", victim!.id)
              .single();
            expect(after!.display_name).toBe(victim!.display_name);
          },
          restore: async (db) => {
            await db
              .from("profiles")
              .update({ display_name: victim!.display_name })
              .eq("id", victim!.id);
            await db
              .from("profile_leagues")
              .delete()
              .eq("profile_id", victim!.id)
              .eq("league_id", shared);
          },
        };
      },
    },
    {
      title: "rewriting its own role or player link",
      as: "single-league-scorer@obhl.test",
      arrange: async (db) => {
        // 0009's "own profile update" names no columns, so before 0050 any
        // signed-in account could make itself a manager, or link itself to
        // another league's captain. Measured on the local stack 2026-09-13.
        const { data: self } = await db
          .from("profiles")
          .select("id, role, player_id")
          .eq("display_name", "Single League Scorer")
          .single();
        const { data: players } = await db.from("players").select("id").limit(2);
        const other = (players ?? []).find((p) => p.id !== self!.player_id)!;
        return {
          attempt: async (client) => {
            await client
              .from("profiles")
              .update({ role: "league_manager" })
              .eq("id", self!.id);
            await client
              .from("profiles")
              .update({ player_id: other.id })
              .eq("id", self!.id);
          },
          assertRefused: async (db) => {
            const { data: after } = await db
              .from("profiles")
              .select("role, player_id")
              .eq("id", self!.id)
              .single();
            expect(after!.role).toBe(self!.role);
            expect(after!.player_id).toBe(self!.player_id);
          },
          restore: async (db) => {
            await db
              .from("profiles")
              .update({ role: self!.role, player_id: self!.player_id })
              .eq("id", self!.id);
          },
        };
      },
    },
    {
      title: "reading another league's audit log",
      as: "single-league-lead@obhl.test",
      arrange: async (db) => {
        // Reverting an audit entry is a write, so who can READ the log is who
        // can undo the league.
        const theirs = await leagueId(LEAD_OUT);
        const { count: exists } = await db
          .from("audit_log")
          .select("id", { count: "exact", head: true })
          .eq("league_id", theirs);
        expect(exists, "the other league has no audit entries to hide").toBeGreaterThan(0);
        let seen: number | null = null;
        return {
          attempt: async (client) => {
            const { count } = await client
              .from("audit_log")
              .select("*", { count: "exact", head: true })
              .eq("league_id", theirs);
            seen = count;
          },
          assertRefused: async () => {
            expect(seen ?? 0).toBe(0);
          },
        };
      },
    },
    {
      title: "reading the staff of a league it does not share",
      as: "single-league-lead@obhl.test",
      arrange: async () => {
        let visible = new Set<string>();
        return {
          attempt: async (client) => {
            const { data: rows } = await client.from("profiles").select("id");
            visible = new Set((rows ?? []).map((r) => r.id as string));
          },
          assertRefused: async (db) => {
            const { data: sharedMembers } = await db
              .from("profile_leagues")
              .select("profile_id")
              .eq("league_id", await leagueId(LEAD_IN));
            const allowed = new Set(
              (sharedMembers ?? []).map((r) => r.profile_id as string),
            );
            // ⚠️ PLUS EVERY ACCOUNT THAT BELONGS TO NO LEAGUE AT ALL. "manager
            // write profiles" is `for all`, so its USING clause applies to SELECT
            // too, and `contains_leagues_of` passes vacuously for an account in no
            // league — deliberately: adding a brand-new account writes a profile
            // that belongs to nothing yet.
            const { data: everyMembership } = await db
              .from("profile_leagues")
              .select("profile_id");
            const assigned = new Set(
              (everyMembership ?? []).map((r) => r.profile_id as string),
            );
            const { data: tiers } = await db.from("league_office").select("profile_id");
            const inOffice = new Set((tiers ?? []).map((r) => r.profile_id as string));
            const { data: everyProfile } = await db.from("profiles").select("id");
            for (const p of everyProfile ?? [])
              if (!assigned.has(p.id) && !inOffice.has(p.id)) allowed.add(p.id);

            expect(visible.size).toBeGreaterThan(0);
            for (const id of visible) expect(allowed.has(id)).toBe(true);

            // ⛔ AND THE OFFICE STAYS OUT. Both office accounts belong to no league,
            // so only the tier keeps them unreadable by a plain manager. The size
            // check stops an empty `league_office` read passing vacuously.
            expect(inOffice.size).toBeGreaterThan(0);
            for (const id of inOffice) expect(visible.has(id)).toBe(false);

            // Named: the set check cannot fail while every seeded account happens
            // to share a league with this one, and this account does not.
            const { data: outsider } = await db
              .from("profiles")
              .select("id")
              .eq("display_name", "Single League Scorer")
              .single();
            expect(visible.has(outsider!.id)).toBe(false);
          },
        };
      },
    },
    {
      // Ported from scripts/verify-auth.mjs: the one check it made that no spec did.
      title: "dressing a player on the other team as a captain",
      as: "captain@obhl.test",
      arrange: async (db) => {
        const cap = await captainFixture(db);
        const key = {
          game_id: cap.gameId,
          team_id: cap.otherTeamId,
          player_id: cap.otherPlayerId,
        };
        const dressed = async (d: Db) => {
          const { count } = await d
            .from("game_rosters")
            .select("id", { count: "exact", head: true })
            .eq("game_id", key.game_id)
            .eq("team_id", key.team_id)
            .eq("player_id", key.player_id);
          return count ?? 0;
        };
        expect(await dressed(db), "the fixture game must start empty").toBe(0);
        return {
          attempt: async (client) => {
            await client.from("game_rosters").insert(key);
          },
          assertRefused: async (db) => {
            expect(await dressed(db)).toBe(0);
          },
          restore: async (db) => {
            await db.from("game_rosters").delete().eq("game_id", key.game_id);
          },
        };
      },
    },
    {
      // Ported from scripts/verify-transfers.mjs (#3): RLS has to reach through
      // a security_invoker view nested inside another, or a staged league's
      // stats are public.
      title: "reading a staged league's season totals anonymously",
      as: null,
      arrange: async (db) => {
        const { data: league } = await db
          .from("leagues")
          .select("id")
          .eq("slug", "harbor")
          .single();
        const { data: season } = await db
          .from("seasons")
          .select("id")
          .eq("league_id", league!.id)
          .eq("is_active", true)
          .single();
        const rowsOf = async (client: Db, view: string) => {
          const { data } = await client
            .from(view)
            .select("player_id")
            .eq("season_id", season!.id);
          return (data ?? []).length;
        };
        // The control: while public, the visitor DOES read rows — so an empty
        // read below is the league going private, not an empty view.
        for (const view of TOTALS_VIEWS) {
          expect(await rowsOf(anonClient(), view), `${view} while public`).toBeGreaterThan(0);
        }
        await db.from("leagues").update({ is_public: false }).eq("id", league!.id);
        const seen: Record<string, number> = {};
        return {
          attempt: async (client) => {
            for (const view of TOTALS_VIEWS) seen[view] = await rowsOf(client, view);
          },
          assertRefused: async () => {
            for (const view of TOTALS_VIEWS) expect(seen[view], view).toBe(0);
          },
          restore: async (db) => {
            await db.from("leagues").update({ is_public: true }).eq("id", league!.id);
          },
        };
      },
    },
  ];

  for (const row of API_REFUSALS) {
    test(`the API refuses ${row.title}`, async () => {
      const db = admin();
      const client = row.as ? await signedInClient(row.as) : anonClient();
      const step = await row.arrange(db);
      try {
        await step.attempt(client);
        await step.assertRefused(db);
      } finally {
        await step.restore?.(db);
        if (row.as) await client.auth.signOut();
      }
    });
  }

  test("a session can still write its OWN league's rows through the API", async () => {
    // The control for the table above: policies that refused everything would
    // pass every row. The same session, its own league's season and rules.
    const client = await signedInClient("single-league-lead@obhl.test");
    const db = admin();
    const ownLeague = await leagueId(LEAD_IN);
    const { data: own } = await db
      .from("seasons")
      .select("id, name")
      .eq("league_id", ownLeague)
      .limit(1)
      .single();
    const { data: rules } = await db
      .from("league_rules")
      .select("content")
      .eq("league_id", ownLeague)
      .maybeSingle();
    try {
      const { data: updated, error } = await client
        .from("seasons")
        .update({ name: own!.name })
        .eq("id", own!.id)
        .select("id");
      expect(error).toBeNull();
      expect(updated ?? []).toHaveLength(1);

      const { data: allowed } = await client
        .from("league_rules")
        .upsert(
          { league_id: ownLeague, content: { control: true } },
          { onConflict: "league_id" },
        )
        .select("league_id");
      expect(allowed ?? []).toHaveLength(1);
    } finally {
      await db.from("seasons").update({ name: own!.name }).eq("id", own!.id);
      if (rules) {
        await db
          .from("league_rules")
          .update({ content: rules.content })
          .eq("league_id", ownLeague);
      } else {
        await db.from("league_rules").delete().eq("league_id", ownLeague);
      }
      await client.auth.signOut();
    }
  });

  test("a captain can still dress a player on their own team through the API", async () => {
    // Ported from scripts/verify-auth.mjs: the control for the captain row.
    const db = admin();
    const cap = await captainFixture(db);
    const client = await signedInClient("captain@obhl.test");
    try {
      await client.from("game_rosters").insert({
        game_id: cap.gameId,
        team_id: cap.ownTeamId,
        player_id: cap.ownPlayerId,
      });
      const { count } = await db
        .from("game_rosters")
        .select("id", { count: "exact", head: true })
        .eq("game_id", cap.gameId)
        .eq("team_id", cap.ownTeamId)
        .eq("player_id", cap.ownPlayerId);
      expect(count, "the captain's own-team write was refused too").toBe(1);
    } finally {
      await db.from("game_rosters").delete().eq("game_id", cap.gameId);
      await client.auth.signOut();
    }
  });

  test("an anonymous visitor can read a public league's season totals", async () => {
    // Ported from scripts/verify-transfers.mjs (#4). No migration grants SELECT
    // on these views, so whether anon holds it is settled by asking — the same
    // question a browser asks — not by reading information_schema.
    const db = admin();
    const { data: league } = await db
      .from("leagues")
      .select("id")
      .eq("slug", "harbor")
      .single();
    const { data: season } = await db
      .from("seasons")
      .select("id")
      .eq("league_id", league!.id)
      .eq("is_active", true)
      .single();
    for (const view of TOTALS_VIEWS) {
      const { data, error } = await anonClient()
        .from(view)
        .select("season_id")
        .eq("season_id", season!.id)
        .limit(1);
      expect(error?.code, `${view}: ${error?.message}`).not.toBe("42501");
      expect(data ?? [], `${view} returned no rows`).not.toHaveLength(0);
    }
  });
```

- [ ] **Step 5: Delete 16**

```bash
git rm e2e/16-league-membership.spec.ts
```

Run: `npm run typecheck && npx eslint e2e/09-access.spec.ts`
Expected: no errors.

- [ ] **Step 6: Red proof 1 — the page table**

In `src/app/[league]/(manage)/audit/page.tsx`, change `import { requireLeagueManager } from "@/lib/auth/guards";` to `import { requireLeagueManager, requireRole } from "@/lib/auth/guards";`, and `await requireLeagueManager(league.id);` to `await requireRole("league_manager");`.

Run: `PORT=3101 scripts/e2e-locked.sh e2e/09-access.spec.ts -g "is refused at"`
Expected: exactly 1 failed, `One-league mgr is refused at /<another league>/audit`; the other 10 pass. Restore both lines; `git diff "src/app/[league]/(manage)/audit/page.tsx"` prints nothing.

- [ ] **Step 7: Red proof 2 — the API table**

Create `supabase/migrations/0051_tmp_red_proof.sql`:

```sql
-- RED PROOF ONLY. Delete before the green run. Never commit.
create policy "tmp red proof: any roster insert" on public.game_rosters
  for insert to authenticated with check (true);
drop trigger profiles_privileged_columns_are_server_only on public.profiles;
alter view public.v_skater_season_totals set (security_invoker = false);
alter view public.v_goalie_season_totals set (security_invoker = false);
```

Run: `PORT=3101 scripts/e2e-locked.sh e2e/09-access.spec.ts -g "the API refuses|can still|can read a public"`
Expected: exactly 3 failed:
- `the API refuses dressing a player on the other team as a captain`
- `the API refuses rewriting its own role or player link`
- `the API refuses reading a staged league's season totals anonymously`

The other 10 pass: six API rows and four controls. The pattern also matches 16's `a manager can still promote someone whose leagues they all share`. If a targeted row stays green, stop and report: the loosening did not reach that guard, so the row proves nothing yet.

- [ ] **Step 8: Red proof 3 — the grant control**

Replace the migration's body with:

```sql
-- RED PROOF ONLY. Delete before the green run. Never commit.
revoke select on public.v_skater_season_totals from anon;
revoke select on public.v_goalie_season_totals from anon;
```

Run: `PORT=3101 scripts/e2e-locked.sh e2e/09-access.spec.ts -g "the API refuses reading a staged|can read a public"`
Expected: both FAIL. The control fails on `42501`, and the staged-league row fails in its own `while public` control.

Then:

```bash
rm supabase/migrations/0051_tmp_red_proof.sql
git status --short supabase/migrations
```

Expected: `git status` prints nothing.

- [ ] **Step 9: Run green**

Run: `PORT=3101 scripts/e2e-locked.sh e2e/09-access.spec.ts`
Expected: 45 passed:

| Group | Tests |
|---|---|
| page table | 11 |
| its control | 1 |
| 15's moved tests | 10 |
| 27's other-league test | 1 |
| 16's moved tests | 9 |
| API table | 9 |
| API controls | 3 |
| legacy table | 1 |

- [ ] **Step 10: Verify nothing references the removed tests**

Run: `grep -rn "the fixture still has the shape these tests need\|a manager of another league is refused at\|reads the rules and cannot edit them\|and the database refuses the write even so\|sees a team page with no editor\|the switcher offers only the leagues\|a session cannot write another league's rows\|a session cannot mint a manager\|a session cannot rewrite its own role\|the audit log of another league is not readable\|another league's staff are not readable\|a page that left the nav is still refused\|scorekeeper cannot reach /\|unauthenticated user cannot reach\|16-league-membership\|MANAGE_PATHS" e2e src`
Expected: no output after the pointer rewrites. Part 1's plan and the design doc still name these titles; neither is under `e2e` or `src`.

- [ ] **Step 11: Commit (only if approved)**

```bash
git add -A e2e src
git status --short supabase/migrations
git commit -m "test(e2e): one access spec, table-driven; port verify-auth and the view RLS checks"
```

---

### Task 5i: `10-roster-changes`, then the first full-suite checkpoint

**Files:**
- Create: `e2e/10-roster-changes.spec.ts`
- Delete: `e2e/19-transfer.spec.ts`, `e2e/22-roster-editing.spec.ts`
- Temporary, never committed: one edit to `src/lib/actions/rosters.ts` (`movePlayerToTeam`)

**Interfaces:**
- Produces: `e2e/10-roster-changes.spec.ts` with `admin()` and `signInAs()`, and new `emptyScoresheetGame(seasonId)` and `restoreGame(game)`.
- From 22: `activeSeason()`, `teamName()`, `playerName()`, `openRoster(page, slug, team)`, `manageRoster()`, `openDialogFor()`, `rowFor()`, `search()`, and `scratchSkater()`, which gains `position?: "F" | "D" | "G"`.
- From 19: `subjectRow()` and `subjectName()`. 19's `openRoster(page, team)` calls become `openRoster(page, "obhl", team)`, and its `rosterRows`/`openDialogFor`/`manageRoster` copies are dropped for 22's.

The file opens with: `/** Changing a roster mid-season — transfers, moves, archives, renames, numbers — and what each leaves in the stats. */`

**Background (read 2026-09-13; this corrects the design):** the design called `verify-transfers` #2 a duplicate of 22. It is not.
- `supabase/seed.sql`'s game builder sets `home_goalie_id`/`away_goalie_id` on every game it finalizes.
- `v_goalie_stats`' explicit-pick branch joins no roster row.
- So 22's `moving a goalie who has dressed leaves the old team's record intact`, which picks a seeded goalie, passes even against a move that DELETES the old roster row.
- Only the dressed-goalie fallback, which is what #2 used, inner-joins `team_players`.

This task rebuilds that test on the fallback and shows it red with the move turned into a delete.

- [ ] **Step 1: Confirm the specs that now run after 19 and 22 read no rosters**

Run: `grep -n "team_players\|Manage roster\|rosterRows\|jersey\|v_goalie\|v_skater\|transfer" e2e/11-schedule-builder.spec.ts e2e/23-schedule-constraints.spec.ts e2e/28-schedule-form-state.spec.ts e2e/31-stale-draft.spec.ts e2e/14-one-off-game.spec.ts e2e/29-schedule-repair.spec.ts e2e/30-schedule-edits.spec.ts`
Expected: no output (measured 2026-09-13). Any hit is a roster read that now runs after 19 and 22 have moved people: stop and report it.

- [ ] **Step 2: Apply the tables**

From 19, into `test.describe("Transfers")`:

| Test | Action | Why |
|---|---|---|
| `a clashing jersey number is refused, and nothing moves` | delete | a message about input; no letter |
| `a transferred player leaves one roster and joins the other` | move | (a) |

From 22, keeping `Path 22 — Roster editing`:

| Test | Action | Why |
|---|---|---|
| `moving a goalie who has dressed leaves the old team's record intact` | rewrite (Step 3) | (c), porting `verify-transfers` #2 and #5 |
| `adding someone already on another team moves them off it` | move | (a) the add form's move |
| `archiving in one league leaves the person in the other league's picker` | move | (b) league scope |
| `a cross-league rename is refused, and the refusal names the League Office` | move | (b) |
| `editing a jersey number does not disturb game history` | move | (c) GP unchanged |
| `a clashing jersey number is refused with the wearer named` | delete | a message about input; no letter |

New: `the goalie of record is credited, and empty-net goals are not charged to him` (Step 4).

In `scratchSkater`, add `position?: "F" | "D" | "G";` to `opts`, and change `position: "F",` to `position: opts.position ?? "F",`.

Add at module level:

```ts
/**
 * A scheduled regular game in this season with nobody dressed yet, with every
 * column a test here writes, so `restoreGame` can put it back exactly.
 */
async function emptyScoresheetGame(seasonId: string) {
  const db = admin();
  const { data: games } = await db
    .from("games")
    .select(
      "id, home_team_id, away_team_id, status, home_goals, away_goals, result_type, home_goalie_id, away_goalie_id, home_empty_net_against, finalized_at, finalized_by",
    )
    .eq("season_id", seasonId)
    .eq("status", "scheduled")
    .eq("game_type", "regular")
    .eq("is_draft", false)
    .order("scheduled_at", { ascending: false });
  for (const g of games ?? []) {
    const { count } = await db
      .from("game_rosters")
      .select("id", { count: "exact", head: true })
      .eq("game_id", g.id);
    if (!count) return g;
  }
  throw new Error("no scheduled game in this season has an empty scoresheet");
}

async function restoreGame(g: Awaited<ReturnType<typeof emptyScoresheetGame>>) {
  const db = admin();
  await db.from("game_rosters").delete().eq("game_id", g.id);
  await db
    .from("games")
    .update({
      status: g.status,
      home_goals: g.home_goals,
      away_goals: g.away_goals,
      result_type: g.result_type,
      home_goalie_id: g.home_goalie_id,
      away_goalie_id: g.away_goalie_id,
      home_empty_net_against: g.home_empty_net_against,
      finalized_at: g.finalized_at,
      finalized_by: g.finalized_by,
    })
    .eq("id", g.id);
}
```

- [ ] **Step 3: Rebuild the goalie-move test on the fallback branch**

Replace `moving a goalie who has dressed leaves the old team's record intact` and its docblock with:

```ts
  /**
   * The regression 0036 exists to prevent, reached through the app's own move.
   *
   * ⛔ ON A GOALIE WITH NO PICK, AND THAT IS THE FIXTURE'S WHOLE POINT. The seed
   * names a goalie of record on every game it finalizes, and `v_goalie_stats`'
   * explicit-pick branch joins no roster row, so a seeded goalie's record
   * survives even a move that DELETES the old row. Only the dressed-goalie
   * fallback inner-joins `team_players`. (Ported from verify-transfers #2.)
   */
  test("moving a goalie who has dressed leaves the old team's record intact", async ({
    page,
  }) => {
    const db = admin();
    const { seasonId } = await activeSeason("obhl");
    const game = await emptyScoresheetGame(seasonId);
    const fromId = game.home_team_id as string;
    const { data: enrolled } = await db
      .from("season_teams")
      .select("team_id")
      .eq("season_id", seasonId)
      .order("team_id", { ascending: true });
    const toId = (enrolled ?? [])
      .map((e) => e.team_id as string)
      .find((t) => t !== fromId && t !== game.away_team_id)!;
    const fromTeam = await teamName(fromId);
    const toTeam = await teamName(toId);
    const { playerId, name: who } = await scratchSkater({
      seasonId,
      teamId: fromId,
      tag: "goalie",
      position: "G",
    });

    const record = async () => {
      const { data } = await db
        .from("v_goalie_stats")
        .select("gp, wins, losses, ties, ga, so, gaa")
        .eq("season_id", seasonId)
        .eq("player_id", playerId)
        .eq("team_id", fromId)
        .maybeSingle();
      return data;
    };

    try {
      await db
        .from("game_rosters")
        .insert({ game_id: game.id, team_id: fromId, player_id: playerId });
      // No `home_goalie_id`: the record has to come through the fallback.
      await db
        .from("games")
        .update({
          status: "final",
          home_goals: 2,
          away_goals: 1,
          result_type: "regulation",
          finalized_at: new Date().toISOString(),
        })
        .eq("id", game.id);
      const before = await record();
      expect(before, "the fallback should credit the only dressed goalie").toMatchObject({
        gp: 1,
        wins: 1,
      });

      await signInAs(page, "Manager");
      await openRoster(page, "obhl", fromTeam);
      const dialog = await openDialogFor(page, rowFor(page, who));
      await dialog.getByLabel(/to team/i).selectOption({ label: toTeam });
      await dialog.getByLabel(/jersey number/i).fill("");
      await dialog.getByRole("button", { name: /confirm transfer/i }).click();
      await page.waitForLoadState("networkidle");
      // ⛔ Shut the dialog before reading anything behind it: Radix marks the
      // rest of the document `aria-hidden` while a modal is open.
      await expect(dialog.getByRole("status")).toHaveCount(0);
      await page.keyboard.press("Escape");
      await expect(dialog).toBeHidden();
      await expect(
        manageRoster(page).getByRole("cell", { name: who }),
      ).toHaveCount(0);

      expect(
        await record(),
        `${fromTeam}'s goalie record for ${who} must survive the move`,
      ).toEqual(before);

      // ── Ported from verify-transfers #5: the season totals roll the teams up
      // into one row, under the team the goalie is on NOW.
      const { data: totals } = await db
        .from("v_goalie_season_totals")
        .select("gp, gaa, team_id")
        .eq("season_id", seasonId)
        .eq("player_id", playerId)
        .maybeSingle();
      expect(totals?.gp).toBe(before!.gp);
      expect(totals?.team_id, "the totals row names the current team").toBe(toId);
      expect(Number(totals?.gaa)).toBe(
        Math.round((before!.ga / before!.gp) * 100) / 100,
      );
    } finally {
      await restoreGame(game);
      await db.from("team_players").delete().eq("player_id", playerId);
      await db.from("players").delete().eq("id", playerId);
    }
  });
```

- [ ] **Step 4: Port `verify-transfers` #1**

Add inside `Path 22 — Roster editing`:

```ts
  test("the goalie of record is credited, and empty-net goals are not charged to him", async () => {
    // Ported from scripts/verify-transfers.mjs (#1). Two goalies dressed, so
    // crediting either would be a guess: the pick decides. Both are created
    // here, because earlier specs move the seed's one goalie per team.
    const db = admin();
    const { seasonId } = await activeSeason("obhl");
    const game = await emptyScoresheetGame(seasonId);
    const teamId = game.home_team_id as string;
    const picked = await scratchSkater({ seasonId, teamId, tag: "picked", position: "G" });
    const other = await scratchSkater({ seasonId, teamId, tag: "benched", position: "G" });
    const AWAY_GOALS = 5;
    const EMPTY_NET = 2;
    const record = async (playerId: string) => {
      const { data } = await db
        .from("v_goalie_stats")
        .select("gp, ga, gaa")
        .eq("season_id", seasonId)
        .eq("player_id", playerId)
        .eq("team_id", teamId)
        .maybeSingle();
      return data;
    };

    try {
      await db.from("game_rosters").insert(
        [picked, other].map((g) => ({
          game_id: game.id,
          team_id: teamId,
          player_id: g.playerId,
        })),
      );
      await db
        .from("games")
        .update({
          status: "final",
          home_goals: 1,
          away_goals: AWAY_GOALS,
          result_type: "regulation",
          home_goalie_id: picked.playerId,
          home_empty_net_against: EMPTY_NET,
          finalized_at: new Date().toISOString(),
        })
        .eq("id", game.id);

      const credited = await record(picked.playerId);
      expect(credited, "the picked goalie is credited").toMatchObject({
        gp: 1,
        ga: AWAY_GOALS - EMPTY_NET,
      });
      expect(Number(credited!.gaa), "GAA comes from the adjusted GA").toBe(
        AWAY_GOALS - EMPTY_NET,
      );
      expect(
        (await record(other.playerId))?.gp ?? 0,
        "the other dressed goalie is not credited",
      ).toBe(0);
    } finally {
      await restoreGame(game);
      for (const g of [picked, other]) {
        await db.from("team_players").delete().eq("player_id", g.playerId);
        await db.from("players").delete().eq("id", g.playerId);
      }
    }
  });
```

- [ ] **Step 5: Delete the sources and prove both new tests can fail**

```bash
git rm e2e/19-transfer.spec.ts e2e/22-roster-editing.spec.ts
```

1. In `src/lib/actions/rosters.ts`, inside `movePlayerToTeam`, replace `.update({ left_on, is_captain: false, night_of_week: null })` with `.delete()`.
   Run: `PORT=3101 scripts/e2e-locked.sh e2e/10-roster-changes.spec.ts -g "moving a goalie who has dressed"`
   Expected: FAIL at `…must survive the move` (received `null`). Restore; `git diff src/lib/actions/rosters.ts` prints nothing.
2. In the #1 test, temporarily change `home_goalie_id: picked.playerId` to `home_goalie_id: other.playerId`.
   Run: `PORT=3101 scripts/e2e-locked.sh e2e/10-roster-changes.spec.ts -g "goalie of record is credited"`
   Expected: FAIL at `the picked goalie is credited`. Restore.

- [ ] **Step 6: Run the file**

Run: `PORT=3101 scripts/e2e-locked.sh e2e/10-roster-changes.spec.ts`
Expected: 7 passed.

- [ ] **Step 7: Full-suite checkpoint 1**

Run: `ls e2e/*.spec.ts`
Expected: exactly these 15 files, which the next command names.

Run: `PORT=3101 scripts/e2e-locked.sh e2e/01-public.spec.ts e2e/02-auth.spec.ts e2e/03-season-setup.spec.ts e2e/04-rosters.spec.ts e2e/05-scoring-night.spec.ts e2e/07-staff.spec.ts e2e/09-access.spec.ts e2e/10-roster-changes.spec.ts e2e/11-schedule-builder.spec.ts e2e/14-one-off-game.spec.ts e2e/23-schedule-constraints.spec.ts e2e/28-schedule-form-state.spec.ts e2e/29-schedule-repair.spec.ts e2e/30-schedule-edits.spec.ts e2e/31-stale-draft.spec.ts`
Expected: 187 passed (186 passed and 1 skipped if the local mail API is down):

| File | Tests |
|---|---|
| `01-public` | 16 |
| `02-auth` | 8 |
| `03-season-setup` | 12 |
| `04-rosters` | 6 |
| `05-scoring-night` | 18 |
| `07-staff` | 20 |
| `09-access` | 45 |
| `10-roster-changes` | 7 |
| `11-schedule-builder` | 17 |
| `14-one-off-game` | 2 |
| `23-schedule-constraints` | 8 |
| `28-schedule-form-state` | 3 |
| `29-schedule-repair` | 5 |
| `30-schedule-edits` | 15 |
| `31-stale-draft` | 5 |

If a failure looks order-dependent (a test relying on what an earlier file wrote), re-run that file alone before calling it a regression, and report both runs.

- [ ] **Step 8: Verify nothing references the removed tests**

Run: `grep -rn "a clashing jersey number is refused\|19-transfer\|22-roster-editing" e2e src`
Expected: no output after the pointer rewrites.

- [ ] **Step 9: Commit (only if approved)**

```bash
git add -A e2e src
git status --short src/lib/actions/rosters.ts
git commit -m "test(e2e): one roster-changes spec; port verify-transfers #1, #2 and #5"
```

---

### Task 5j: `11-schedule-build`

**Files:**
- Rename: `e2e/11-schedule-builder.spec.ts` → `e2e/11-schedule-build.spec.ts`
- Delete: `e2e/23-schedule-constraints.spec.ts`, `e2e/28-schedule-form-state.spec.ts`, `e2e/31-stale-draft.spec.ts`

**Interfaces:**
- Produces: `e2e/11-schedule-build.spec.ts` with `admin()`, `signInAs()`, and one copy each of `fallStart()`, `goToFallSeasonSetup()` (on `/obhl/seasons`), `expectGenerateFormUsable()` (11's full-length copy) and `AFTER_GENERATE`.
- From 23: `secondTuesday()`, `firstTeamName()`, `requestList()` (one copy, shared with 28), `outcomeCard()`, `clearRequests()`.
- From 28: `SLOT_TIMES`, `skipDate()`, `skipDay()`, `MONTH_ABBR`, `skipChip()`, `skipMonthsAhead()`, `aWeekIntoSeason()`, `fillEverything()`.
- From 31: `YEAR`, `STALE_SEASON` (was `SEASON`), `TZ`, `dateKey()`, `timeKey()`, `offsetOn()`, `plusDays()`, `today()`, `WEEKDAY_LABEL`, `AGE_WEEKS`, `FIRST_NIGHT_IN`, `leagueId()`, `seedStaleSeason()` (was `seedSeason`), `draftGames()`, `publishedGames()`, `ageDraftBy()`. 31's `longDate` is used only by a deleted test: delete it.

The file opens with: `/** Building a season's schedule: generate, publish, replace and remove, a manager request, and a draft that aged. */`

- [ ] **Step 1: Rename and apply the tables**

```bash
git mv e2e/11-schedule-builder.spec.ts e2e/11-schedule-build.spec.ts
```

From 11:

| Test | Action | Why |
|---|---|---|
| `the old builder URL lands on its season's setup page, panel and all` | delete | duplicate of the bare-builder half of 09-access's `every legacy URL still lands on its page` |
| `scorekeeper cannot reach /schedule-builder` | keep | (b) |
| `generate form has the length toggle and core fields` | delete | design: presence |
| `length toggle swaps games-per-team for an end date` | delete | a UI detail; no letter |
| `weekday checkboxes are all present` | delete | design: presence |
| `one-off scheduling has moved off the builder, behind a link` | delete | design: presence |
| `empty draft state shows before a draft is generated` | delete | design: presence |
| `generates a balanced draft with equal games per team` | keep | (a) + (d) equal games per team |
| `Try a different schedule returns a different schedule` | delete | design |
| `a generate reports its result instead of finishing in silence` | delete | the generate smoke asserts the result card |
| `a generate with no game nights says so rather than doing nothing` | delete | input validation; no letter |
| `the first-game-night field is bounded below by today` | delete | browser-side; the server test below is the guard |
| `a past first game night is refused by the server, not just the browser` | keep | (e) stale publish: the one-way door, shut at generate |
| `spacing checks report every goal the generator models` | delete | presence of labels |
| `republishing replaces the schedule instead of stacking a second one` | keep | (a) publish and replace |
| `a started season locks the builder` | keep | (e) stale publish: a started season cannot be regenerated |
| `removing a published schedule leaves the season with no games` | keep | (a) |

From 23, keeping `Path 24 — schedule constraints` with its `beforeEach` and `afterEach`:

| Test | Action | Why |
|---|---|---|
| `the constraints card sits inside the generate form` | delete | presence |
| `the request picker offers all six kinds` | delete | presence |
| `adding a request lists it, and removing it takes it away` | delete | the kept test adds one, and `afterEach`'s `clearRequests` removes it through its ✕ |
| `adding a request clears its own fields and leaves the generate form alone` | delete | form state; no letter |
| `a request with nothing filled in is refused, not silently dropped` | delete | input validation; no letter |
| `two requests that contradict each other are refused by name` | delete | a message; no letter |
| `a honoured request shows as met on the preview` | move | (a) manager requests |
| `the requests card is absent when nothing has been asked for` | delete | design |

From 28, keeping `Path 26 — the generate form's state`:

| Test | Action | Why |
|---|---|---|
| `a generate leaves every field holding what was submitted` | delete | design |
| `adding a manager request keeps the fields already filled in` | delete | design |
| `a publish returns the form to defaults and clears the stored requests` | move | (a) (design) |

From 31, keeping the `.serial` describe `Path 29 — a draft that aged before it was published` with its hooks:

| Test | Action | Why |
|---|---|---|
| `warns that the draft's first night has passed, and confirms before publishing it` | delete | design: a UI prompt |
| `the server refuses a stale publish that arrives without the acknowledgement` | move | (e) stale publish |
| `moving the draft forward restores every game the generator placed` | move | (e) + (d) dates move and nothing else does |
| `a draft whose dates are ahead still publishes in one click` | delete | design: a UI prompt |
| `publishing a stale draft anyway is still possible, and locks the season` | move | (e) |

With `a draft whose dates are ahead still publishes in one click` gone, the last test's `update({ is_draft: true })…eq("is_draft", false)` finds nothing to flip. The draft is still where the Move test restored it, and `ageDraftBy` makes it stale again, so every assertion in that test holds as written.

- [ ] **Step 2: Delete the sources**

```bash
git rm e2e/23-schedule-constraints.spec.ts e2e/28-schedule-form-state.spec.ts e2e/31-stale-draft.spec.ts
```

- [ ] **Step 3: Run with the spec that seeds after it**

Run: `PORT=3101 scripts/e2e-locked.sh e2e/11-schedule-build.spec.ts e2e/14-one-off-game.spec.ts`
Expected: 13 passed (11-schedule-build 11; 14 has 2).

- [ ] **Step 4: Verify nothing references the removed tests**

Run: `grep -rn "the old builder URL lands on its season's setup page\|generate form has the length toggle\|length toggle swaps\|weekday checkboxes are all present\|one-off scheduling has moved off the builder\|empty draft state shows\|Try a different schedule returns\|a generate reports its result\|a generate with no game nights\|bounded below by today\|spacing checks report every goal\|the constraints card sits inside\|the request picker offers all six\|adding a request lists it\|adding a request clears its own fields\|a request with nothing filled in\|two requests that contradict\|the requests card is absent\|a generate leaves every field\|adding a manager request keeps the fields\|warns that the draft's first night has passed\|a draft whose dates are ahead\|11-schedule-builder\|23-schedule-constraints\|28-schedule-form-state\|31-stale-draft" e2e src`
Expected: no output after the pointer rewrites. `spacing.test.ts` names no e2e title.

- [ ] **Step 5: Commit (only if approved)**

```bash
git add -A e2e src
git commit -m "test(e2e): one schedule-build spec"
```

---

### Task 5k: `14-schedule-changes`

**Files:**
- Rename: `e2e/14-one-off-game.spec.ts` → `e2e/14-schedule-changes.spec.ts`
- Delete: `e2e/29-schedule-repair.spec.ts`, `e2e/30-schedule-edits.spec.ts`
- Temporary, never committed: one edit to `src/lib/actions/schedule-edits.ts` (`retimeGame`)

**Interfaces:**
- Produces: `e2e/14-schedule-changes.spec.ts` with `admin()`, `signInAs()`, 30's `signedInClient()`, one copy each of `YEAR`, `FIRST_NIGHT`, `SEASON_END`, `AFTER_GENERATE` and `expectGenerateFormUsable()` (14's copy), and new `seasonIdOf(name)` and `easternTime(iso)`.
- Consumes: `retimeGame`'s success copy `"Time changed."` (`schedule-edit-panel.tsx`, `Retime`), whose `#rg-game` option values are game ids, and `apply_game_writes(p_season, p_writes, p_statuses, p_is_draft)` returning `[{ applied, refused, reason }]` (0045).

The file opens with: `/** Changing a live schedule: one-off games, moving a night, repair, manual trades, and what a scorekeeper cannot do. */`

Order inside the file: 14, 29, 30.

**Background (read 2026-09-13; this refines the design):** `apply_game_writes`' stale-edit refusal cannot be reached through a page without a race. Every app caller reads a row and writes it in the same request (`retimeGame`, `exchangeSlots`, `applyScheduleRepair`), and what a preview→apply gap changes is refused earlier, in TypeScript, by `checkOneOffWrite`. So the refusal is asserted at the function, called the way the app calls it (service role). The manager's words for it, "preview it again. Nothing was written.", are already pinned in `gameWrites.test.ts` (`turns a conflict into words a manager can act on`).

- [ ] **Step 1: Rename and apply the renames**

```bash
git mv e2e/14-one-off-game.spec.ts e2e/14-schedule-changes.spec.ts
```

| Source | Name | Becomes |
|---|---|---|
| 14 | `SEASON` (including Task 4's assertion) | `ONE_OFF_SEASON` |
| 14 | `seedFutureSeason` | `seedOneOffSeason` |
| 29 | `SEASON` | `REPAIR_SEASON` |
| 29 | `seedFutureSeason` | `seedRepairSeason` |
| 29 | `seasonId()`, also inside `publishedGameIds` and `teamsOn` | `seasonIdOf(REPAIR_SEASON)` |
| 29 | `LEAGUE_TZ`, `leagueDateKey` | 30's `nightKey` |
| 30 | `SEASON`, including inside `publishedCount` | `EDIT_SEASON` |
| 30 | `seedSeason` | `seedEditSeason` |
| 30 | `seasonId()` | `seasonIdOf(EDIT_SEASON)` |
| 29, 30 | their `YEAR`, `FIRST_NIGHT`, `SEASON_END`, `AFTER_GENERATE`, `expectGenerateFormUsable` | deleted; 14's copies serve (identical values) |

Add at module level:

```ts
async function seasonIdOf(name: string): Promise<string> {
  const db = admin();
  const { data: league } = await db
    .from("leagues")
    .select("id")
    .eq("slug", "obhl")
    .single();
  const { data: season } = await db
    .from("seasons")
    .select("id")
    .eq("league_id", league!.id)
    .eq("name", name)
    .single();
  return season!.id as string;
}

/** The league-local wall-clock time of an instant, as "HH:MM". */
const easternTime = (iso: string) =>
  new Intl.DateTimeFormat("en-GB", {
    timeZone: "America/New_York",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(new Date(iso));
```

- [ ] **Step 2: Apply the tables**

From 14:

| Test | Action | Why |
|---|---|---|
| `manager can schedule a one-off and pick how the season absorbs it` | keep | (a) + (e) `checkOneOffWrite` on the apply path, with Task 4's audit read-back |
| `scorekeeper cannot reach the one-off page` | keep | (b) |

From 29, keeping `Path 27 — changing a live schedule` and its `afterAll`:

| Test | Action | Why |
|---|---|---|
| `a whole night moves in one action, and refuses a date that is taken` | move | (a) + (d) no new ids, dates move with the night |
| `a pin against a live season gives ranked plans, a diff, and no new ids` | move | (a) + (e) `planRepair` |
| `an unsatisfiable pin says why, in terms a manager can act on` | delete | a message; `planRepair`'s unit tests pin the unmet verdict |
| `repair with no pin either improves the schedule or says there is nothing to do` | delete | a second smoke of repair |
| `the locked builder offers repair alongside the one-off planner` | delete | presence |

From 30:

| Test | Action | Why |
|---|---|---|
| `a played game with no score leaves Upcoming for its own section` | move | (a) the Pending view |
| `a cancelled game keeps its Manage button even though it is future-dated` | move | (a) the only route to Restore for a game called off in advance; 05's cancel test uses tonight's game, which a future-date gate never reaches |
| `nobody is offered a Score button on a game not yet played` | delete | an offer, not a refusal; the scorekeeper's day rule is 05-scoring-night's `a game that is not today is refused, and says where to go` |
| `a manager gets the control on /schedule; a scorekeeper does not` | delete | presence; the three RLS tests below drive the refusal. Delete its now-empty describe `Path 28 — moving a night from the Schedule tab` |
| `a manager can trade two games' nights, and both counts survive` | move | (d) |
| `a manager can trade teams between two games, and totals survive` | move | (d) |
| `moving a game to another night is refused, and says why` | move | (d) |
| `the replace wizard refuses a swap with no compensating game` | delete | it accepts either outcome and reads no counts |
| `edits still work with a draft staged over the published schedule` | move | (d) |
| `a manager can trade two draft games' nights, and the published schedule is untouched` | move | (d) |
| `a scorekeeper gets no edit panel on the schedule` | delete | design: the "control absent" test that proves nothing |
| `a scorekeeper cannot cancel, postpone or reschedule a game` | delete | hidden buttons; the three RLS tests below drive the refusal |
| `a scorekeeper's own session cannot change a game's schedule state` | move | (b) |
| `a scorekeeper cannot move a game, re-team it, or hide it in a draft` | move | (b) |
| `a scorekeeper cannot postpone a game through the RPC either` | move | (b) |

- [ ] **Step 3: Add the two ported tests**

Inside `Path 28 — manual schedule edits`, directly after `moving a game to another night is refused, and says why`:

```ts
  test("a manager can move a game's time within its night, and the new time is stored", async ({
    page,
  }) => {
    const season = await seasonIdOf(EDIT_SEASON);
    const before = await counts(season);

    await signInAs(page, "Manager", "/obhl/dashboard");
    await page.goto("/obhl/schedule");
    await page.locator("#rg-game").selectOption({ index: 1 });
    const gameId = await page.locator("#rg-game").inputValue();
    const { data: original } = await admin()
      .from("games")
      .select("scheduled_at")
      .eq("id", gameId)
      .single();

    // Five minutes later on the same night: no other game holds that time.
    const at = await page.locator("#rg-at").inputValue(); // "YYYY-MM-DDTHH:MM", league-local
    const [date, time] = at.split("T");
    const [h, m] = time.split(":").map(Number);
    const minutes = h * 60 + m + 5;
    const moved = `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;

    try {
      await page.locator("#rg-at").fill(`${date}T${moved}`);
      await page.getByRole("button", { name: "Move the time" }).click();
      await expect(page.getByText("Time changed.")).toBeVisible();

      // ⛔ The STORED row, not the message: a write that did nothing reads
      // "Time changed." too if the action lies about it.
      const { data: after } = await admin()
        .from("games")
        .select("scheduled_at")
        .eq("id", gameId)
        .single();
      expect(nightKey(after!.scheduled_at!)).toBe(date);
      expect(easternTime(after!.scheduled_at!)).toBe(moved);

      const now = await counts(season);
      expect(now.perTeam).toEqual(before.perTeam);
      expect(now.perNight).toEqual(before.perNight);
    } finally {
      await admin()
        .from("games")
        .update({ scheduled_at: original!.scheduled_at })
        .eq("id", gameId);
    }
  });

  test("apply_game_writes refuses a write whose expected state has moved, and writes nothing", async () => {
    // ⚠️ AT THE FUNCTION, NOT THROUGH A PAGE: every app caller reads and writes
    // in one request, so this branch of 0045 is reachable only by a race. The
    // manager's words for it are pinned in gameWrites.test.ts.
    const db = admin();
    const season = await seasonIdOf(EDIT_SEASON);
    const { data: game } = await db
      .from("games")
      .select("id, scheduled_at, label")
      .eq("season_id", season)
      .eq("is_draft", false)
      .eq("status", "scheduled")
      .limit(1)
      .single();
    const write = (expectedAt: string) => ({
      id: game!.id,
      expect: { scheduled_at: expectedAt, label: game!.label },
      next: { label: "stale-edit-probe" },
    });
    const stale = new Date(
      new Date(game!.scheduled_at!).getTime() - 3_600_000,
    ).toISOString();

    try {
      const { data: refused, error } = await db.rpc("apply_game_writes", {
        p_season: season,
        p_writes: [write(stale)],
        p_statuses: ["scheduled"],
        p_is_draft: false,
      });
      expect(error).toBeNull();
      expect(refused).toEqual([
        { applied: 0, refused: game!.id, reason: "conflict" },
      ]);
      const { data: untouched } = await db
        .from("games")
        .select("label")
        .eq("id", game!.id)
        .single();
      expect(untouched!.label, "a refused batch wrote anyway").toBe(game!.label);

      // The control: the same write, against the time the row really holds.
      const { data: applied } = await db.rpc("apply_game_writes", {
        p_season: season,
        p_writes: [write(game!.scheduled_at!)],
        p_statuses: ["scheduled"],
        p_is_draft: false,
      });
      expect(applied).toEqual([{ applied: 1, refused: null, reason: null }]);
    } finally {
      await db.from("games").update({ label: game!.label }).eq("id", game!.id);
    }
  });
```

- [ ] **Step 4: Delete the sources and prove both new tests can fail**

```bash
git rm e2e/29-schedule-repair.spec.ts e2e/30-schedule-edits.spec.ts
```

1. In `src/lib/actions/schedule-edits.ts`, inside `retimeGame`'s `writeGames` call, change `next: { scheduled_at: next },` to `next: { scheduled_at: g0.scheduled_at },`.
   Run: `PORT=3101 scripts/e2e-locked.sh e2e/14-schedule-changes.spec.ts -g "move a game's time within its night"`
   Expected: FAIL at `expect(easternTime(after!.scheduled_at!)).toBe(moved)`. Restore; `git diff src/lib/actions/schedule-edits.ts` prints nothing.
2. In the RPC test, temporarily change `p_writes: [write(stale)]` to `p_writes: [write(game!.scheduled_at!)]`.
   Run: `PORT=3101 scripts/e2e-locked.sh e2e/14-schedule-changes.spec.ts -g "apply_game_writes refuses"`
   Expected: FAIL at the `reason: "conflict"` expectation. Restore.

- [ ] **Step 5: Run**

Run: `PORT=3101 scripts/e2e-locked.sh e2e/14-schedule-changes.spec.ts`
Expected: 16 passed (14's 2, 29's 2, 30's 10, and the 2 new tests).

- [ ] **Step 6: Verify nothing references the removed tests**

Run: `grep -rn "an unsatisfiable pin says why\|repair with no pin either improves\|the locked builder offers repair\|nobody is offered a Score button\|a manager gets the control on /schedule\|the replace wizard refuses a swap\|a scorekeeper gets no edit panel\|a scorekeeper cannot cancel, postpone or reschedule\|14-one-off-game\|29-schedule-repair\|30-schedule-edits" e2e src`
Expected: no output after the pointer rewrites.

- [ ] **Step 7: Commit (only if approved)**

```bash
git add -A e2e src
git status --short src/lib/actions/schedule-edits.ts
git commit -m "test(e2e): one schedule-changes spec; retime and stale-write checks"
```

---

### Task 6: Delete the verify scripts

**Files:**
- Delete: `scripts/verify-auth.mjs`, `scripts/verify-close-night.mjs`, `scripts/verify-office-password.mjs`, `scripts/verify-role-fallback.mjs`, `scripts/verify-roster-editing.mjs`, `scripts/verify-scoring.mjs`, `scripts/verify-transfers.mjs`
- Modify: `package.json`, `README.md`, `src/app/api/cron/close-night/route.ts` (one comment), `e2e/05-scoring-night.spec.ts` (one comment), `ACCESS_CONTROL_HANDOFF.md` (one command)

**Interfaces:** none.

**Where every check went.** Nothing here runs in CI (`.github/workflows/ci.yml` runs typecheck, lint, test and e2e only).

| Script | Check | Where it went |
|---|---|---|
| auth | the JWT `app_metadata.role` of manager, scorekeeper and captain | **dropped**: not load-bearing. `getSessionUser` falls back to `profiles.role` and RLS reads `profiles`; 02-auth's `an account with no role claim but a role in profiles reaches the manage tools` drives the claimless case |
| auth | a manager inserts a season | **dropped** as an insert; 09-access's `a session can still write its OWN league's rows through the API` proves a manager's session writes `seasons` |
| auth | a scorekeeper dresses a player in a non-final game | covered: 05-scoring-night `dress players, record a goal, finalize, verify on public schedule` (`setLineup` writes on the session client) |
| auth | a scorekeeper edits a completed game's roster and re-syncs its score | **dropped**: no kept test edits a final game as a scorekeeper |
| auth | a scorekeeper inserting a season is denied | **dropped** as an API check; the page half is 09-access `Scorekeeper is refused at /obhl/seasons` |
| auth | a captain sets their own team's roster | ported: 09-access `a captain can still dress a player on their own team through the API` |
| auth | a captain setting the other team's roster is denied | ported: 09-access `the API refuses dressing a player on the other team as a captain` |
| auth | a captain editing a completed game is denied | **dropped**: not ported |
| scoring | home and away GP +1 | ported: 05-scoring-night `dress players, record a goal, finalize, verify on public schedule` |
| scoring | the winner's PTS +2 | ported, same test, as `+ point_system.win` (and the loser's `+ point_system.loss`) |
| scoring | the scorer's G +1 | ported, same test |
| scoring | dressed but did not score: GP +1, G unchanged | ported, same test |
| transfers | #1 the goalie of record credited, the other dressed goalie not, empty-net goals out of GA, GAA from the adjusted GA | ported: 10-roster-changes `the goalie of record is credited, and empty-net goals are not charged to him` |
| transfers | #2 the fallback credits the only dressed goalie, and the old team's record survives a transfer | ported: 10-roster-changes `moving a goalie who has dressed leaves the old team's record intact` (not a duplicate of 22: see Task 5i). Its shutout check (`so` +1) is **dropped** |
| transfers | #3 anon reads a public league's totals, and nothing once it is private | ported: 09-access `the API refuses reading a staged league's season totals anonymously` (both halves) |
| transfers | #4 anon holds SELECT on both totals views | ported: 09-access `an anonymous visitor can read a public league's season totals` |
| transfers | #5 the totals roll up, name the current team, and recompute GAA | ported into 10-roster-changes `moving a goalie who has dressed leaves the old team's record intact` |
| close-night | an unauthenticated request is refused and changes nothing | covered: 05-scoring-night `refuses a request with no secret, and changes nothing` |
| close-night | a game left open last night goes final with the roster's sum | covered: 05-scoring-night `closes a game left open last night, with the roster's score and no actor` |
| close-night | its audit entry has a null actor | covered, same test |
| close-night | the fixture sits in the window the route reports | covered: both tests read it through `window()` |
| role-fallback | the minted token carries no role claim | covered: 02-auth `an account with no role claim but a role in profiles reaches the manage tools` |
| role-fallback | control: no claim and no role gets the role-less dashboard, and a role-guarded page refuses | covered, same test |
| role-fallback | once `profiles.role` is set, the same token reaches the manager dashboard and People & Roles | covered, same test |
| role-fallback | the office still refuses | covered, same test (`/manage/office` → `/`) |
| role-fallback | the token is nowhere near expiry; the claimless session reads its own profile under RLS | **dropped**: probe sanity checks; the test reaching the tools depends on both |
| office-password | the commissioner's new password opens the account, and the old one does not | covered: 07-staff `a commissioner sets a staff password and the account signs in with it` |
| office-password | a deputy's and a manager's hand-made POSTs are refused, and the commissioner's password survives | covered: 07-staff `setStaffPassword refuses a replayed POST from a deputy and from a manager` |
| office-password | **an anonymous POST is refused** | **dropped: no e2e replays the submit with no session** |
| office-password | a deputy is not offered the form | **dropped** with 20's `a deputy is offered no set-password control` (UI; the replay drives the refusal) |
| office-password | a peer commissioner cannot be taken over, and the page says why; a commissioner can set their own | covered: 07-staff `a commissioner cannot set another commissioner's password, but can set their own` |
| office-password | a too-short password and an unknown address each say so | **dropped**: messages about input |
| office-password | one `set_password` entry, under a null league, without the password | covered: 07-staff `a commissioner sets a staff password and the account signs in with it` |
| roster-editing | archiving is league-scoped | covered: 10-roster-changes `archiving in one league leaves the person in the other league's picker` |
| roster-editing | a move keeps the old team's goalie record through the fallback join | covered: 10-roster-changes `moving a goalie who has dressed leaves the old team's record intact`, rebuilt on that join in 5i |
| roster-editing | the `KNOCKOUT=archive` / `KNOCKOUT=move` modes | **dropped** as a harness; 5i's red proof runs the `move` knockout once, against the app |

- [ ] **Step 1: Delete the scripts**

```bash
git rm scripts/verify-auth.mjs scripts/verify-close-night.mjs scripts/verify-office-password.mjs scripts/verify-role-fallback.mjs scripts/verify-roster-editing.mjs scripts/verify-scoring.mjs scripts/verify-transfers.mjs
```

- [ ] **Step 2: Remove their entries and pointers**

1. `package.json`: delete the seven `"verify:…"` script lines. One, `"verify:transfers"`, is indented two spaces short; delete it all the same.
2. `README.md`: in the Scripts table, delete the `` `npm run verify:auth` `` row and the `` `npm run verify:scoring` `` row.
3. `src/app/api/cron/close-night/route.ts`: replace the comment block that begins `// ⚠️ THE WINDOW IS IN THE RESPONSE ON PURPOSE.` with:

```ts
  // ⚠️ THE WINDOW IS IN THE RESPONSE ON PURPOSE. Vercel's cron log shows the body,
  // so a run that closed nothing says WHICH night it looked at rather than leaving
  // you to guess between "no stale games" and "the window is wrong". It is also
  // what lets `05-scoring-night`'s *Closing the night* tests place their fixture
  // inside the real window instead of keeping a second copy of this date
  // arithmetic — the copy would be free to drift from the code it is meant to be
  // checking.
```

4. `e2e/05-scoring-night.spec.ts`, in the header that came from 34: replace `` `scripts/verify-close-night.mjs` covers exactly this, but nothing ran it`` with `A script, since deleted, covered exactly this, but nothing ran it`.
5. `ACCESS_CONTROL_HANDOFF.md`: in the one paragraph containing `npm run verify:close-night`, replace that command with `PORT=3101 scripts/e2e-locked.sh e2e/05-scoring-night.spec.ts -g "Closing the night"`. Read only that paragraph. Part 3 replaces the file.

- [ ] **Step 3: Verify nothing still points at them**

Run: `grep -rn "verify-auth\|verify-scoring\|verify-transfers\|verify-close-night\|verify-role-fallback\|verify-office-password\|verify-roster-editing\|verify:" --exclude-dir=node_modules --exclude-dir=.next --exclude-dir=.git --exclude-dir=docs . | grep -v "^./supabase/migrations/0040_player_league_archive.sql"`
Expected: no output. `0040`'s comment stays, because an existing migration is never edited. `docs/` is history, and part 3 deletes it.

Run: `node -e "JSON.parse(require('fs').readFileSync('package.json','utf8'))" && npm run typecheck && npm run lint`
Expected: no errors.

- [ ] **Step 4: Commit (only if approved)**

```bash
git add -A scripts package.json README.md src/app/api/cron/close-night/route.ts e2e/05-scoring-night.spec.ts ACCESS_CONTROL_HANDOFF.md
git commit -m "chore: delete the verify scripts, now ported or covered by e2e"
```

---

### Task 7: Whole-branch verification

**Files:** none changed.

- [ ] **Step 1: No old spec name survives**

Run: `grep -rnE "(03-seasons|05-scoring|06-audit|07-announcements|08-people|10-rules|11-schedule-builder|12-captain-lineup|13-goalie|14-one-off-game|15-league-routing|16-league-membership|17-roster-import|18-merge-duplicates|19-transfer|20-league-office|21-season-gating|22-roster-editing|23-schedule-constraints|24-password-auth|25-team-logo-ink|26-sign-out-destination|27-one-chrome|28-schedule-form-state|29-schedule-repair|30-schedule-edits|31-stale-draft|32-create-league|33-scorekeeper-day|34-close-night)([^a-z-]|$)" e2e src AGENTS.md README.md`
Expected: no output. The `([^a-z-]|$)` tail keeps `05-scoring-night` from matching `05-scoring`.

Run: `ls e2e/*.spec.ts`
Expected: exactly `01-public`, `02-auth`, `03-season-setup`, `04-rosters`, `05-scoring-night`, `07-staff`, `09-access`, `10-roster-changes`, `11-schedule-build`, `14-schedule-changes`.

- [ ] **Step 2: Static checks and the unit suite**

Run: `npm run typecheck && npm run lint && npm test 2>&1 | tail -8`
Expected:
- no errors;
- the test count is part 1's final count minus 17: Task 1 −35; Task 3 −1, +3, +1, +6, +9.
- If part 1 landed as planned (644 − 18 − 5 + 2 + 2 + 2 = 627, counting the todo), that is 610: 609 passed + 1 todo.
- Record the Duration line.

- [ ] **Step 3: Production build**

Run: `npm run build`
Expected: success.

- [ ] **Step 4: Full e2e, checkpoint 2**

Run: `PORT=3101 scripts/e2e-locked.sh e2e/01-public.spec.ts e2e/02-auth.spec.ts e2e/03-season-setup.spec.ts e2e/04-rosters.spec.ts e2e/05-scoring-night.spec.ts e2e/07-staff.spec.ts e2e/09-access.spec.ts e2e/10-roster-changes.spec.ts e2e/11-schedule-build.spec.ts e2e/14-schedule-changes.spec.ts`
Expected: 159 passed (158 passed and 1 skipped if the local mail API is down):

| File | Tests |
|---|---|
| `01-public` | 16 |
| `02-auth` | 8 |
| `03-season-setup` | 12 |
| `04-rosters` | 6 |
| `05-scoring-night` | 18 |
| `07-staff` | 20 |
| `09-access` | 45 |
| `10-roster-changes` | 7 |
| `11-schedule-build` | 11 |
| `14-schedule-changes` | 16 |

Record the run time. An order-dependent-looking failure is re-run alone before it is called a regression; report both runs.

- [ ] **Step 5: Measure**

Run: `ls e2e/*.spec.ts | wc -l; wc -l e2e/*.spec.ts | tail -1; find src -name "*.test.ts" | xargs wc -l | tail -1; ls scripts/verify-*.mjs 2>&1 | tail -1; git status --short supabase/migrations`
Expected:
- `10` specs;
- the e2e and unit line totals, which are recorded;
- `No such file or directory` for the verify scripts;
- nothing under `supabase/migrations`.

- [ ] **Step 6: Report for the owner**

Report, against targets that are reported and not gated:

| Measure | Before (2026-09-13) | After | Target |
|---|---|---|---|
| e2e specs | 34 | Step 5 | ≈10–12 |
| e2e lines | 12,420 | Step 5 | 3–4k |
| e2e tests | 258 passed + 1 skipped (CI run 34655681359, `main`, before part 1) | Step 4 | — |
| e2e runtime | 15.5 min on CI | Step 4 (local) | ≈5 min |
| unit lines | 10,790 | Step 5 | ≈5k |
| unit tests / time | 643 + 1 todo / 250.7 s | Step 2 | under a minute |
| verify scripts | 7 | 0 | 0 |

Also list:
- the commits made, if approved;
- the dropped checks from Task 6: an anonymous `setStaffPassword` POST; a scorekeeper editing a final game; a captain editing a final game; the fallback game's shutout; the validation messages;
- the corrections this plan made to the design (the self-review's last list).

---

## Self-review

**1. Spec coverage** (the brief's _Part 2_ and the design's Part 2):

| Requirement | Where |
|---|---|
| Global constraints, survival rule verbatim, the e2e/red-proof/RLS/`OBHL_SLOT_RESTARTS`/workflows rules | Global Constraints |
| Task 1: the seven named deletions, the bounds strip, empty tests deleted | Task 1 Steps 2–4 |
| Task 2: `calendars.test-support.ts` with the three builders; suite time vs 250 s | Task 2 |
| Task 3: revalidate-paths delete; three stars; finalize totals; the guards (four cases, plus two controls); `safe-next-path` | Task 3 |
| Task 4: `logAudit` after `writeGames`, the `entryLabel` case, the duplicate `revalidatePath`, the e2e `league_id` read | Task 4 |
| Task 5 table, 5a–5k, split-source rule, per-task runs, full suite after 5i and in 7 | Task 5 conventions, 5a–5k |
| 5a team feed; 5e verify-scoring; 5h verify-auth and transfers #3/#4; 5i transfers #1/#5; 5k `retimeGame` and 0045 | 5a Step 4, 5e Step 2, 5h Step 4, 5i Steps 3–4, 5k Step 3 |
| Task 6: the 7-script map and the `package.json` entries | Task 6 |
| Task 7: typecheck/lint/test, build, full e2e, the report against targets | Task 7 |
| Rulings: 06 revert survives; one legacy table; the spec 15 cuts; no shared-helper spike | 5d, 5g, 5a/5f/5g, Task 5 conventions |
| Corrections: e2e order (22 after 13; 21's teardown; 17) | Global Constraints, 5c Step 2, 5i Step 7 |
| Corrections: 15's export naming and its distinct "not scoreable" | 5a Step 2, 5g table |
| Corrections: `applyOneOffGame` logging; seed league shapes; `next` check shared | Task 4 background, Task 2 background, Task 3 |
| Corrections: calendar counts ×7 / ×3 | Task 2 counts them after Task 1's two deletions (6-team ×5, 8-team ×2) |

**2. Placeholder scan.** `grep -n "TBD\|TODO\|implement later\|fill in details\|similar to Task" docs/superpowers/plans/2026-09-13-part2-test-rebuild.md` → no plan step uses them.

**3. Names used across tasks:**
- `admin()`, `signInAs(page, role, then?)` and `type Role` (Task 5 conventions, every sub-task);
- `twoNightsPerWeek`, `sixTeamTuesdays`, `eightTeamMonThu` (Task 2);
- `safeNextPath(raw, fallback)` (Task 3);
- the `schedule_one_off` action and `ONE_OFF_SEASON` (Task 4, renamed in 5k);
- `Db`, `anonClient`, `captainFixture`, `TOTALS_VIEWS`, `PAGE_REFUSALS`, `API_REFUSALS` (5h);
- `emptyScoresheetGame`, `restoreGame`, and `scratchSkater({ …, position })` (5i);
- `seasonIdOf`, `easternTime`, `nightKey`, `REPAIR_SEASON`, `EDIT_SEASON` (5k);
- `STALE_SEASON` and `seedStaleSeason` (5j).

Each is defined in the task that first uses it, and later tasks use the same spelling.

**Where the code contradicted the design, and what this plan does instead:**
1. **The `next` fallbacks differ** (`/` vs `/<slug>/dashboard`). `safeNextPath` takes the fallback as a parameter (Task 3).
2. **`verify-transfers` #2 is not a duplicate of 22.** The seed picks a goalie of record on every final game, so 22's goalie test could not fail. 5i rebuilds it on the fallback branch, and ports #2 there.
3. **0045's stale-edit refusal is unreachable through the UI without a race.** 5k asserts it at the function; `gameWrites.test.ts` already pins the message.
4. **"~25 quality bounds" counts as about 70 `expect` lines** across the five files, because several tests hold three or four. Task 1 lists every one.
5. **A hidden control counts as (b) only while no kept test drives the refusal behind it.** This keeps 08's manager-row test, 13's empty-net test and 20's deputy-roster test, and drops the rest of the UI-absence tests.
