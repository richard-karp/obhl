# Roster Import and Mid-Season Transfers — Implementation Plan

**Protocol — read this header and nothing else to start.**

1. **Read budget ~120 lines:** this header (~55) plus the single task you are executing (~40–80). **Do not read this file end to end** — it is 911 lines of 13 independent tasks. Do not read the spec (`docs/superpowers/specs/2026-09-03-roster-import-and-transfers-design.md`, 380 lines) unless a task's *rationale* is unclear; every decision it reaches is already restated in the task that needs it. Do not read `LAUNCH_READINESS_HANDOFF.md` (255) or `ACCESS_CONTROL_HANDOFF.md` (203) — the two rules they contribute are in *Global Constraints*.
2. ⛔ **Hazards, before any instruction:**
   - `supabase db reset --linked` **wipes production**. Use `db push`. `npm run db:reset` is the *local* one and is safe.
   - **`/Users/richardkarp/dev/obhl` is shared with another active session.** Watched: it committed `e268e98` (12:36) and `85ee425` (12:43) onto `docs/roster-import-and-transfers`, on either side of this plan's spec commit `284e25e` (12:41). **Work in a worktree** (step 4) — do not implement in the main checkout.
   - **Task 0 (the database wipe) is the operator's, not an agent's.** Never run it.
3. Claims are marked. "Watched" means the command was run and its output read. "A reading" means it follows from the code and has not been executed. Verified-by-measurement in this session: the `0024` goalie regression (§2 of the spec), `profiles` having no unique index on `player_id`, the public team route segment being `[slug]`, and every `file:line` cited below.
4. **Baseline was NOT measured this session.** Establish it before changing anything: `npm test && npm run typecheck`. `LAUNCH_READINESS_HANDOFF.md` records 250 unit / 127 e2e on a *different* branch on 2026-09-02 — ⚠️ regenerate, do not quote.

**Status: Task A1 is done.** Work happens on `feat/roster-import` in the worktree `/Users/richardkarp/dev/obhl-worktrees/roster-import`, branched off `main` with `284e25e` cherry-picked; the worktree needs its own `npm ci`. Task 0 remains the operator's; **Task A2 is the next agent task.**

**Baseline measured 2026-09-03 on this branch, before any code change: 21 test files / 250 unit tests passing, `npm run typecheck` clean.** After A1: 22 files / 253 tests — the three new `slug` tests and nothing else moved. Re-measure after each task; do not quote these once further tasks land.

One correction A1 turned up, for anyone writing tests against `slugify`: it collapses each run of non-alphanumerics to a *single hyphen*, so punctuation separates rather than disappears — `slugify("St. John's Ducks!")` is `st-john-s-ducks`. Step 1's example expectation below said `st-johns-ducks` and was wrong; the implementation is unchanged and remains the source of truth.

**Next action — create the worktree on a clean branch, then start Task A1:**

```bash
git worktree add -b feat/roster-import \
  /Users/richardkarp/dev/obhl-worktrees/roster-import main
cd /Users/richardkarp/dev/obhl-worktrees/roster-import
git cherry-pick 284e25e     # the spec; one file, 380 insertions, applies clean

# Bring this plan into the repo as the branch's worklist, and commit it FIRST —
# before any code — so the work is recorded even if this session is lost.
cp /Users/richardkarp/.claude/plans/wobbly-swimming-wreath.md \
   docs/worklists/2026-09-03-f7ff87d5-roster-import.md
git add docs/worklists/2026-09-03-f7ff87d5-roster-import.md
git commit -m "docs: worklist for the roster import and transfers branch"
```

**From that commit on, `docs/worklists/2026-09-03-f7ff87d5-roster-import.md` is the only copy that matters.** Tick its checkboxes as tasks land and commit it alongside the code. The file in `~/.claude/plans/` is a dead copy the moment the `cp` runs — do not edit it, and do not read it again.

**Off `main`, not off `docs/roster-import-and-transfers`, and the reason matters.** That branch carries a stray `85ee425` — a duplicate of `66f2886` on `feat/league-office` (same subject, different hash). Both add `supabase/migrations/0034_league_office.sql`, so if both branches merge, git hits a conflict on a migration file. Cherry-picking `284e25e` alone gives a branch holding this work and nothing else.

Consequence to expect, not to fix: `0034` is absent in this worktree, so `npm run db:reset` applies `0032`, `0033`, then `0035`+. Nothing here touches the `league_office` table, and `0035` remains the correct next number regardless of merge order.

⛔ **Do not rewrite `docs/roster-import-and-transfers` to remove the stray.** It is the other session's commit duplicated onto that branch, they may have it checked out, and rewriting history under a live session loses work. Leave it for a human to sort with them.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Import two leagues' teams and players from esportsdesk as a starting draft for the coming season, let a manager fix the rosters, and let a player move between teams mid-season without corrupting anyone's stats.

**Architecture:** Two independently shippable phases. **A** adds a roster-only import beside the existing full migration importer, plus a league-scoped duplicate-merge tool — because esportsdesk has only names and two real people genuinely share one. **B** adds a soft departure (`team_players.left_on`), so the old roster row survives a transfer; that one fact is what keeps `v_goalie_stats`' inner join and `v_skater_stats`' left join satisfied. Leaderboards move to new season-total views; team pages keep the existing per-team views.

**Tech Stack:** Next.js 16 (App Router, server actions), Supabase/Postgres, TypeScript, vitest (node env), Playwright.

**Spec:** `docs/superpowers/specs/2026-09-03-roster-import-and-transfers-design.md` — read it alongside this plan. Sections referenced below as §N.

## Context

Two leagues are being brought into OBHL for the coming season. The database is wiped first; nothing is preserved. Last year's esportsdesk rosters are wanted **only as a starting draft** — no stats, records, or schedule. The manager then edits rosters, and occasionally moves a player between teams once games are being played.

The requirement that drives the design: a transferred player's season totals follow them onto the leaderboard, while each team keeps exactly what was earned in its sweater. Jane plays 10 games for the Rangers (5G 3A), transfers, plays 8 for the Kings (4G 6A) → the leaderboard shows **one** row (Jane, Kings, 18 GP, 9G 9A); the Rangers page still shows 10 GP, 5G 3A; the Kings page 8 GP, 4G 6A.

Doing this the obvious way — delete the old roster row, insert a new one — is silently destructive, which is the whole reason this plan exists.

## Global Constraints

- **Migrations run `0035`–`0038`.** `0034` is taken and committed — see the header; do not re-verify it here.
- **`supabase db reset --linked` wipes production.** Use `db push`. `npm run db:reset` is local and safe.
- **After every migration:** run `npm run gen-types` (writes `src/lib/db/types.ts`). A stale types file makes correct queries fail typecheck.
- **Every new server action must reach a league guard** or be registered in `src/lib/actions/league-guards.test.ts`. Same for every new `manage` page. This is enforced by that test.
- **Audit entries resolve `league_id` *before* the write they describe.** Per `ACCESS_CONTROL_HANDOFF.md`: an entry that resolves its league after the row moved lands with a null `league_id` and is then hidden by RLS and by every league-scoped view.
- **Verification is `npm test && npm run test:e2e`.** Counts in `LAUNCH_READINESS_HANDOFF.md` move with every merge — re-measure, never quote.

