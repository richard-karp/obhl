# Stats Logos, Schedule Tabs, and the Goalie Box Score — Implementation Plan

> **For agentic workers:** steps use checkbox (`- [ ]`) syntax for tracking.
> There is no companion spec — the decisions this plan argues from were made in
> conversation on 2026-09-12 and are recorded under **Decisions already taken**
> rather than in `docs/superpowers/specs/`.

---

## ⚠️ This is the plan as WRITTEN, plus what execution changed

Kept as the record of intent. Everything below shipped, in eight commits on
`feat/stats-schedule-and-goalie-box`, but five things differ from what this
plan says. A reader taking it as a description of the code will be wrong about
each.

- **⛔ `game-row.tsx` DOES NOT wrap every row in a game link — only a FINAL
  one** (`:145`). The blast-radius table asserted the opposite and drew two
  conclusions from it, both since corrected in place: `05-scoring:74-75` was
  _weak_ rather than vacuous, and `15-league-routing:533` **broke** instead of
  being "likely fine", because Harbor's four finals are all in the past and its
  default view has nothing to click.
- **The finalize check lives in a new `src/lib/games/incomplete.ts`**, not in
  `shared.ts` as Task 7 Step 2 says. Same reason — `actions/games.ts` is
  `"use server"` — but a sibling module keeps the pure function out of a file
  that imports `next/cache`, so its test needs nothing from Next.
- **Task 3 extracted `src/components/shared/team-crest-link.tsx`** instead of
  inlining the JSX in both tables. Three things have to be right at once
  (`aria-label`, where `hover:underline` goes, the null slug) and two copies
  would drift.
- **One break the table did not predict at all:** `01-public`'s "clicking a
  skater from stats" took the first link in the row, which is the crest now, so
  it read the team's `aria-label` as the player's name and navigated to the
  team page. Task 3 had no e2e row in the table; it should have.
- **The e2e pass ran after Tasks 6 and 7, not between 5 and 6.** `01-public` and
  `05-scoring` are touched by both halves, and the ordering in this plan would
  have run each of them twice for no new information.

Two smaller ones: `05-scoring`'s new "still not final" assertion had to be the
ABSENCE of Final, because recording a goal bumps the game to `in_progress`; and
`npm run build` was added to the verification, because CI runs typecheck, lint,
test and e2e but **not** a production build — `ScheduleFilter`'s new
`useSearchParams` would have been the wrong place to find that out.

---

## Context

Six fixes the maintainer asked for on 2026-09-12, in one pass. Five are visual
edits to pages that already work. The sixth is a production report, and it is
the only one that needed diagnosing before it could be planned.

1. **Team logos beside players on the stats pages.**
2. **Remove the 3 Stars module** from the league home page.
3. **Remove the tiebreaker text** from the standings page.
4. **Remove "Built with Next.js & Supabase"** from the footer.
5. **Move results on the schedule page into a tab.**
6. **A completed production game shows no players or stats for one team, and no
   game page anywhere shows goalie stats.**

### What production actually showed (read 2026-09-12 via `supabase db query --linked`)

Three games were finalized inside 25 minutes on 2026-09-11 (02:16, 02:33 and
02:41 UTC on the 12th). **[measured]**

| Game       | Home     | Away    | Home lines | Away lines | `home_goalie_id` | `away_goalie_id` |
| ---------- | -------- | ------- | ---------- | ---------- | ---------------- | ---------------- |
| `b8cb6b8b` | White 4  | Grey 3  | 11         | 11         | null             | null             |
| `cd97f852` | Black 10 | Blue 3  | 11         | 10         | null             | set              |
| `f8679e6f` | Red 0    | Green 3 | **0**      | 12         | null             | set              |

Two distinct faults, and neither is a write that went wrong:

- **Red has zero `game_rosters` rows.** Nobody was ever dressed. `TeamLines` in
  `box-score.tsx` filters the lines by `team_id`, so it renders a header, no
  rows, and a 0-0-0 total. The 0 in the score is the same fact — the score is
  summed from the dressed lines. The only audit entry against that game is the
  `finalize_game` itself; `setLineup` writes no audit, so absence there is not
  evidence either way, but nothing in the app deletes a whole side.
- **Four of the six team-sides have no goalie of record.** `v_goalie_stats`
  (current definition in `0044_team_logo_in_stats_views.sql:101-185`) credits a
  goalie from an explicit pick, or — when the pick is null and the side is not
  flagged `sub` — from the dressed `position='G'` player. Goalies left the
  lineup checkboxes in `c9440e2`, so the fallback can only fire if `setGoalie`
  dressed them, and `setGoalie` runs only on an explicit tap. No tap, no row,
  no stats.

⛔ **The second fault was predicted in a code comment and shipped anyway.**
`score-board.tsx:200-210` says, in full: _"A scorekeeper who sees a filled
button and moves on leaves `home_goalie_id` null AND no dressed goalie, so both
branches of `v_goalie_stats` miss and the goalie gets no GP, no GAA, no W/L."_
The mitigation was cosmetic — draw the suggestion `secondary` rather than
`default` so it reads as unconfirmed. Production says the distinction did not
carry: six sides, four missed. **A muted button is not a gate.** That is the
argument for Task 7, and the reason this plan puts the check in the server
action rather than in the button's styling.

⚠️ **The box score has no goalie section at all** — that half of the report is
a missing feature, not a regression. `getGameBoxScore` (`queries/games.ts:18-75`)
selects neither the goalie columns nor the empty-net counts.

---

## Decisions already taken

Answered by the maintainer before this plan was written. They are settled; do
not re-litigate them during execution.

| Question                                  | Answer                                                                      |
| ----------------------------------------- | --------------------------------------------------------------------------- |
| Where do the stats-page logos go?         | **Inline before the player name, and the separate Team column is deleted.** |
| How do the schedule tabs split?           | **Three: To score / Upcoming / Results**, in that order.                    |
| What does the box score show for goalies? | **A goaltending line per team** — number, name, GA, decision.               |
| How far does the capture fix go?          | **Warn at finalize only.** No production data is touched.                   |

⛔ **NO PRODUCTION WRITES IN THIS WORK.** The three games above keep their
missing goalies and Red keeps its empty lineup until the maintainer re-enters
them through the scoresheet. Do not "helpfully" backfill `home_goalie_id`, and
do not write a repair script. It was asked and answered.

---

## Global Constraints

- **No migration.** Nothing here needs a schema change, so `src/lib/db/types.ts`
  is not regenerated and `supabase/seed.sql` is not touched. If a task seems to
  need one, stop and re-plan rather than adding `0050`.