## Decisions taken (push back if any is wrong)

1. **Phase A refuses to merge two records active on different teams.** `left_on` does not exist until Phase B, so a dual-roster cannot be expressed as a departure. The operator removes one roster row first.
2. **`slugify` is extracted to a shared module** rather than copied a third time. It is currently a private const in `src/lib/actions/import.ts:22` and `src/lib/actions/seasons.ts:34`.
3. **Dismissed duplicate pairs persist in a table** (`0035`), so a cluster the operator has judged "different people" stays dismissed — with a "Show dismissed" toggle to undo one.
4. **A merge is refused when two of the records have linked user accounts.** Merging would hand two accounts control of one player, and captain rights with it. The operator unlinks one first.
5. **Removing a player who has dressed marks them departed instead of deleting the row.** A player who never dressed is still hard-deleted — that is an add being undone, with no history to lose.

---

## File Structure

| File | Responsibility | Phase |
|---|---|---|
| `src/lib/utils/slug.ts` *(new)* | Shared `slugify`, replacing two private copies | A |
| `src/lib/actions/import-rosters.ts` *(new)* | `runRosterOnlyImport` — league + season + teams + players, nothing else | A |
| `src/lib/players/duplicates.ts` *(new)* | Pure: group same-name players into clusters | A |
| `src/lib/players/merge-plan.ts` *(new)* | Pure: resolve merge collisions, or refuse | A |
| `src/lib/actions/players.ts` *(new)* | `mergePlayers`, `dismissDuplicatePair` | A |
| `supabase/migrations/0035_player_distinct_pairs.sql` *(new)* | Remembers "these are different people" | A |
| `src/app/[league]/manage/people/duplicates/page.tsx` *(new)* | Merge review UI | A |
| `supabase/migrations/0036_roster_departures.sql` *(new)* | `left_on` + index changes | B |
| `supabase/migrations/0037_transfer_stats.sql` *(new)* | View rebuild + season-total views | B |
| `supabase/migrations/0038_captain_departures.sql` *(new)* | `is_captain_of` ignores departed rows | B |
| `src/lib/actions/rosters.ts` *(modify)* | Add `transferPlayer` | B |
| `src/lib/queries/stats.ts` *(modify)* | Leaderboards read the totals views | B |
| `scripts/verify-transfers.mjs` *(new)* | Real-DB proof of the goalie, RLS and grant claims | B |

Existing code to reuse, not reinvent — **paths verified**: `fetchEsportsdeskLeague` / `parseEsportsdeskUrl` (`src/lib/import/esportsdesk.ts`), `normName` (`src/lib/actions/import.ts:19`), `isReservedLeagueSlug` (`src/lib/league/reserved-slugs.ts:29`), `addLeagueMembership` (`src/lib/auth/membership.ts:94`), `requireManager` (`src/lib/auth/guards.ts:24`), `logAudit`, `requireLeagueManagerOf`, `leagueOfSeason`, `leagueOfTeam`.

---

## Task 0: The wipe (operator, not agent)

Not an agent task. Recorded here so the sequence is complete.

- [ ] Empty the database.
- [ ] While it is empty, close `LAUNCH_READINESS_HANDOFF.md` item 2 — the seeded accounts whose password is committed to this repo are a way in regardless of what is deployed.
- [ ] Items 1 (`ENABLE_DEV_LOGIN`) and 3 (`0033` not pushed) are unrelated to this work but block going live at all.

---

# Phase A — Import and de-duplication

## Task A1: Extract `slugify`

**Files:** Create `src/lib/utils/slug.ts`, `src/lib/utils/slug.test.ts`; modify `src/lib/actions/import.ts:22`, `src/lib/actions/seasons.ts:34`.

**Interfaces:** Produces `export function slugify(s: string): string`.

- [x] **Step 1: Write the failing test** — copy the behaviour of the existing const exactly; this is an extraction, not a redesign.

```ts
import { describe, it, expect } from "vitest";
import { slugify } from "./slug";

describe("slugify", () => {
  it("lowercases and hyphenates", () => {
    expect(slugify("Harbor Rec Hockey League")).toBe("harbor-rec-hockey-league");
  });
  it("drops punctuation", () => {
    expect(slugify("St. John's Ducks!")).toBe("st-johns-ducks");
  });
  it("returns empty string when nothing survives", () => {
    expect(slugify("!!!")).toBe("");
  });
});
```

- [x] **Step 2: Run it to verify it fails** — `npm test -- slug` → module not found.
- [x] **Step 3: Move the implementation.** Copy the body from `src/lib/actions/import.ts:22` verbatim into `src/lib/utils/slug.ts` and export it. **Adjust the test to the real behaviour if it differs** — the existing const is the source of truth, and both call sites already depend on exactly what it does.
- [x] **Step 4: Replace both call sites** with `import { slugify } from "@/lib/utils/slug";` and delete the two private consts.
- [x] **Step 5: Run the full suite** — `npm test && npm run typecheck`. Expect no behaviour change anywhere.
- [x] **Step 6: Commit** — `git commit -m "refactor: share slugify instead of two private copies"`

## Task A2: Roster-only import action

**Files:** Create `src/lib/actions/import-rosters.ts`; modify `src/lib/actions/league-guards.test.ts`.

**Interfaces:** Produces `runRosterOnlyImport(prev: ImportRunState, formData: FormData): Promise<ImportRunState>`, reusing `ImportRunState` from `src/lib/actions/import.ts`.

- [ ] **Step 1: Register the new action in the guard convention test**

```ts
const ROLE_ONLY_ALLOWED: Record<string, number> = {
  "import.ts": 2,
  // runRosterOnlyImport creates the league it would otherwise be guarded
  // against — the same exemption import.ts has, for the same reason.
  "import-rosters.ts": 1,
};
```

```ts
const NO_LEAGUE_ACTIONS: Record<string, string> = {
  // ... existing entries unchanged ...
  "import-rosters.ts:runRosterOnlyImport":
    "creates the league it would be guarded against",
};
```

- [ ] **Step 2: Run the suite** — `npm test -- league-guards`. Expected: PASS (registering a not-yet-existing file is inert; this confirms you start green).

- [ ] **Step 3: Write `runRosterOnlyImport`**

```ts
"use server";

import { revalidatePath } from "next/cache";
import { createAdminClient } from "@/utils/supabase/admin";
import { requireManager } from "@/lib/auth/guards";
import { addLeagueMembership } from "@/lib/auth/membership";
import { logAudit } from "@/lib/audit";
import { slugify } from "@/lib/utils/slug";
import { isReservedLeagueSlug } from "@/lib/league/reserved-slugs";
import { fetchEsportsdeskLeague, parseEsportsdeskUrl } from "@/lib/import/esportsdesk";
import type { ImportRunState } from "./import";

/**
 * Import ONLY teams and players from an esportsdesk season, as the starting
 * draft for a new OBHL season. Deliberately a sibling of runEsportsdeskImport
 * rather than a flag on it: that one is a faithful one-time migration and this
 * one throws away everything but the rosters, so "success" means two different
 * things. It never calls fetchEsportsdeskSchedule or fetchEsportsdeskStats.
 */
export async function runRosterOnlyImport(
  _prev: ImportRunState,
  formData: FormData,
): Promise<ImportRunState> {
  // Role only, and deliberately: this creates a league that does not exist yet,
  // so there is no membership to check it against. Registered in
  // league-guards.test.ts for exactly this reason.
  const manager = await requireManager();
  const url = String(formData.get("url") ?? "");
  const leagueName = String(formData.get("league_name") ?? "").trim();
  const seasonName =
    String(formData.get("season_name") ?? "").trim() || "Imported Season";
  const sourceSeason = String(formData.get("season") ?? "").trim() || null;
  const ids = parseEsportsdeskUrl(url);
  if (!ids || !leagueName) {
    return { ok: false, message: "Missing the source URL or a league name." };
  }
  // ... continues with the numbered body below ...
}
```