- **The goalie-of-record rule will exist twice** after Task 6 — once in SQL
  (`0044`'s `v_goalie_stats`) and once in TypeScript. That is a deliberate,
  named duplication, not an oversight. Both copies get a comment pointing at the
  other. See Task 6 for why a view was rejected.
- **⛔ The GA arithmetic must match the view exactly:**
  `greatest(0, team_goals_against − that_team's_empty_net_against)`, and a
  shutout is that value being 0 — not the raw score being 0.
- **⛔ The nightly sweep must keep closing games.** `/api/cron/close-night`
  calls `finalizeGameById` directly, not the `finalizeGame` action. Task 7's
  gate goes in the **action**; putting it in `finalizeGameById` would make the
  sweep refuse every game it exists to close, silently.
- **e2e runs only via `scripts/e2e-locked.sh <one spec>`** — worktrees share one
  Supabase. **⛔ One spec file per invocation.** Four or more in a call is a full
  local run wearing a hat, and this plan's tab change touches enough specs to
  make that temptation real. CI runs the full suite on the PR.
- `npm run typecheck` runs **two** tsc passes (app + `e2e/tsconfig.json`).
- Read the relevant guide under `node_modules/next/dist/docs/` before writing
  code. The two that matter here are
  `01-getting-started/03-layouts-and-pages.md` (the `searchParams` prop is a
  Promise and opts the page into dynamic rendering) and
  `02-guides/redirecting.md` (`redirect()` is legal in a Server Function, throws,
  and must sit outside `try`).

---

## File Structure

**New files**

| Path                                       | Responsibility                                                                                                         |
| ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------- |
| `src/lib/goalie/of-record.ts` + `.test.ts` | Pure, two functions: `resolveGoalieOfRecord` (player / sub / none — identity only) and `goalieLine` (GA, SO, decision) |
| `src/components/public/schedule-views.tsx` | The three-view link row for the schedule page                                                                          |

**Modified**

`src/components/public/skater-stats-table.tsx` ·
`src/components/public/goalie-stats-table.tsx` ·
`src/app/[league]/(public)/page.tsx` ·
`src/app/[league]/(public)/standings/page.tsx` ·
`src/components/shared/site-footer.tsx` ·
`src/app/[league]/(public)/schedule/page.tsx` ·
`src/lib/queries/games.ts` ·
`src/components/public/box-score.tsx` ·
`src/lib/actions/games.ts` ·
`src/components/manage/score-board.tsx` ·
`src/app/[league]/(manage)/games/[gameId]/score/page.tsx`

**e2e touched:** `01-public` · `05-scoring` · `30-schedule-edits` ·
`33-scorekeeper-day`, and whichever of `09-access`, `13-goalie`,
`15-league-routing`, `21-season-gating`, `25-team-logo-ink`, `27-one-chrome`
Task 5's verification finds. See **The tab change's real blast radius**.

---

## Task 0 — Branch

The working tree is on `docs/launch-readiness-current` with an uncommitted edit
to `LAUNCH_READINESS_HANDOFF.md` that belongs to that branch, not to this work.
[[concurrent-branches-in-one-tree]] — the maintainer runs other sessions in this
same tree, so re-check the branch before every git write, not just this one.

- [ ] **Step 1** — `git status --short`. Expect exactly ` M LAUNCH_READINESS_HANDOFF.md`. Anything else is another session's work: stop and ask.
- [ ] **Step 2** — `git stash push -- LAUNCH_READINESS_HANDOFF.md` (targeted, not a bare `git stash`).
- [ ] **Step 3** — `git fetch origin main -q && git switch -c feat/stats-schedule-and-goalie-box origin/main`
- [ ] **Step 4** — ⚠️ **Do not pop the stash here.** It is a docs-branch edit against a different base; it goes back when the tree returns to `docs/launch-readiness-current` at the end.
- [ ] **Step 5** — ⚠️ `git switch -c … origin/main` sets this branch's upstream to **`origin/main`**, so a bare `git push` would target main. The eventual push must be `git push -u origin feat/stats-schedule-and-goalie-box`. This bit the previous branch (`feat/roster-night-pill`, 2026-09-12) and was caught only by reading the push command before running it.

---

## Task 1 — Footer and standings: delete two strings

Trivial, independent of everything else, and worth landing first so the risky
tasks do not carry them.

**Files:** `site-footer.tsx:15` · `(public)/standings/page.tsx:33-36`

- [ ] **Step 1** — `grep -rn "Built with\|Tiebreakers" src e2e --include="*.ts" --include="*.tsx"`. Expect exactly the two source hits and **no e2e hit** — confirmed 2026-09-12, and the confirmation is the point: if a spec asserts either string, this task grew a second half.
- [ ] **Step 2** — Delete the `<span>Built with Next.js &amp; Supabase</span>`. ⚠️ The `Staff sign in` link shares its flex row and must survive; the wrapping `<div className="flex items-center gap-4">` now holds one child, which is fine and should be left alone rather than "simplified" into the parent.
- [ ] **Step 3** — Delete the tiebreakers `<p>` and nothing else. The `<StandingsTable>` above it is untouched.
- [ ] **Step 4** — `npm run typecheck && npm run lint && npx prettier --check .`
- [ ] **Step 5** — Commit: `chore(chrome): drop the footer build credit and the standings tiebreaker note`

---

## Task 2 — Homepage: remove the 3 Stars module

**Files:** `(public)/page.tsx:172-214` · `src/lib/queries/games.ts:77-120`

- [ ] **Step 1** — Delete the whole `{latestGame && latestGame.three_stars && ...}` block. ⚠️ **The Game Recap card immediately below it reads the same `latestGame`** and stays; `getLatestGameWithRecapData` must keep being called.
- [ ] **Step 2** — Drop `three_stars` from `LatestRecapGame` and from the `.select(...)` string in `getLatestGameWithRecapData`, and drop the now-unused `ThreeStarEntry` import there if nothing else in the file uses it.
- [ ] **Step 3** — ⛔ **Do NOT touch `computeThreeStars` or `finalize.ts`.** The column keeps being written. The maintainer asked for the module off the homepage, not for the data to stop existing, and `games.three_stars` is populated for every finalized game already — deleting the writer would make those rows the only ones that ever had it.
- [ ] **Step 4** — `grep -rn "three_stars\|ThreeStar" src e2e --include="*.ts" --include="*.tsx"` and confirm the remaining hits are `finalize.ts`, `utils/three-stars.ts`, its test, and `db/types.ts`.
- [ ] **Step 5** — `npm run typecheck && npm test`
- [ ] **Step 6** — Commit: `feat(home): remove the 3 Stars module`

---

## Task 3 — Stats tables: logo inline, Team column gone

**Files:** `skater-stats-table.tsx` · `goalie-stats-table.tsx`

Both tables are rendered from **one** place, `(public)/stats/page.tsx:40,47`
**[measured]** — team pages use `TeamRosterSections`, and
`team-roster-sections.tsx:43-45` says so explicitly. So this changes `/stats`
and nothing else.

- [ ] **Step 1** — In each table, delete `<TableHead className="hidden sm:table-cell">Team</TableHead>` and the matching `<TableCell>` holding the `<Link>` + `<TeamLogo>` + team name.
- [ ] **Step 2** — In the Player/Goalie cell, put the chip before the name, inside its own link to the team so the two links do not nest:

```tsx
<TableCell className="font-medium">
  <span className="flex items-center gap-2">
    <Link
      href={`/${league}/teams/${r.team_slug}`}
      aria-label={r.team_name ?? "Team"}
    >
      <TeamLogo
        name={r.team_name ?? ""}
        color={r.team_color}
        logoPath={r.team_logo_path}
        textColor={r.team_logo_text_color}
      />
    </Link>
    <Link
      href={`/${league}/players/${r.player_id}`}
      className="hover:underline"
    >
      {r.first_name} {r.last_name}
    </Link>
    …jersey span, skater table only…
  </span>
</TableCell>
```

- [ ] **Step 3** — ⚠️ **The chip is `aria-hidden` and always has been** (`team-logo.tsx`, the monogram branch; the `<img>` branch carries `alt=""`). Wrapping it in a bare `<Link>` therefore makes a link with **no accessible name at all**, which is worse than the column it replaces. The `aria-label` on the anchor above is load-bearing — do not drop it as noise. ⛔ And do NOT "fix" it by giving `TeamLogo` an `aria-label`: `season-select.tsx:19` records an `sr-only` string colliding with `04-rosters`' selectors once already, and the chip is shared by a dozen call sites that do not want a name.
- [ ] **Step 4** — ⚠️ `team-logo.tsx`'s docblock explains at length that a propagated `text-decoration` cannot be switched off by a descendant, which is why the chip's letters are absolutely positioned. Keeping `hover:underline` on the **name** link and off the chip's link preserves that; putting one underline on a shared parent would reopen the bug the two-span structure exists to fix.
- [ ] **Step 5** — `npm run typecheck && npm run lint && npm test`
- [ ] **Step 6** — Screenshot `/obhl/stats` at 390px and at desktop, both tabs. ⚠️ `npx playwright screenshot` catches the streaming skeleton unless you pass `--wait-for-selector`; use the table.
- [ ] **Step 7** — Commit: `feat(stats): put the team crest beside the player and drop the Team column`

---

## Task 4 — `of-record.ts`: the goalie rule, in TypeScript, tested

Pure module, no rendering, no I/O. Written before Tasks 6 and 7 because both
consume it. Task 5 does not — it is independent and may be done in any order.

**New:** `src/lib/goalie/of-record.ts` + `src/lib/goalie/of-record.test.ts`

### ⛔ TWO functions, because two callers ask different questions

Task 6 wants a stat line and has a finished game. **Task 7 asks at a moment when
there is no outcome yet**, and only wants to know whether anybody was recorded.
A single `goalieOfRecord(side): line | null` forces Task 7 to invent an outcome
and discard most of the answer — and, worse, collapses _"a substitute was
recorded"_ into the same `null` as _"nothing was recorded"_. Those are different
facts and Task 7's warning turns on the difference. Keep them apart here so no
caller can conflate them.

```ts
export type SideInput = {
  goalieId: string | null;
  goalieIsSub: boolean;
  /** Dressed `game_rosters` player ids for this team whose roster row is position 'G'. */
  dressedGoalieIds: string[];
};

/**
 * WHO is credited — identity only, no game result needed.
 *   { kind: "player" } an individual carries the record
 *   { kind: "sub" }    a substitute played: recorded, but no individual credit
 *   { kind: "none" }   nothing was recorded at all
 */
export type GoalieRecord =
  { kind: "player"; playerId: string } | { kind: "sub" } | { kind: "none" };

export function resolveGoalieOfRecord(side: SideInput): GoalieRecord;

/** The box-score line, once the game has a result. Null unless kind === "player". */
export function goalieLine(
  side: SideInput & {
    /** Goals this team conceded — the OPPONENT's score. */
    goalsAgainst: number;
    /** `games.{home,away}_empty_net_against` for THIS team. */
    emptyNetAgainst: number;
    outcome: "W" | "L" | "T";
  },
): {
  playerId: string;
  ga: number;
  shutout: boolean;
  outcome: "W" | "L" | "T";
} | null;
```

- [ ] **Step 1** — `resolveGoalieOfRecord`: the three branches in the view's order. Explicit pick wins → `player`. `goalieIsSub` → `sub`, **and it suppresses the fallback** (`0015`'s whole point: a rostered goalie dressed as an unused backup must never be charged). Otherwise the lowest-sorting dressed goalie id → `player`, or `none` when there is none. ⚠️ The view's fallback is `distinct on (game_id, team_id) … order by gr.player_id`, so with two dressed goalies it takes the **lowest uuid**. Sort the ids as strings — canonical lowercase uuids sort identically to Postgres's byte order. Write that reasoning into the comment; it is the kind of thing a later reader will "simplify".
- [ ] **Step 2** — `goalieLine`: `null` unless `resolveGoalieOfRecord` says `player`; then `ga = Math.max(0, goalsAgainst - emptyNetAgainst)` and `shutout = ga === 0`.
- [ ] **Step 3** — Comment at the top of the file: this is the second copy of
      `v_goalie_stats`' rule (`supabase/migrations/0044_…:110-133`), they must
      agree, and a change to either is a change to both. Add the reciprocal
      pointer as a SQL comment is **not** possible without a migration — so
      instead put the pointer in `0044`'s successor only if one is ever written,
      and note here that the SQL side currently carries no back-reference. ⚠️ Say
      that honestly rather than claiming a symmetry that does not exist.
- [ ] **Step 4** — Tests, following `src/lib/goalie/suggest.test.ts`'s shape.
      For `resolveGoalieOfRecord`: explicit pick beats a dressed goalie;
      `goalieIsSub` returns **`sub`** even with a dressed goalie present;
      nothing set and nobody dressed returns **`none`**; no pick + one dressed G
      returns them; no pick + two dressed Gs returns the lower uuid.
      ⛔ **`sub` and `none` need a test each that would fail if they were the
      same value** — Task 7's warning is the only thing that distinguishes them,
      and a test that just asserts "not a player" would pass with them merged.
      For `goalieLine`: empty-net goals come off the GA; GA floors at 0 when
      empty-netters exceed the score; a shutout is GA 0, and **a 3-0 loss where
      all three were empty-netters is a shutout** — the case that separates
      "ga === 0" from "score === 0".
- [ ] **Step 5** — ⛔ **Prove each test can fail.** Mutate: return `none` from the sub branch, drop the `Math.max(0, …)`, sort descending, compare `goalsAgainst === 0` instead of `ga === 0`. Each mutation must turn at least one test red. A green mutant means the test describes an invariant every candidate shares — see [[prove-a-new-test-can-fail]].
- [ ] **Step 6** — `npm test`
- [ ] **Step 7** — Commit: `feat(goalie): extract the goalie-of-record rule as a tested module`