Body, in order — each numbered item is a requirement, not decoration:

1. `slugify(leagueName)`; reject an empty slug and `isReservedLeagueSlug`, reusing the two messages `runEsportsdeskImport` already uses. Both cases otherwise create a league nobody can open, and there is no UI to delete one.
2. `fetchEsportsdeskLeague(ids.clientId, ids.leagueId, sourceSeason)` in try/catch.
3. Insert the league; map error code `23505` to "A league named X already exists".
4. **`await addLeagueMembership(manager.id, league.id)` — before anything else is written.**
5. `logAudit`: `action: "import_league"`, `entity_type: "league"`, `new_data: { name, slug, source: url, mode: "rosters_only" }`.
6. Insert the season, `is_active: false`. On failure, delete the league and return `ok: false` — the audit entry cascades away with it (`audit_log.league_id` is `on delete cascade`, per `0031`), which is correct: nothing was created.
7. Per team: insert `teams` (palette colour by index), `season_teams`, bulk-insert `players`, bulk-insert `team_players`.

The jersey rule carries over verbatim — `unique (season_id, team_id, jersey_number)` would otherwise fail the whole bulk insert:

```ts
// A jersey is unique per team, so only the first wearer keeps the number and
// later repeats get null (the bulk insert can't lean on a per-row retry).
// Postgres does not collide nulls in a unique index, so any number of
// unnumbered players is fine.
const usedJerseys = new Set<number>();
const rosterRows = t.players.map((p, i) => {
  let jersey = p.number;
  if (jersey != null) {
    if (usedJerseys.has(jersey)) jersey = null;
    else usedJerseys.add(jersey);
  }
  return {
    season_id: season.id, team_id: team.id, player_id: inserted[i].id,
    jersey_number: jersey, position: p.position, is_captain: p.isCaptain,
  };
});
await admin.from("team_players").insert(rosterRows);
```

8. `revalidatePath("/[league]/manage/seasons", "page")`, `revalidatePath("/[league]", "layout")`, `revalidatePath("/")`.
9. Return `ok: true` with counts, plus the standing reminder that the season is inactive and goalie positions need setting.

- [ ] **Step 4: Run the guard test** — `npm test -- league-guards`. If "uses no role-only guard in an action outside the allowlist" fails, count `requireManager()` occurrences in your file; it must be exactly 1.
- [ ] **Step 5: Commit** — `git commit -m "feat: roster-only esportsdesk import"`

## Task A3: Import page mode toggle

**Files:** Modify `src/components/manage/esportsdesk-import.tsx`, `src/app/[league]/manage/import/page.tsx`; create `e2e/17-roster-import.spec.ts`.

- [ ] **Step 1: Write the failing e2e test**

```ts
/** Roster-only import — teams and players, no games. */
import { test, expect } from "@playwright/test";

test("rosters-only mode hides the game count in the preview", async ({ page }) => {
  await page.goto("/login");
  await page.getByRole("button", { name: "Manager" }).click();
  await page.waitForURL("/");
  await page.goto("/obhl/manage/import");

  await page.getByLabel(/rosters only/i).check();
  await expect(page.getByText(/games? found/i)).toHaveCount(0);
});
```

- [ ] **Step 2: Run it to verify it fails** — `npx playwright test e2e/17-roster-import.spec.ts` → no "rosters only" control.
- [ ] **Step 3: Add the toggle.** A radio group, defaulting to **Rosters only** (the common case now): *Rosters only (new season setup)* → `runRosterOnlyImport`; *Full migration (teams, schedule, results, stats)* → `runEsportsdeskImport`. In rosters-only mode suppress the game-count line and reword the button to "Import rosters". `previewEsportsdeskImport` is unchanged — it fetches and writes nothing, which is why it is exempt in the guard test.
- [ ] **Step 4: Run the test** → PASS.
- [ ] **Step 5: Commit** — `git commit -m "feat: rosters-only mode on the import page"`

## Task A4: Duplicate detection (pure)

**Files:** Create `src/lib/players/duplicates.ts`, `src/lib/players/duplicates.test.ts`.

**Interfaces:**
```ts
export type DuplicateCandidate = {
  playerId: string; firstName: string; lastName: string;
  seasonId: string; teamId: string; teamName: string;
  jerseyNumber: number | null; position: "F" | "D" | "G";
};
export type DuplicateCluster = { key: string; members: DuplicateCandidate[] };
export function findDuplicateClusters(
  rows: DuplicateCandidate[],
  dismissed?: ReadonlyArray<readonly [string, string]>,
): DuplicateCluster[];
```

> **Normalize `dismissed` inside this function, not at the call site.** `0035` stores ordered pairs (`check (player_a < player_b)`). If a caller passes a pair in the other order and the comparison is literal, no dismissal ever matches — clusters reappear, the table fills up, and the whole feature looks like it is working. Sort each pair on the way in.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from "vitest";
import { findDuplicateClusters, type DuplicateCandidate } from "./duplicates";

const row = (o: Partial<DuplicateCandidate> & { playerId: string }): DuplicateCandidate => ({
  firstName: "Mike", lastName: "Smith", seasonId: "s1", teamId: "t1",
  teamName: "Sharks", jerseyNumber: 17, position: "F", ...o,
});