---

## Task 5 — Schedule page: three views

**Files:** `(public)/schedule/page.tsx` · new `schedule-views.tsx`

### ⛔ Build it as a link row on `?view=`, NOT on `components/ui/tabs.tsx`

`docs/superpowers/specs/2026-09-08-ia-approach-c-schedule-subnav.md:288-304`
records that this repo already tried Radix `<Tabs>` over URL-conditional server
content and reverted it (`team-tabs.tsx`, `3e692fa` → `9731234`), with three
measured blank-panel failures. Its verdict: _"real `<Link>`s … active state from
the URL, no client state at all."_

That spec's case is route tabs and mine are content tabs in one route, so the
precedent does not bind — but the URL form wins here on its own merits:

- the views are deep-linkable, so "here are the results" is a shareable link;
- the page stays a pure Server Component, with no client bundle added;
- **every e2e fix becomes `page.goto("/obhl/schedule?view=results")`** instead of
  a click that has to happen after the right load state.

The visible control is a three-item segmented row of `<Link>`s. Active state
comes from the resolved view, server-side.

### Structure

- Views: `to-score`, `upcoming` (default), `results`. Rendered in that order.
- The `to-score` link renders **only when that list is non-empty**, carrying its
  count: `To score (3)`. Same condition as today's section.
- ⚠️ **Every view link must preserve `?team=` and `?season=`.** The page already
  reads both; dropping them on a view switch would silently widen a filtered
  list, which is the exact bug `01-public.spec.ts:229-240` documents for the
  export buttons.
- ⛔ **AND THE TEAM FILTER MUST CARRY `?view=`, WHICH IT CANNOT DO TODAY.**
  `schedule-filter.tsx:22-24` pushes `pathname` or `${pathname}?team=${v}` and
  nothing else, so every other parameter is dropped on a filter change. That is
  invisible today because the only other parameter is `?season=`, and the season
  choice is **cookie-backed** — `21-season-gating.spec.ts:246-248` asserts it
  "follows you to the next staff surface" for exactly that reason. `view` has no
  cookie behind it, so without this the sequence "open Results, filter to one
  team" silently lands back on Upcoming. See Step 3b.
- An unknown `?view=` value falls back to `upcoming` rather than 404ing.
- **Cancelled stays at the foot of the `upcoming` view**, still gated on
  `canScore`. A cancelled game is a fixture that is not happening — not a
  result. ⛔ Do not move it to `results`: `05-scoring.spec.ts:84-125` reaches
  `restoreGame` through that section and it is the only route to it
  (`7fda0e3`).
- The manager block — `ScheduleEditPanel`, _Move a game night_, the
  repair/one-off links — stays **above** the view row. It is page-level, not
  per-view.

### The default is `upcoming`, and that reverses what I first proposed

I initially argued for defaulting to `to-score` when non-empty, because
`30-schedule-edits.spec.ts:433-437` says _"THE POSITION IS THE POINT … a section
below the fold is how these games got forgotten in the first place"_, and a tab
is worse than below the fold.

It loses anyway, on a measurement: **a scorekeeper's games are tonight's**, and
tonight is not past, so they sit under `upcoming`. `isPast` compares league date
keys (`schedule/page.tsx`), so `to-score` holds only games from previous nights
— which a scorekeeper is refused by the day guard at
`score/page.tsx:88-93`. Defaulting to `to-score` would land the one role that
uses this page daily on a list where every row is a bounce to `/tonight`.
`13-goalie.spec.ts:88-94` is that flow, and it would go red for the right
reason.

So: default `upcoming`, and the count on the `To score` label is what carries
the urgency. The original intent survives as **order plus count**, not as
position on a scrolled page. ⚠️ This is a real loss against `7fda0e3`'s lesson
and should be said out loud in the commit message, not buried.

### Steps

- [ ] **Step 1** — Read `node_modules/next/dist/docs/01-app/01-getting-started/03-layouts-and-pages.md:254-280`. `searchParams` is already destructured on this page (`{ team, season }`); add `view`.
- [ ] **Step 2** — Write `schedule-views.tsx`: takes `{ league, current, awaitingCount, query }` and renders three `<Link>`s. No `"use client"`. Give the wrapper a `nav` role with an `aria-label` — ⚠️ `staff-links.tsx:109-111` records that an unnamed `navigation` landmark is indistinguishable from another to a screen reader, and this page will now have three. ✅ **No spec breaks on it**, and the earlier draft of this plan cited the wrong evidence for that: the two bare `getByRole("navigation").first()` calls are `15-league-routing.spec.ts:158`, which is on **`/obhl/standings`**, and `:643`, which is an **API 404 test with no navigation in it at all**. `27-one-chrome.spec.ts:21-23` addresses navs by name ("Staff tools", "League"). So the `aria-label` is for the screen-reader user, not for a locator — keep it anyway, and don't go hunting a collision that isn't there.
- [ ] **Step 3** — In `schedule/page.tsx`, resolve `view`, then render exactly one of the three groups. Keep `groupByDate`, `isPast`, `isUnplayedFutureFixture` and every comment on them — none of that logic changes.
- [ ] **Step 3b** — Teach `ScheduleFilter` to preserve the rest of the query. It is a client component, so use `useSearchParams()`, clone it, set-or-delete `team`, and push `${pathname}?${params}`. ⚠️ **Preserve, don't enumerate** — a filter that copies `view` by name will drop the next parameter somebody adds, which is how it came to drop this one.
- [ ] **Step 4** — Each view renders an `EmptyState` when its own list is empty (`upcoming` already does). The page-level "No games scheduled" empty state for `games.length === 0` stays above the view row and short-circuits it.
- [ ] **Step 5** — `npm run typecheck && npm run lint`
- [ ] **Step 6** — Manual pass at 390px: all three views, as anonymous, as Scorekeeper, as Manager. The manager block must not move between views.
- [ ] **Step 7** — Commit: `feat(schedule): split the page into To score, Upcoming and Results views`

### The tab change's real blast radius

Eleven specs visit `/obhl/schedule` or `/harbor/schedule` **[measured]**, ~35
visits in total. Most will be unaffected, and guessing which is how a plan
misleads its executor — so the rule for Step 8 is: **work the list, one spec per
`e2e-locked.sh` invocation, and record the outcome.**

Predicted, with the reason:

| Spec                                                                                    | Predicted        | Why                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| --------------------------------------------------------------------------------------- | ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `01-public:198-212`                                                                     | **breaks**       | asserts the `Recent Results` heading on the bare URL                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `05-scoring:74-75`                                                                      | **weak, fix it** | `a[href^="/obhl/games/"]` is satisfied by any of the seed's three finalized rounds, so it would pass with this test's own game still unscored. Capture the finalized id and assert it under `?view=results`. ⛔ An earlier draft of this row said `game-row.tsx` wraps EVERY row in that link. It does not — only a FINAL game is wrapped (`game-row.tsx:145`), which is why the assertion was weak rather than vacuous, and which moves the Harbor row below out of "likely fine". |
| `05-scoring:199-206`                                                                    | **breaks**       | `Edit` links are final games → `results`                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `30-schedule-edits:428-440`                                                             | **breaks**       | asserts `h2` order; only one view is rendered now. Re-express as view-link order + the count.                                                                                                                                                                                                                                                                                                                                                                                       |
| `05-scoring:84-165`, `30-schedule-edits:458`                                            | likely fine      | Cancelled stays in `upcoming`                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `13-goalie:88`, `33-scorekeeper-day:200`                                                | likely fine      | scorekeeper games are tonight's → `upcoming`                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `15-league-routing:533`                                                                 | **breaks**       | only a final row carries a game link, and Harbor's four finals are all in the past — its default view has nothing to click                                                                                                                                                                                                                                                                                                                                                          |
| `09-access:45`, `21-season-gating:248,283`, `25-team-logo-ink:114`, `27-one-chrome:104` | likely fine      | assert chrome, switchers and logos, not sections                                                                                                                                                                                                                                                                                                                                                                                                                                    |

- [ ] **Step 8** — Run each spec in the _breaks_ and _weak_ rows individually, fix, and re-run only the failing test by name (`-g`). Then run the _likely fine_ rows once each to convert the prediction into a measurement. ⛔ Do not re-run a spec that already passed because a later unrelated fix landed.
- [ ] **Step 9** — Commit the spec changes separately: `test(schedule): follow the results list into its own view`

---

## Task 6 — Box score: a goaltending line per team

**Files:** `queries/games.ts` (`getGameBoxScore`) · `box-score.tsx`

### Why not a view

A per-game `v_game_goalies` would keep one definition of the rule and is the
shape this codebase reaches for. It is rejected here for one reason: it is a
migration, and a migration on this project has to reach production **before**
the code that reads it — `LAUNCH_READINESS_HANDOFF.md`, _The rule item 6 leaves
behind_, records a real outage window from getting that order wrong on `0049`.
Task 4's tested module buys the same correctness for a review round instead of a
deploy window. ⚠️ If this rule needs a third consumer, revisit the view.

- [ ] **Step 1** — Extend the `games` select in `getGameBoxScore` with `home_goalie_id, away_goalie_id, home_goalie_is_sub, away_goalie_is_sub, home_empty_net_against, away_empty_net_against`, **and embed both goalies' names**:

```
home_goalie:players!games_home_goalie_id_fkey(first_name, last_name),
away_goalie:players!games_away_goalie_id_fkey(first_name, last_name)
```