describe("findDuplicateClusters", () => {
  it("groups the same name across different teams", () => {
    const out = findDuplicateClusters([
      row({ playerId: "a", teamId: "t1", teamName: "Sharks" }),
      row({ playerId: "b", teamId: "t2", teamName: "Bears" }),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].members.map((m) => m.playerId).sort()).toEqual(["a", "b"]);
  });

  it("ignores case, punctuation and extra whitespace", () => {
    const out = findDuplicateClusters([
      row({ playerId: "a", firstName: "Mike", lastName: "O'Brien" }),
      row({ playerId: "b", firstName: " mike ", lastName: "obrien" }),
    ]);
    expect(out).toHaveLength(1);
  });

  it("returns no cluster for a unique name", () => {
    expect(findDuplicateClusters([row({ playerId: "a" })])).toEqual([]);
  });

  it("does not cluster one player appearing twice under one id", () => {
    const out = findDuplicateClusters([
      row({ playerId: "a", teamId: "t1" }),
      row({ playerId: "a", teamId: "t2" }),
    ]);
    expect(out).toEqual([]);
  });

  it("drops a pair the operator dismissed as different people", () => {
    const out = findDuplicateClusters(
      [row({ playerId: "a" }), row({ playerId: "b" })],
      [["a", "b"]],
    );
    expect(out).toEqual([]);
  });

  it("matches a dismissed pair given in either order", () => {
    // 0035 stores player_a < player_b. A literal comparison here would make
    // every dismissal a silent no-op in one direction.
    const out = findDuplicateClusters(
      [row({ playerId: "b" }), row({ playerId: "a" })],
      [["b", "a"]],
    );
    expect(out).toEqual([]);
  });

  it("still clusters a third record when only one pair was dismissed", () => {
    const out = findDuplicateClusters(
      [row({ playerId: "a" }), row({ playerId: "b" }), row({ playerId: "c" })],
      [["a", "b"]],
    );
    expect(out).toHaveLength(1);
    expect(out[0].members).toHaveLength(3);
  });
});
```

> The last test encodes a deliberate choice: dismissing a *pair* does not dissolve a *cluster*. Three same-name records where only a–b are known-distinct still need the operator's eye on a–c and b–c.

- [ ] **Step 2: Run it to verify it fails** — `npm test -- duplicates`.
- [ ] **Step 3: Implement.** Normalize with the same rule the importer uses (lowercase, strip non-alphanumerics). Cluster on `normName(first + last)`; a cluster requires **two or more distinct `playerId`s**. Drop a cluster only when every pair within it is dismissed.
- [ ] **Step 4: Run the tests** → PASS (6 tests).
- [ ] **Step 5: Commit** — `git commit -m "feat: detect same-name player clusters"`

## Task A5: Merge planning (pure)

**Files:** Create `src/lib/players/merge-plan.ts`, `src/lib/players/merge-plan.test.ts`.

This task carries the two refusals. A merge is **not revertible**, so refusing is cheap and being wrong is not.

**Interfaces:**
```ts
export type RosterRow = { id: string; playerId: string; seasonId: string;
  teamId: string; jerseyNumber: number | null; isCaptain: boolean };
export type GameRow = { id: string; gameId: string; teamId: string;
  playerId: string; goals: number; assists: number; pim: number };

/** One game's outcome: a surviving roster row holding the summed totals. */
export type GameResolution = {
  gameId: string;
  survivorId: string;      // the game_rosters row that stays
  deleteIds: string[];     // rows absorbed into it
  goals: number; assists: number; pim: number;   // summed across all of them
  repoint: boolean;        // survivor.player_id must be rewritten to keepId
};

export type MergePlan =
  | { ok: false; reason: "opposing-teams"; gameId: string }
  | { ok: false; reason: "different-active-teams"; teamIds: string[] }
  | { ok: false; reason: "both-linked"; playerIds: string[] }
  | { ok: true; rosterKeep: string[]; rosterDelete: string[]; games: GameResolution[] };

export function planMerge(
  keepId: string,
  rosters: RosterRow[],
  games: GameRow[],
  /** Player ids that have a `profiles` row pointing at them. */
  linkedPlayerIds?: readonly string[],
): MergePlan;
```

> The profile check lives here rather than in the action so all three refusals are in one tested place. `profiles` has **no unique index on `player_id`** (verified: the only index is `profiles_pkey` on `id`), so re-pointing two linked records leaves two accounts controlling one player — and `is_captain_of` joins `profiles` on `player_id`, so both would hold captain rights over that team.

> **Why per-game and not pairwise.** An earlier draft returned `{keepId, deleteId, …}` pairs plus a flat "repoint these" list. With three duplicates in one game that double-counts, and when the kept player has no row for a game two duplicates both played, two rows repoint onto the same `(game_id, player_id)` and violate the unique constraint. One resolution per game handles 2-way and N-way identically.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from "vitest";
import { planMerge, type RosterRow, type GameRow } from "./merge-plan";

const g = (o: Partial<GameRow> & { id: string; playerId: string }): GameRow => ({
  gameId: "g1", teamId: "t1", goals: 0, assists: 0, pim: 0, ...o,
});

describe("planMerge", () => {
  it("sums three records dressed for the same game into one row", () => {
    const plan = planMerge("keep", [], [
      g({ id: "r1", playerId: "keep", goals: 1, assists: 2 }),
      g({ id: "r2", playerId: "dupe1", goals: 2, assists: 1, pim: 4 }),
      g({ id: "r3", playerId: "dupe2", goals: 0, assists: 3 }),
    ]);
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.games).toEqual([{
      gameId: "g1", survivorId: "r1", deleteIds: ["r2", "r3"],
      goals: 3, assists: 6, pim: 4, repoint: false,
    }]);
  });

  it("elects a survivor and repoints when the kept player did not dress", () => {
    const plan = planMerge("keep", [], [
      g({ id: "r2", playerId: "dupe1", goals: 1 }),
      g({ id: "r3", playerId: "dupe2", goals: 2 }),
    ]);
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.games[0]).toMatchObject({
      survivorId: "r2", deleteIds: ["r3"], goals: 3, repoint: true,
    });
  });

  it("refuses when two records played the same game on opposite teams", () => {
    const plan = planMerge("keep", [], [
      g({ id: "r1", playerId: "keep", teamId: "t1" }),
      g({ id: "r2", playerId: "dupe1", teamId: "t2" }),
    ]);
    expect(plan).toEqual({ ok: false, reason: "opposing-teams", gameId: "g1" });
  });

  it("refuses when the records are active on different teams in one season", () => {
    const rosters: RosterRow[] = [
      { id: "a", playerId: "keep", seasonId: "s", teamId: "t1", jerseyNumber: 9, isCaptain: false },
      { id: "b", playerId: "dupe1", seasonId: "s", teamId: "t2", jerseyNumber: 9, isCaptain: false },
    ];
    const plan = planMerge("keep", rosters, []);
    expect(plan).toMatchObject({ ok: false, reason: "different-active-teams" });
  });

  it("refuses when two of the records have linked user accounts", () => {
    const plan = planMerge("keep", [], [], ["keep", "dupe1"]);
    expect(plan).toMatchObject({ ok: false, reason: "both-linked" });
  });

  it("allows the merge when only one record is linked", () => {
    const plan = planMerge("keep", [], [], ["dupe1"]);
    expect(plan.ok).toBe(true);
  });

  it("keeps the richer roster row on the same team and season", () => {
    const rosters: RosterRow[] = [
      { id: "r1", playerId: "keep", seasonId: "s", teamId: "t", jerseyNumber: null, isCaptain: false },
      { id: "r2", playerId: "dupe1", seasonId: "s", teamId: "t", jerseyNumber: 17, isCaptain: true },
    ];
    const plan = planMerge("keep", rosters, []);
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.rosterKeep).toEqual(["r2"]);
    expect(plan.rosterDelete).toEqual(["r1"]);
  });
});
```

- [ ] **Step 2: Run it to verify it fails** — `npm test -- merge-plan`.

- [ ] **Step 3: Implement, in this order** (the refusals come first, so no resolution is computed for a merge that will not happen):

1. **`opposing-teams`** — group `games` by `gameId`; if any group holds more than one `teamId`, refuse. Two same-named records on both sides of one game is proof they are two people, and summing them would move goals across teams.
2. **`different-active-teams`** — group `rosters` by `seasonId`; if any season holds more than one `teamId`, refuse. `left_on` does not exist until Phase B, so a dual-roster cannot be recorded as a departure; the operator removes one roster row first. **This refusal is also what keeps Task B1's new unique index creatable.**
3. **`both-linked`** — if two or more of `linkedPlayerIds` fall inside the merge set, refuse. Merging would give two user accounts control of one player, and captain rights with it. The operator unlinks one account first.
4. Per game: survivor is the row whose `playerId === keepId`, else the lowest `id`; `repoint = survivor.playerId !== keepId`; totals are the sum over every row in the group; `deleteIds` is the rest.
5. Per `(seasonId, teamId)`: keep the richest roster row — a jersey beats none, then captaincy, then lowest `id` for determinism — and delete the others.

- [ ] **Step 4: Run the tests** → PASS (7 tests).
- [ ] **Step 5: Commit** — `git commit -m "feat: merge planning with per-game resolution and refusals"`

## Task A6: `mergePlayers` action + dismissal table

**Files:** Create `supabase/migrations/0035_player_distinct_pairs.sql`, `src/lib/actions/players.ts`; modify `supabase/migrations/0002_core.sql` (comment only).

- [ ] **Step 1: Write the migration**

```sql
-- Pairs the operator has judged to be two different people who share a name.
-- Without this, a dismissed cluster reappears on every visit to the duplicates
-- page forever, and the tool becomes noise the operator learns to skip.
--
-- Ordered pair (check a < b) so one judgement is one row regardless of which
-- record was listed first.
create table player_distinct_pairs (
  id         uuid primary key default gen_random_uuid(),
  league_id  uuid not null references leagues(id) on delete cascade,
  player_a   uuid not null references players(id) on delete cascade,
  player_b   uuid not null references players(id) on delete cascade,
  created_at timestamptz not null default now(),
  created_by uuid references auth.users(id) on delete set null,
  constraint player_distinct_pairs_ordered check (player_a < player_b),
  unique (league_id, player_a, player_b)
);

alter table player_distinct_pairs enable row level security;
-- No policies and no grants: every read and write here is the admin client,
-- and an absent grant cannot be dropped by a later migration the way a policy
-- can. Same reasoning as 0034's league_office table.
```

- [ ] **Step 2: Apply and regenerate types** — `npm run db:reset && npm run gen-types`.

- [ ] **Step 3: Write the action**

```ts
// Scope is one league, structurally. Candidates come only from players
// reachable through team_players -> seasons -> league_id for THIS league, so a
// cross-league merge is not a disabled button — it is unreachable. That is what
// makes "the same human in two leagues is two records" a property of the code
// rather than a rule someone has to remember.
const manager = await requireLeagueManager(league_id);
```

`mergePlayers` then:
1. Loads the roster rows, game rows, **and the `profiles` rows whose `player_id` is in the merge set**, calls `planMerge` with all four, and **returns the refusal message unchanged if `ok` is false** — the UI renders it verbatim so the operator learns why.
2. **Re-derives each merged player's league set and refuses if any is reachable from another league.** The UI cannot offer it; this is the half that holds against a hand-made POST.
3. Applies `rosterDelete`, then each `GameResolution` (update the survivor to the summed totals and `keepId`, delete `deleteIds`), then re-points `team_goalie_days.player_id`, `games.home_goalie_id`, `games.away_goalie_id`, `profiles.player_id`, then deletes the absorbed `players` rows.

> ⚠️ **The `players` delete must be last, and the reason is not obvious from reading the code.** `game_rosters.player_id` is `on delete cascade` (`0004_games.sql:38`), so deleting an absorbed `players` row before its game rows have been re-pointed **silently destroys that player's entire stat history** — no error, no partial failure, just missing rows. Moving this line up looks like harmless tidying and is not.
4. `logAudit` as `merge_players`, absorbed ids in `old_data`, `league_id` resolved **before** the writes.

`dismissDuplicatePair(formData)` inserts into `player_distinct_pairs` with the ids sorted so `player_a < player_b`. It reaches `requireLeagueManager`, so neither action needs guard-test registration.

- [ ] **Step 4: Run the tests** — `npm test -- merge-plan && npm test -- league-guards` → PASS.

- [ ] **Step 5: Correct the stale identity comment.** `supabase/migrations/0002_core.sql:43` asserts "Identity is GLOBAL (not league-scoped)". Identity stays global *in the schema* — `players` still has no `league_id` — but every operation that could join two identities is now league-scoped. Amend it to say both. A comment asserting the opposite of what the code guarantees is load-bearing for the next reader's model.

- [ ] **Step 6: Commit** — `git commit -m "feat: league-scoped player merge"`

## Task A7: Merge review UI

**Files:** Create `src/app/[league]/manage/people/duplicates/page.tsx`, `e2e/18-merge-duplicates.spec.ts`.

- [ ] **Step 1: Write the failing e2e test**

```ts
/** Duplicate merge review. */
import { test, expect } from "@playwright/test";

test("duplicates page loads and is scoped to this league", async ({ page }) => {
  await page.goto("/login");
  await page.getByRole("button", { name: "Manager" }).click();
  await page.waitForURL("/");
  await page.goto("/obhl/manage/people/duplicates");

  await expect(
    page.getByRole("heading", { name: /possible duplicates/i }),
  ).toBeVisible();
  // Every listed name must belong to THIS league. The seed builds names from
  // arrays, so real clusters may or may not exist — assert the scope, not a
  // count, or this test breaks whenever the seed's name arithmetic changes.
  await expect(page.getByText("Anchors")).toHaveCount(0);
});
```

> **Do not** test the cross-league denial here. `supabase/seed.sql` seeds two leagues (`obhl`, `harbor`), but the e2e manager belongs to **both**, so a browser cannot reach the refusal — the exact gap `league-guards.test.ts` exists to cover. `harbor`'s teams are Anchors, Gulls, Mariners, Tide (`seed.sql:217`); `obhl`'s are Sharks, Bears, Wolves, Ducks, Hawks, Bisons (`seed.sql:109`).

- [ ] **Step 2: Run it to verify it fails** — expect a 404.
- [ ] **Step 3: Build the page.** It **must** call `await requireLeagueManager(...)` — `league-guards.test.ts` fails any manage page that does not, and any that uses a role-only guard. Per cluster: each member's team, jersey, position and season; a radio to choose the record to keep; a "these are different people" button per pair calling `dismissDuplicatePair`; and the **not revertible** warning beside the merge button. Render a refusal from `planMerge` as an explanatory message, not a generic error — "these two played each other on 12 Jan, so they are two people" is the whole value of the check; `both-linked` should name the two accounts and say to unlink one.

Add a **"Show dismissed"** toggle listing dismissed pairs with an undo that deletes the `player_distinct_pairs` row. Without it a misclick permanently hides a real duplicate, recoverable only in SQL — and the operator has no way to know it happened.
- [ ] **Step 4: Run the test** → PASS.
- [ ] **Step 5: Commit** — `git commit -m "feat: duplicate player merge review page"`

**Phase A ships here.** It is safe without Phase B **only because no games exist yet**. Once a game is final, merging two players who both dressed for it starts summing stat rows and the Phase B traps become reachable. If the season starts before B lands, take the merge tool down.