⛔ **Do not name the goalie from the roster lines instead.** `v_goalie_stats`
credits `home_goalie_id` whether or not that player has a `game_rosters` row —
branch 1 of `goalie_appearances` joins nothing — so a goalie of record who is
not dressed is representable, and the box score would render their GA beside an
empty name. It does not bite on today's data: both production goalies of record
do have roster rows, because `setGoalie` inserts one (`games.ts:290-296`,
measured 2026-09-12). It bites the first time that stops being true, and an
embedded join costs no extra round trip.

- [ ] **Step 2** — Add `position` to the `team_players` select already in that function (it reads the whole season's rows for jersey numbers), and build a `position` map keyed `player_id|team_id` alongside the existing `jersey` map. ⚠️ That read is deliberately **not** filtered on `left_on` — the comment at `games.ts:42-48` explains why, and it applies to positions for the same reason.
- [ ] **Step 3** — Return a `goalies: { home: …, away: … }` shape built through `goalieLine()`, taking the name from the embedded join (falling back to the roster line for the dressed-G case, which has no embedded row) and the number from the jersey map. A side whose `resolveGoalieOfRecord` is not `player` returns `null`.
- [ ] **Step 3b** — ⚠️ **A playoff or draft game will render a goaltending line that contributes to no season total.** `v_goalie_stats` is restricted to `game_type = 'regular' and not is_draft` (`0044:108`); the box score is not, and should not be — the line describes the game in front of you. Say so in a comment, because it reads as an inconsistency to anyone who diffs the two.
- [ ] **Step 4** — In `box-score.tsx`, render under each team's table:

```
GOALIE
#70  B. Dumas          GA 0   SO   W
```

⛔ **Three states, not two** — the same distinction Task 4 exists to preserve:

| `resolveGoalieOfRecord` | The line                                        |
| ----------------------- | ----------------------------------------------- |
| `player`                | the row above                                   |
| `sub`                   | muted `Substitute goalie — no individual stats` |
| `none`                  | muted `No goalie recorded`                      |

Neither of the last two is a blank, and neither is a `—` row that reads like a
zero. Four sides in production are about to render `No goalie recorded`; it has
to be legible as "nobody recorded this", because that is the truth and it is the
prompt to go fix it. Collapsing `sub` into it would report a correctly-entered
sheet as an omission.

- [ ] **Step 5** — ⚠️ **Red's side of `f8679e6f` is the fixture that matters** and it cannot be reached locally, because the seed dresses both teams. Check the empty case by hand: temporarily point a local box score at a game with one side undressed, confirm the skater table still renders its header and 0 total and the goalie line says `No goalie recorded`, then revert. Do **not** leave a seed change behind for it — [[ci-runs-the-full-e2e]] and the 2026-09-12 seed episode.
- [ ] **Step 6** — `npm run typecheck && npm run lint && npm test`
- [ ] **Step 7** — `scripts/e2e-locked.sh e2e/01-public.spec.ts` — `:214-226` opens a finalized game's box score and is the only spec on that page.
- [ ] **Step 8** — Commit: `feat(games): show the goalie of record and their line on the box score`

---

## Task 7 — Finalize warns before it completes a half-entered game

**Files:** `actions/games.ts` (`finalizeGame`) · `score/page.tsx` ·
`score-board.tsx`

### The shape

Two-step, enforced in the action:

1. `finalizeGame` reads the game's `game_rosters` and goalie columns. It builds
   a list of problems — per side, exactly two:
   - **no players dressed** — _zero_ `game_rosters` rows for that team;
   - **no goalie recorded** — `resolveGoalieOfRecord()` returns `none`.
2. If the list is non-empty **and** `formData.get("confirm") !== "1"`, it
   `redirect()`s back to the scoresheet with `?incomplete=1` instead of
   finalizing.
3. The score page reads `searchParams.incomplete`, recomputes the same problems
   from the data it already loads, and renders them by team name above a
   **Complete anyway** button whose form carries `confirm=1`.

### ⛔ Two definitions the first draft of this plan got wrong

**A substitute goalie is NOT a missing goalie.** `setGoalie` writes
`goalie_id = null, is_sub = true` for the Sub button (`games.ts:269-272`), and
that is a complete, deliberate answer: `0015` says a substitute goalie has no
individual record on purpose. Warning on it nags a scorekeeper who entered the
sheet correctly, and a warning that fires on correct data is how people learn to
click through warnings — which is the behaviour this whole task exists to stop.
This is why Task 4 returns `sub` and `none` as distinct values: **only `none`
warns.**

**"Dressed" means any roster row, including the aggregate Substitutes row.**
`setSubstitutes` writes a `player_id: null, is_substitute: true` row, and a team
that dressed only that is a state the scoresheet deliberately supports. The
production fault was Red with **zero** rows of any kind; a check written as "no
non-substitute rows" invents a second fault that is not one.

⛔ **The check is in the action, not the button.** A page-computed warning with
an ordinary button would be defeated by a stale tab, which is precisely the
situation a half-entered scoresheet is in.

⚠️ **`redirect()` throws** (`02-guides/redirecting.md:84`) — it must sit outside
any `try`, and after the guard, never inside a catch.

- [ ] **Step 1** — Read `node_modules/next/dist/docs/01-app/02-guides/redirecting.md:39-89`.
- [ ] **Step 2** — Write the problem-finder as a small exported helper so the action and the page cannot disagree about what "incomplete" means. ⛔ It must NOT live in `actions/games.ts`: that file is `"use server"`, where every export is a callable endpoint and a non-async export is a build error — `lib/games/shared.ts` exists for exactly this reason and says so in its docblock.
- [ ] **Step 3** — Action: guard, then `redirect(\`/${slug}/games/${game_id}/score?incomplete=1\`)`. ⚠️ **The action has the league ID but not the slug.** `requireGameRole`delegates to`requireLeagueRole(() => leagueOfGame(...))` (`games.ts:35-40`) and hands back a user, not a league — so this needs one `leagues.slug` read, on the refusal path only. ⛔ Resolve it from the game, never from a hidden input: a form field would let an edited submission steer where the redirect lands.
- [ ] **Step 4** — Page: add `searchParams`, pass `incomplete` and the problem list into `ScoreBoardData`, and render the warning + `Complete anyway`. When `incomplete` is absent the button keeps saying **Complete game** and carries no `confirm`.
- [ ] **Step 4b** — ⚠️ **`?incomplete=1` survives the successful submit.** The confirm path finalizes and re-renders the same URL, so without this the completed game keeps showing its warning until the user edits the address bar. Gate the warning on `status !== "final"`. ⛔ Not on `problems.length === 0` — completing anyway does not fix the problems, so that test would leave the banner up on exactly the games it fired for.
- [ ] **Step 5** — ⛔ Confirm `/api/cron/close-night` is untouched: `grep -n "finalizeGameById" src/app/api/cron/close-night/route.ts src/lib/actions/games.ts`. The cron must reach the plain function, and the sweep's whole purpose is closing games nobody finished — the gate would refuse every one of them.
- [ ] **Step 6** — e2e. Two specs click **Complete game** and neither sets a goalie, so both will now hit the gate — which is the gate working:
  - `05-scoring.spec.ts:69` — dresses both lineups, records a goal, completes.
  - `33-scorekeeper-day.spec.ts:217` — same shape as Scorekeeper.

  Update both to assert the refusal, then confirm through it. ✅ **This is free
  coverage of the new behaviour in a flow that already exists** — do not add a
  third spec for it.

- [ ] **Step 7** — ⛔ **Prove the gate can fail.** Two mutations, both must go red:
  1. delete the `confirm` check — `05-scoring`'s new refusal assertion must fail;
  2. make the warning treat `sub` as `none` — a game whose goalie is set to **Sub** must then be refused, and nothing currently covers that. ⚠️ If no spec catches mutation 2, the false-positive this task was corrected for is untested: add the Sub case to `13-goalie.spec.ts`, which already drives that button, rather than growing `05-scoring`.

  A gate whose test passes with the gate removed is the [[assert-on-what-ships]] failure this repo has shipped twice.

- [ ] **Step 8** — `scripts/e2e-locked.sh e2e/05-scoring.spec.ts`, then `scripts/e2e-locked.sh e2e/33-scorekeeper-day.spec.ts`, then `e2e/13-goalie.spec.ts` if Step 7 added the Sub case there. Separate invocations, one spec each.
- [ ] **Step 9** — Commit: `feat(scoring): refuse to complete a game with a side undressed or no goalie`

---

## Verification

Run at the end, over the whole branch:

- [ ] `npm run typecheck` (both passes)
- [ ] `npm run lint` — 3 pre-existing warnings in untouched files are expected
- [ ] `npx prettier --check .`
- [ ] `npm test`
- [ ] The specs named in Tasks 5, 6 and 7, each already run individually
- [ ] Screenshots: `/obhl/stats` (both tabs, 390px + desktop), `/obhl/schedule`
      (all three views), `/obhl` (no 3 Stars card), a finalized game page with
      its goalie lines

⛔ **No full local e2e run.** [[ci-runs-the-full-e2e]] — it is a rule with no
exceptions, and this plan's breadth is exactly the argument that got overridden
on 2026-09-12. CI runs the suite on the PR.

---

## What this plan does NOT do

- **No production data repair.** Asked and declined. Red's lineup and the four
  missing goalies stay as they are.
- **No change to `v_goalie_stats` or any other view**, and no migration.
- **Nothing from the IA sub-nav spec.**
  `2026-09-08-ia-approach-c-schedule-subnav.md` proposes a staff-side
  Games/Repair/One-off/Build strip over four routes. Task 5 is a public,
  single-route view switch and shares nothing with it but the word "tab". That
  spec remains unapproved and unbuilt.
- **No fix for the underlying capture problem**, only a warning. The reason four
  goalies went unrecorded is that the suggestion is a button nobody has to
  press; Task 7 makes skipping it deliberate rather than invisible, and stops
  there because auto-confirming a guess was considered and rejected.
- **No new seed fixture.** Task 6, Step 5 explicitly reverts its local one.