---

# Phase B — Mid-season transfers

## Task B1: The `left_on` migration

**Files:** Create `supabase/migrations/0036_roster_departures.sql`; modify `src/lib/db/types.ts` (generated).

- [ ] **Step 1: Run the pre-flight check — this gates the whole task**

```sql
-- MUST return zero rows before 0036 is applied. The new partial unique index
-- below cannot be created against data where one player is on two teams in one
-- season. Task A5's "different-active-teams" refusal is what normally prevents
-- this, but hand-edited rosters and pre-A data can still produce it.
select season_id, player_id, count(*)
from team_players
group by season_id, player_id
having count(*) > 1;
```

If it returns rows, resolve each by removing the roster row the player is not actually on. **Do not proceed until it is empty.**

- [ ] **Step 2: Write the migration**

```sql
-- A player who leaves a team mid-season keeps their roster row; left_on marks
-- when they left, and NULL means they are still on the team.
--
-- The row SURVIVING is the point. v_goalie_stats INNER JOINs team_players to
-- find the dressed position='G' player, so deleting the row erases the old
-- team's entire goalie record — GP, W/L, GAA, shutouts — while the games
-- themselves remain. v_skater_stats LEFT JOINs the same row for jersey_number
-- and position, so deleting it leaves the old team's line with both columns
-- null. Neither failure reports an error.
--
-- No attribution depends on this date: game_rosters.team_id already records
-- which team a player played each game for. left_on is for humans and ordering.
alter table team_players add column left_on date;

comment on column team_players.left_on is
  'Date the player left this team; NULL means currently rostered. Attribution comes from game_rosters.team_id, never from this column.';

-- A departed player's number frees up for a new signing, while their history
-- keeps the number it was earned under.
alter table team_players drop constraint team_players_season_id_team_id_jersey_number_key;
create unique index team_players_active_jersey
  on team_players (season_id, team_id, jersey_number)
  where left_on is null;

-- Makes "the player's current team" well-defined rather than merely usual, so
-- the leaderboard's current-team join in 0037 can never return two rows.
create unique index team_players_one_active_team
  on team_players (season_id, player_id)
  where left_on is null;

create index team_players_active_idx
  on team_players (season_id, team_id) where left_on is null;
```

> ⚠️ Confirm the dropped constraint's generated name first: `psql "$DB" -c "\d team_players"`. Postgres names it from the column list, but do not assume.

- [ ] **Step 3: Apply locally and regenerate types** — `npm run db:reset && npm run gen-types`. Expect `left_on` on `team_players` in the generated types.
- [ ] **Step 4: Prove the indexes.** Two active rows with the same jersey on one team must raise `23505`; the same jersey where one row has a `left_on` must insert. Two active rows for one player in one season must raise `23505`.
- [ ] **Step 5: Commit** — `git commit -m "feat: soft departures on team_players"`

## Task B2: Rebuild the stats views + season totals

**Files:** Create `supabase/migrations/0037_transfer_stats.sql`, `scripts/verify-transfers.mjs`; modify `package.json`.

This task carries the §2 regression fix. **`0024_exclude_drafts_from_stats.sql` is the last migration to define `v_goalie_stats`, and it rebuilt from `0014`'s definitions rather than `0015`'s** — silently reverting the explicit goalie of record and the empty-net subtraction. Watched, 2026-09-03: `pg_get_viewdef('v_goalie_stats')` contains neither `home_goalie_id` nor `empty_net`, while `src/lib/actions/games.ts:231,251` still writes both and `manage/score/[gameId]/page.tsx:152` still shows them back. **GAA is inflated by empty-net goals today.**

- [ ] **Step 1: Write the migration**

Rebuild `v_goalie_stats` from **0015's** body — all three `goalie_appearances` branches and the `greatest(0, r.ga - empty_net)` adjustment — with **0024's** filter `where status = 'final' and game_type = 'regular' and not is_draft` in the `finals` CTE. Both intents survive; neither is inferred from the other.

**The fallback branch's `join team_players` must NOT filter on `left_on`** — that join is exactly the history being preserved. A departed goalie's old games depend on it.

Then the totals views:

```sql
create view v_skater_season_totals with (security_invoker = true) as
with agg as (
  select season_id, player_id,
         sum(gp)::int gp, sum(g)::int g, sum(a)::int a, sum(pim)::int pim
  from v_skater_stats group by season_id, player_id
)
select agg.season_id, agg.player_id, p.first_name, p.last_name,
       cur.team_id, tm.name as team_name, tm.slug as team_slug,
       tm.color as team_color, cur.jersey_number, cur.position,
       agg.gp, agg.g, agg.a, (agg.g + agg.a) as pts, agg.pim
from agg
join players p on p.id = agg.player_id
-- The CURRENT team. 0036's partial unique index guarantees at most one.
left join team_players cur
  on cur.season_id = agg.season_id and cur.player_id = agg.player_id
 and cur.left_on is null
left join teams tm on tm.id = cur.team_id;
```

`v_goalie_season_totals` is the same shape **except GAA is recomputed, never averaged**: `round(sum(ga)::numeric / nullif(sum(gp), 0), 2)`. Averaging per-team GAA is wrong whenever the split is uneven.

Both joins are `left`, so a player with stats but no active roster row (released outright) still appears with a null team. That is intended.

- [ ] **Step 2: Regenerate types** — `npm run gen-types`.

- [ ] **Step 3: Write `scripts/verify-transfers.mjs`**

Model it on `scripts/verify-scoring.mjs` — same admin/anon client setup and `.env.local` key check. Four assertions:

1. **Goalie of record.** Finalize a game with an explicit `home_goalie_id` *and* a non-zero `home_empty_net_against`; assert the credited goalie is the picked one (not the lowest `player_id`) and that GAA excludes the empty-net goals.
2. **Transfer preserves history.** Transfer a goalie who has final games for team A; assert their **team A** row in `v_goalie_stats` reports the same GP, W/L, GAA and shutouts afterwards.
3. **RLS on the nested views.** Set a league `is_public = false` via the admin client, read `v_skater_season_totals` for its season with the **anon** key, assert zero rows, then restore in a `finally` so a mid-run failure cannot leave a public league dark. The totals views nest one `security_invoker` view inside another and that chain is otherwise untested.

**Guard the script before it writes anything.** `verify-scoring.mjs:6` reads `NEXT_PUBLIC_SUPABASE_URL` with only a localhost *default* — `.env.local` overrides it — and this script mutates a league's visibility, so it must refuse to run anywhere but a local database:

```js
// This script flips a league private and finalizes games. `.env.local` can
// point NEXT_PUBLIC_SUPABASE_URL at a real deployment, so refuse outright
// rather than trusting the caller to have the right env loaded.
const isLocal = /^https?:\/\/(127\.0\.0\.1|localhost)(:|\/|$)/.test(url);
if (!isLocal) {
  console.error(`Refusing to run against ${url} — this script writes. Local only.`);
  process.exit(1);
}
```
4. **Grants.** Assert `anon` and `authenticated` both hold `SELECT` on both new views:
   ```sql
   select grantee, privilege_type from information_schema.role_table_grants
   where table_name in ('v_skater_season_totals','v_goalie_season_totals')
     and grantee in ('anon','authenticated') and privilege_type = 'SELECT';
   ```
   Measurement says Supabase's default privileges cover new objects — `team_goalie_days` (0023, no grant in its migration) has `anon` SELECT — but `0034_league_office.sql` asserts the opposite for tables, so settle it here rather than trusting either.

Add `"verify:transfers": "node --env-file-if-exists=.env.local scripts/verify-transfers.mjs"` to `package.json`.

- [ ] **Step 4: Run it** — `npm run db:reset && npm run verify:transfers`. **If assertion 1 fails, the 0015 restore is incomplete — do not proceed.**
- [ ] **Step 5: Commit** — `git commit -m "fix: restore goalie of record and empty-net; add season totals views"`

## Task B3: Point the leaderboards at the totals views

**Files:** Modify `src/lib/queries/stats.ts`, `src/lib/queries/players.ts`, and the components those types flow into.

- [ ] **Step 1: Split the exported types.** `SkaterStat`/`GoalieStat` are currently `Views<"v_skater_stats">` and are consumed directly by components. Changing what `getSkaterLeaders` returns changes those types, so name both:

```ts
export type SkaterStat = Views<"v_skater_stats">;               // per-team — team pages
export type GoalieStat = Views<"v_goalie_stats">;               // per-team — team pages
export type SkaterTotals = Views<"v_skater_season_totals">;     // leaderboards
export type GoalieTotals = Views<"v_goalie_season_totals">;     // leaderboards
```

- [ ] **Step 2:** Change `getSkaterLeaders` / `getGoalieLeaders` to read the totals views and return the totals types. This covers all three leaderboard consumers: `(public)/page.tsx:40`, `(public)/stats/page.tsx:24,25`, and `seasons.ts:319` (the AI league summary).
- [ ] **Step 3: Run `npm run typecheck` and follow the errors.** Every component typed on `SkaterStat` that renders leaders must move to `SkaterTotals`. The typecheck is the worklist — do not hand-hunt for call sites.
- [ ] **Step 4:** Leave `src/lib/queries/teams.ts:72,78` **unchanged** — team pages read the per-team views and must keep doing so.
- [ ] **Step 5:** Player pages show **both**: the season total at the top, the per-team breakdown beneath. `queries/players.ts:88` derives team and position from `v_skater_stats` as a fallback for players with no roster row — that fallback must keep reading the **per-team** view, since the totals view's team column is the *current* one and would defeat the purpose.
- [ ] **Step 6:** `npm test && npm run typecheck && npx playwright test e2e/01-public.spec.ts`, then commit — `git commit -m "feat: leaderboards show one line per player"`

## Task B4: Filter the read sites

**Files:** the eight reads below.

- [ ] **Step 1: Add `.is("left_on", null)` to every read that means "who is on this team now"** — `manage/rosters/[teamId]/page.tsx`, `manage/dashboard/page.tsx:169`, `manage/seasons/[seasonId]/page.tsx:89`, `manage/people/page.tsx:62`, `manage/score/[gameId]/page.tsx`, `queries/teams.ts:66`, `queries/players.ts:56`, `queries/games.ts`.
- [ ] **Step 2: Leave two reads deliberately unfiltered, and comment why.** `player_is_public` (`0008_rls_public.sql:29`) — a player who left a team is still a real person who appeared in a public league, and their page should still resolve. `src/lib/league/of-entity.ts` — it answers which league a row belongs to, which a departure does not change.
- [ ] **Step 3:** `npm test && npm run test:e2e`, then commit — `git commit -m "fix: departed players leave the active roster"`

## Task B5: Writes that must respect a departure

**Files:** Create `supabase/migrations/0038_captain_departures.sql`; modify `src/lib/actions/rosters.ts` (`removeRosterPlayer`), `src/lib/actions/audit.ts`.

Three writes, one reason: after `0036` a roster row is history, so anything that deletes one can destroy the record this design exists to keep.

- [ ] **Step 1: Close the RLS hole**

```sql
-- A transferred captain kept write access to their former team for the rest of
-- the season: is_captain_of only asked whether a roster row with is_captain
-- existed, and after 0036 that row survives the transfer.
create or replace function public.is_captain_of(p_team uuid, p_season uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from team_players tp
    join profiles pr on pr.player_id = tp.player_id
    where pr.id = auth.uid()
      and tp.team_id = p_team
      and tp.season_id = p_season
      and tp.is_captain
      and tp.left_on is null
  );
$$;
```

`transferPlayer` (Task B6) also clears `is_captain`. Both halves ship — an app guard plus an independent RLS half is this codebase's standing pattern.

- [ ] **Step 2: Stop `removeRosterPlayer` from hard-deleting a player who has played**

`src/lib/actions/rosters.ts:114` is `await admin.from("team_players").delete().eq("id", id)`. That is the **same destruction** transfers were fixed for, reached through a different button: delete the row and `v_goalie_stats`' inner join loses the old team's entire goalie record, while `v_skater_stats` loses the jersey and position. Nothing reports an error.

```ts
// A roster row is history after 0036, so removal is only safe when there is no
// history to lose. A player who never dressed was an add to undo — delete it.
// A player who has dressed keeps the row, marked departed, exactly as a
// transfer would: the row is what v_goalie_stats inner-joins to credit their
// games for THIS team, and what v_skater_stats left-joins for jersey/position.
const { count } = await admin
  .from("game_rosters")
  .select("*", { count: "exact", head: true })
  .eq("player_id", existing.player_id)
  .eq("team_id", existing.team_id);

if ((count ?? 0) > 0) {
  await admin
    .from("team_players")
    .update({ left_on: new Date().toISOString().slice(0, 10),
              is_captain: false, is_default_goalie: false })
    .eq("id", id);
} else {
  await admin.from("team_players").delete().eq("id", id);
}
```

`existing` is already fetched above the delete today ("Capture full row before deletion so revert can restore it"), so this needs no extra lookup for the ids. Record which branch ran in the audit entry — a reader asking why a name is still on a stats page needs to tell a departure from a deletion.

- [ ] **Step 3: Fix the audit revert path.** `src/lib/actions/audit.ts` has **two** roster paths and both change:
  - Reverting a *removal* re-inserts the row (or, for the soft branch, clears `left_on`). It must set `left_on` explicitly rather than letting it default, or a reverted removal restores a player as departed — or as active when they were not.
  - `audit.ts:91` *deletes* a `team_players` row to revert an `add_player`. Give it the same conditional as Step 2: if the player has dressed since, mark departed instead of deleting.

- [ ] **Step 4:** `npm test && npx playwright test e2e/04-rosters.spec.ts e2e/06-audit.spec.ts e2e/12-captain-lineup.spec.ts && npm run verify:transfers`, then commit — `git commit -m "fix: removal and revert stop destroying a played roster row"`

## Task B6: `transferPlayer`

**Files:** Modify `src/lib/actions/rosters.ts`; new UI on the roster page; create `e2e/19-transfer.spec.ts`.

- [ ] **Step 1: Write the failing e2e test**

```ts
/** Mid-season transfer. */
import { test, expect } from "@playwright/test";

test("a transferred player leaves one roster and joins the other", async ({ page }) => {
  await page.goto("/login");
  await page.getByRole("button", { name: "Manager" }).click();
  await page.waitForURL("/");
  await page.goto("/obhl/manage/rosters");
  await page.getByText("Sharks").click();
  await expect(page).toHaveURL(/\/rosters\//);

  const name = await page
    .locator("table tbody tr").first().locator("td").first().innerText();

  await page.locator("table tbody tr").first()
    .getByRole("button", { name: /transfer/i }).click();
  await page.getByLabel(/to team/i).selectOption({ label: "Bears" });
  await page.getByRole("button", { name: /confirm transfer/i }).click();
  await page.waitForLoadState("networkidle");

  await expect(page.getByRole("cell", { name })).toHaveCount(0);

  await page.goto("/obhl/manage/rosters");
  await page.getByText("Bears").click();
  await expect(page.getByRole("cell", { name })).toBeVisible();
});
```

> Team names verified against `supabase/seed.sql:109` — `obhl` seeds Sharks, Bears, Wolves, Ducks, Hawks, Bisons.

- [ ] **Step 2: Run it to verify it fails** — `npx playwright test e2e/19-transfer.spec.ts` → no Transfer control on the roster row.

- [ ] **Step 3: Implement, in this order** (the order is load-bearing):

1. Resolve `league_id` **before** any write — an audit entry that resolves its league afterwards lands with a null one and is then hidden from every view that would show it.
2. `requireLeagueManagerOf` over the season **and both team ids** — exactly as `addRosterPlayer` does (`src/lib/actions/rosters.ts:33`). These forms carry ids, never a league, so guarding the season alone lets a foreign `team_id` through.
3. **Set `left_on` on the old row first**, clearing `is_captain` and `is_default_goalie` in the same update. Before the insert, because `team_players_one_active_team` (0036) rejects a second active row otherwise.
4. Delete the old team's `team_goalie_days` rows for that player.
5. **Delete the player's `game_rosters` rows for the old team's games that are not yet `final`.**

```ts
// Captains set lineups in advance (e2e/12-captain-lineup.spec.ts), so
// game_rosters rows exist before a game is played. Left alone, a transferred
// player stays dressed for the old team in games they will not play — which
// becomes a real GP and a real stat line the moment that game is finalized.
//
// Final games are untouched. That history is the whole point of the design.
const { data: upcoming } = await admin
  .from("games")
  .select("id")
  .eq("season_id", season_id)
  .neq("status", "final")
  .or(`home_team_id.eq.${from_team_id},away_team_id.eq.${from_team_id}`);
if (upcoming?.length) {
  await admin
    .from("game_rosters")
    .delete()
    .eq("player_id", player_id)
    .eq("team_id", from_team_id)
    .in("game_id", upcoming.map((g) => g.id));
}
```

6. Insert the new team's row, or clear `left_on` if one already exists (a return to a former team). Carry `position` over.
7. If the wanted jersey is taken on the new team, return a message and let the operator choose — **never silently write null**, which is what the bulk importer does and is wrong for a deliberate single move.
8. `logAudit` with `action: "transfer_player"`, recording the deleted lineup rows in `old_data` so the removal is traceable.
9. **Revalidate both teams and the public pages.** `addRosterPlayer` ends with a single `revalidatePath("/[league]/manage/rosters/[teamId]", "page")`; a transfer changes two rosters plus the public team and stats pages, so it needs more, not fewer. Without this the player shows on **both** rosters until something unrelated invalidates the cache — which looks exactly like the bug this feature exists to prevent.

```ts
revalidatePath("/[league]/manage/rosters/[teamId]", "page");
revalidatePath("/[league]/teams/[slug]", "page");
revalidatePath("/[league]/stats", "page");
revalidatePath("/[league]", "layout");
```

> **`[slug]`, not `[teamSlug]`** — verified against `src/app/[league]/(public)/teams/[slug]`. The `(public)` route group does not appear in the path.
>
> `src/lib/actions/revalidate-paths.test.ts` would **not** have caught a wrong segment name: it checks the `/[league]` prefix, that a `type` accompanies any dynamic segment, and that no id is interpolated — but not that the route exists. A wrong segment passes the suite and revalidates nothing, which is the exact silent failure that test's own header describes.

- [ ] **Step 4:** `npm test && npm run test:e2e && npm run verify:transfers`
- [ ] **Step 5: Commit** — `git commit -m "feat: transfer a player between teams mid-season"`

---

## Verification

```bash
npm run db:reset          # local only — never `supabase db reset --linked`
npm run seed:users
npm test                  # unit: slug, duplicates, merge-plan, league-guards, existing suite
npm run typecheck
npm run test:e2e          # includes the three new specs
npm run verify:transfers  # goalie of record, transfer history, RLS, grants
```

**Manual pass that exercises the actual goal:**

1. `/obhl/manage/import` → Rosters only → paste an esportsdesk URL → import. Confirm teams and players landed and **no games were created**.
2. `/obhl/manage/people/duplicates` → merge a same-name pair; dismiss a different pair and confirm it stays dismissed after a reload; then "Show dismissed" and undo it, confirming the cluster returns.
3. Edit a roster: add and remove players.
4. Score and finalize a game, then transfer a player who played in it. Confirm the leaderboard shows **one** row with combined totals against the new team; the old team's page still shows what was earned there; the new team's shows only what came after.
5. Set a lineup for an upcoming game, transfer one of the dressed players out, then finalize that game. Confirm the transferred player has **no** GP for it.
6. Transfer a **goalie** who has finalized games; confirm the old team's GAA and shutouts are unchanged. This is the case that fails silently if anything in B1 or B2 was skipped.
7. **Remove** a player who has played finalized games, and separately remove one who has never dressed. The first should keep their stat line on the team page and disappear from the active roster; the second should vanish entirely. Do the same for a **goalie** who has played — their GAA must survive removal, not just transfer.

## Notes from self-review

- **Spec coverage:** §3→A2/A3, §4→A4/A5/A6/A7, §5→B1/B6, §6→B2/B3, §7→B4/B5, §8→Task 0 and the phase break, §9→Verification. §2's regression is inside B2, with a hard stop if its assertion fails.
- ⚠️ **The plan now exceeds the spec in one place.** `removeRosterPlayer` (B5 step 2) and the `add_player` revert (B5 step 3) are not mentioned anywhere in the design doc — §5 and §7 discuss transfers and reads only. The spec's own argument covers them, but it does not say so, and a future reader comparing the two will find the plan doing something the spec never asked for. **Amend `docs/superpowers/specs/2026-09-03-roster-import-and-transfers-design.md` §5 to name every write that deletes a roster row**, not just the transfer path.
- **Deliberately not in the plan:** per-league roles, and any change to the `app_role` enum or the JWT hook — out of scope, and the league-office spec depends on them staying still.
- **Ordering risks:** A5's `different-active-teams` refusal is what keeps B1's index creatable — if A5 is descoped, B1's pre-flight becomes a real remediation task. B1 before B2 (the views join a column that must exist). Within B6, `left_on` is set before the insert or the new partial unique index rejects the write.
- **Known gap accepted:** dismissing a pair does not dissolve a three-way cluster; the operator dismisses each pair. Simpler than cluster-level state and matches how the judgement is actually made.
