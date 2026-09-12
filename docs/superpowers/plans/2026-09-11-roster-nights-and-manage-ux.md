# Roster Sections, Player Nights, and the Manage UX Pass — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Spec:** `docs/superpowers/specs/2026-09-11-roster-nights-and-manage-ux-design.md` — read it alongside this plan; the plan argues from it.

---

## ⚠️ This is the plan as WRITTEN, not as built

Kept as the record of intent. Three review rounds and CI changed four things
after it was approved; a reader taking this as a description of the code will be
wrong about each. Read the commits for what shipped.

- **`updatePlayerStatus` and `toggleCaptain` return `RosterActionState` now**,
  not `void`. Task 11 says to wrap them; wrapping discarded the result and left
  the dialog's error paragraph unreachable over two writes that were also
  swallowing their own `.error`. Both were re-signatured; the dialog binds them
  directly.
- **The seed does more than this plan asks.** Beyond the two-night season and
  the second Sharks goalie, `finalize_seed_game` now dresses ONE goalie and
  names the goalie of record — without that, `v_goalie_stats` picked between
  Sharks' two goalies by lowest UUID and flipped between resets. It also gained
  a cancelled future game, because the Cancelled section had no fixture at all.
- **Task 6's "the fixture agrees with the rule the app applies" is false** and
  was corrected in the seed itself: `suggestGoalie` has a third rule (2+ goalies,
  none owns the night ⇒ nobody) the seed deliberately does not copy.
- **The verification section understates the e2e cost.** The dialog moved ~30
  locators across seven specs, not the three named here, and two specs began
  eating the seeded captain once sections reordered the rows.

⛔ **And one thing this plan got right that the execution got wrong:** it said
the migration must be revertible alone. It is — but it was pushed to production
AFTER the code merged, not before, causing a real outage window. See
`LAUNCH_READINESS_HANDOFF.md`, _The rule item 6 leaves behind_.

---

## Context

Five fixes the maintainer asked for, in one pass over the manage surface:

1. The team roster page is one flat table; it should be **Forwards / Defence / Goalies**, each sorted by points then jersey.
2. The per-weekday **goalie schedule** is replaced by a per-player **night** assignment, for leagues that play more than one night a week. For a goalie it names that night's starter.
3. **Editing a player** opens inside the last table cell, which already holds eight buttons — it cannot fit at any width.
4. Schedule builder: default ice times should be **7:00 / 8:20 / 9:40**, and adding a manager request should **clear its own fields**.
5. **Build Schedule** belongs to season setup, not the staff row; once a season starts the Schedule tab must carry everything; the staff row shouldn't duplicate the public row.

Production (read 2026-09-11) is why the goalie model collapses so far: **LCC Old Boys plays Mon+Thu with 5 of 8 teams carrying two goalies** — the case night assignment exists for — while **LCC Executive plays Tue only with one goalie per team**. All three `is_default_goalie` flags in production sit on one-goalie teams, so "one goalie ⇒ that goalie" reproduces every one of them and the column can go. Old Boys is **already started** (3 games played 2026-09-10), so its builder is locked today and `/schedule` is the only surface that matters for it.

**Outcome:** a manager assigns players to nights from one coherent dialog; the roster reads like a hockey roster; the scoresheet picks the right goalie without a second control; and the schedule tools live where the manager looks for them.

---

## Global Constraints

- **Default ice times are exactly `19:00, 20:20, 21:40`** — set in both `schedule-generate-form.tsx` and the `schedule.ts` action fallback, or they disagree.
- **Night values are `0=Sun … 6=Sat`**, matching `leagueWeekday()` and the departing `team_goalie_days.day_of_week`.
- **Spelling is `Defence`** everywhere user-visible (the repo currently says both).
- **A night the season no longer plays renders as `—`; the stored value is left alone.** Regenerating a Tue+Thu season as Tue-only must not silently discard a manager's Thursday assignments.
- **⛔ NO NEW WRITE PATH for rosters.** Every control submits to an existing action in `src/lib/actions/rosters.ts`. `roster-editor.tsx:41-45` records why: `0036` exists because a second, naive transfer destroyed goalie records through `v_goalie_stats`' inner join and reported no error.
- **⛔ Never `form.reset()` in the generate form.** The constraints card and the generate form are one HTML form; React 19's reset is the bug `schedule-generate-form.tsx:107-146` was written to prevent. Clear named fields only.
- **⛔ No RLS work.** Verified: `team_players` and `seasons` each already have a public-read and a manager-write policy covering the whole row, and RLS cannot restrict columns (`0046`'s header says so). New columns inherit both.
- **Next migration number is `0049`.** After any migration: `npm run gen-types` (never hand-edit `src/lib/db/types.ts`).
- **e2e runs only via `scripts/e2e-locked.sh <spec>`** — worktrees share one Supabase, so runs serialise.
- `npm run typecheck` runs **two** tsc passes (app + `e2e/tsconfig.json`).

---

## File Structure

**New files**

| Path | Responsibility |
| --- | --- |
| `src/lib/goalie/suggest.ts` + `.test.ts` | Pure: which goalie the scoresheet pre-selects |
| `src/lib/season/nights.ts` + `.test.ts` | Pure: resolve a season's nights, labels, `hasMultipleNights` |
| `supabase/migrations/0049_player_nights.sql` | Both columns; convert `team_goalie_days`; drop it and `is_default_goalie`; backfill |
| `src/components/public/team-roster-sections.tsx` | The three public sections (F / D / G) |
| `src/components/manage/player-edit-dialog.tsx` | The one dialog holding everything about a player |
| `src/app/[league]/(manage)/schedule/{repair,one-off}/page.tsx` | Moved from `schedule-builder/` |

**Deleted:** `edit-player-form.tsx`, `transfer-player-form.tsx` (absorbed into the dialog); `(manage)/schedule-builder/{repair,one-off}/`.

**Heavily modified:** `src/lib/actions/rosters.ts` · `src/lib/actions/schedule.ts` · `src/components/manage/roster-editor.tsx` · `(public)/teams/[slug]/page.tsx` · `(public)/schedule/page.tsx` · `src/components/shared/staff-links.tsx` · `src/lib/queries/teams.ts` · `supabase/seed.sql`

---

## Task 1 — Default ice times

**Files:** `schedule-generate-form.tsx:750` · `schedule.ts:410` · comment at `schedule-generate-form.tsx:612`

- [ ] **Step 1** — `grep -rn "19:00, 20:15\|19:00,20:15" src/ e2e/`. Expect the form default, the action fallback, and the stale comment. ⛔ The `["19:00","20:15","21:30"]` arrays in `assignNights.test.ts` / `balance.test.ts` are arbitrary slot fixtures, **not** the default — leave them.
- [ ] **Step 2** — Form `defaultValue` → `"19:00, 20:20, 21:40"`; action fallback → `"19:00,20:20,21:40"`; fix the `:612` comment.
- [ ] **Step 3** — `npm run typecheck && npm test`
- [ ] **Step 4** — Commit: `fix(schedule): default the ice times to 7:00, 8:20 and 9:40`

---

## Task 2 — Manager-request fields clear on add

**Files:** `schedule-generate-form.tsx` (`ConstraintsCard`, effect at 199-203)

Inputs are uncontrolled: `constraint_team_id`, `constraint_date`, `constraint_week_of`, `constraint_time`, `constraint_from`, `constraint_to`, `constraint_prefer`. `constraint_kind` is controlled and **stays put** — a manager adding three byes wants the kind to stick.

- [ ] **Step 1: Write the failing e2e** in `e2e/23-schedule-constraints.spec.ts`. ✅ Reuse that file's existing navigation — it is already driven through **Fall 2026's setup page**, never `/schedule-builder`. (OBHL's active season is started, so the builder there is locked and has no generate form. This also means the test is untouched by Task 4.)

```ts
test("adding a manager request clears its own fields", async ({ page }) => {
  await signedInAs(page, "Manager");
  await gotoFallSetup(page);            // the helper this spec already uses
  const form = page.locator("form").filter({ hasText: "Manager requests" });
  await form.getByLabel("Team").selectOption({ index: 1 });
  await form.getByLabel("Date").fill(await secondTuesday());
  await form.getByRole("button", { name: "Add request" }).click();
  await expect(page.getByText(/request added/i)).toBeVisible();
  await expect(form.getByLabel("Team")).toHaveValue("");
  await expect(form.getByLabel("Date")).toHaveValue("");
  // The generate fields it shares a <form> with are untouched.
  await expect(
    form.getByLabel("Ice-time slots (earliest → latest)"),
  ).toHaveValue("19:00, 20:20, 21:40");
});
```

- [ ] **Step 2** — Run; expect failure on the first `toHaveValue("")`.
- [ ] **Step 3** — Clear by name inside the existing `addState` effect; attach `ref={cardRef}` to the card's outer `<div>` (the one already carrying `onKeyDown`):

```ts
const cardRef = useRef<HTMLDivElement>(null);
useEffect(() => {
  if (!addState) return;
  if (addState.ok) {
    toast.success(addState.message);
    // ⛔ NAMED FIELDS ONLY. This card lives inside the generate form, so a
    // reset() here empties the first game night, the ice times and every
    // weekday box — the React 19 behaviour this component was restructured
    // to avoid. See the ⛔ in its header.
    for (const el of cardRef.current?.querySelectorAll<
      HTMLInputElement | HTMLSelectElement
    >("[name^='constraint_']") ?? []) {
      if (el.name === "constraint_kind" || el.name === "constraint_prefer") continue;
      el.value = "";
    }
  } else toast.error(addState.message);
}, [addState]);
```

- [ ] **Step 4** — Re-run, **plus the regression it must not break**:
  `scripts/e2e-locked.sh e2e/28-schedule-form-state.spec.ts -g "keeps the fields already filled in"`
- [ ] **Step 5** — Commit: `fix(schedule): clear a manager request's fields once it is added`

---

## Task 3 — Staff row stops duplicating the public row

**Files:** `staff-links.tsx:21-42` and its docblocks at `:27-33`, `:116-141` · `e2e/27-one-chrome.spec.ts` · the spec

The manager's list loses `Schedule`, `Teams`, `Rules` (identical URLs to the public row) and `Build Schedule`, leaving **Dashboard · People & Roles · Seasons · Announcements · Audit Log** plus the absolute links.

- [ ] **Step 1** — ⚠️ **Correct the spec first.** Its success criterion 11 requires `e2e/27-one-chrome.spec.ts` to end byte-identical. That invariant was inherited from the predecessor spec, where the chrome genuinely did not change — here it does, and that file's own thesis ("two navigations that named the same URLs differently; now there is one header") is exactly what this task completes. Amend criterion 11 to drop that file, keeping the rest.
  ✅ Checked: the file asserts only `Seasons` in the staff row, so removing the four entries will not break it.
- [ ] **Step 2: Write the failing test** in `27-one-chrome.spec.ts`, reusing its existing `staffRow` / `leagueNav` helpers:

```ts
test("the staff row names no URL the league nav already names", async ({ page }) => {
  await signInAs(page, "Manager");
  await page.goto("/obhl/dashboard");
  const hrefs = (nav: Locator) =>
    nav.locator("a").evaluateAll((as) =>
      as.map((a) => (a as HTMLAnchorElement).getAttribute("href") ?? ""),
    );
  const staffHrefs = await hrefs(staffRow(page));
  const leagueHrefs = await hrefs(leagueNav(page));
  expect(staffHrefs.filter((h) => leagueHrefs.includes(h))).toEqual([]);
});
```

- [ ] **Step 3** — Run; expect failure listing `/obhl/schedule`, `/obhl/teams`, `/obhl/rules`.
- [ ] **Step 4** — Remove the four entries. Rewrite the `:116-141` "THE DUPLICATION IS KNOWN AND ACCEPTED" docblock to record that it was **removed** on 2026-09-11 and why (it also resolves the `aria-current="page"` doubling that block describes) — do not just delete it. Remove the `:27-33` ordering comment with the entries it describes.
- [ ] **Step 5** — `scripts/e2e-locked.sh e2e/27-one-chrome.spec.ts` then `e2e/02-auth.spec.ts` (the 390px guard).
- [ ] **Step 6** — Commit: `refactor(nav): stop the staff row repeating the league nav`

---

## Task 4 — Move the builder's sub-tools under Schedule

**Files:** two directory moves · `next.config.ts` · 15 `revalidatePath` strings · 8 hrefs · `LAUNCH.md:248`

- [ ] **Step 1** — **Check the route shape before moving anything.** Create an empty `(manage)/schedule/repair/page.tsx` returning `null`, run `npm run dev`, confirm `/obhl/schedule` and `/obhl/schedule/repair` both resolve, then delete the stub. The `(public)/games/[gameId]` + `(manage)/games/[gameId]/score` precedent says this works, but the whole task collapses if it doesn't and the check is two minutes.
- [ ] **Step 2** — `git mv` both directories:

```bash
mkdir -p "src/app/[league]/(manage)/schedule"
git mv "src/app/[league]/(manage)/schedule-builder/repair"  "src/app/[league]/(manage)/schedule/repair"
git mv "src/app/[league]/(manage)/schedule-builder/one-off" "src/app/[league]/(manage)/schedule/one-off"
```

⛔ They stay inside `(manage)` so the layout's `if (!user) redirect("/login")` still applies, and each keeps its own `requireLeagueManager` (`repair:40`, `one-off:35`). Do **not** tidy either guard as redundant.

- [ ] **Step 3** — Replace `schedule-builder/page.tsx` with a ~15-line redirect page: resolve league → `requireLeagueManager` → `getManageContext` → `redirect` to `/<league>/seasons/<season.id>`, or `/seasons` when the league has none. A page, not a config redirect, because a config redirect cannot look up which season to land on.
- [ ] **Step 4** — Two `next.config.ts` entries, `permanent: true`: `/:league/schedule-builder/repair` → `/:league/schedule/repair`, same for `one-off`. ⛔ **Two explicit rules, not one `:rest*` wildcard** — `:rest*` is zero-or-more and would swallow the bare `/schedule-builder` into `/schedule`, the hazard `next.config.ts:21-25` already documents.
- [ ] **Step 5** — The 15 `revalidatePath` strings:
  - **11 bare** (`schedule-edits.ts:177`; `schedule.ts:243, 297, 724, 732, 783, 1206, 1330, 1487, 1794, 2122`) → **delete**. Safe because each is immediately followed by `revalidatePath("/[league]/seasons/[seasonId]", "page")` on the next line, and season setup is the builder's only remaining home.
  - **4 sub-route** (`schedule.ts:1490, 2123` → `/repair`; `:1491, 1795` → `/one-off`) → repoint.
- [ ] **Step 6** — The 8 hrefs: `schedule-builder-panel.tsx:434, 453, 509, 607` and `(public)/schedule/page.tsx:266, 273` → `/schedule/{repair,one-off}`. `repair:78` and `one-off:74` are `PageHeader` back-buttons reading "Schedule Builder" — **repoint to `/<league>/schedule` and relabel "Schedule"**, don't delete them; with no tab strip they are the only way back. Update `LAUNCH.md:248` and the two comments naming the URL (`schedule-builder-panel.tsx:54`, `schedule.ts:56`).
- [ ] **Step 7** — `npm test`, then `grep -rn "schedule-builder" src/`.
  ⛔ **THE GREP IS THE PRIMARY CHECK FOR THE 11 DELETIONS, NOT A BELT-AND-BRACES.** An earlier draft of this plan said `revalidate-paths.test.ts` would catch a missed string "by name — trust it over grepping". **Measured 2026-09-11 by mutation: it does not.** The guard asserts every pattern resolves to a real route, and `/[league]/schedule-builder` still does — Step 3 leaves a redirect PAGE at exactly that path. A leftover bare call therefore passes all 8 assertions.
  ✅ It *does* catch the four sub-route repointings: re-adding `"/[league]/schedule-builder/repair"` fails by name, because that directory is gone. So the guard covers the repoints and the grep covers the deletions; neither covers both.
- [ ] **Step 8** — e2e: add three rows to `15-league-routing.spec.ts`'s `moved` array (both sub-tools + the bare builder) — without them the new redirects are untested, per that spec's docblock at `:664`. Rewrite the `goto` sites: **a builder `goto` becomes `/obhl/seasons/<id>`, not `/schedule/build`** — there is no build page; add a helper resolving the Fall 2026 id once. Fix `16-league-membership.spec.ts:157-158` (`MANAGE_PATHS` → `/schedule/one-off`, `/schedule/repair`) and rewrite the comment at `:159-161` so the new children don't read as an oversight against a deliberately-absent bare `/schedule`.
- [ ] **Step 9** — `scripts/e2e-locked.sh` over `15-league-routing`, `11-schedule-builder`, `29-schedule-repair`, `30-schedule-edits`, `14-one-off-game`, `31-stale-draft`, `23-schedule-constraints`, `28-schedule-form-state`.
- [ ] **Step 10** — Commit: `refactor(schedule): move repair and one-off under /schedule`

---

## Task 5 — "Move a game night" on the Schedule tab

**Files:** `(public)/schedule/page.tsx`

The one control a started season has in the builder but not on `/schedule`. `rescheduleNight` already revalidates `/[league]/schedule` (`schedule.ts:1493`), so no new revalidation.

- [ ] **Step 1: Write the failing e2e** in `e2e/30-schedule-edits.spec.ts`: as Manager on `/obhl/schedule`, `getByRole("heading", { name: "Move a game night" })` is visible; as Scorekeeper, `toHaveCount(0)`.
- [ ] **Step 2** — Run; expect the manager leg to fail.
- [ ] **Step 3** — Render it in the `canManage` block, above the "Bigger changes:" sentence, props mirroring `schedule-builder-panel.tsx:581-586`:

```tsx
<RescheduleNightForm
  seasonId={ctx.season.id}
  nights={openNights.map((n) => ({ date: n.date, games: n.games.length }))}
  minDate={today}                        // already computed on this page
  maxDate={ctx.season.ends_on ?? null}
/>
```

Import `getSeasonNights` from `@/lib/queries/schedule`, and ⛔ **make the await itself conditional, not just the JSX** — `const openNights = canManage ? (await getSeasonNights(ctx.season.id)).filter((n) => !n.locked) : []`. This page is public; an unconditional await bills every anonymous visitor for a query only a manager can use, which is exactly the cost `(public)/teams/[slug]/page.tsx`'s docblock takes care to avoid. Render on `canManage && openNights.length > 0`. ⛔ `canManageLeague`, **not** `canScore` — `(public)/schedule/page.tsx:167-172` already says why for the edit panel.

- [ ] **Step 4** — Re-run; also `e2e/33-scorekeeper-day.spec.ts`.
- [ ] **Step 5** — Commit: `feat(schedule): move a game night from the Schedule tab`

---

## Task 6 — The two pure functions  ⚠️ before the migration, deliberately

**Files:** `src/lib/goalie/suggest.ts` + `.test.ts` · `src/lib/season/nights.ts` + `.test.ts`

Both are pure and have **zero schema dependency**, so they land first and Task 8 can call them the moment the columns exist. Extracted rather than inlined because there is **no `rosters.test.ts`**, and `seasons.test.ts`'s fake admin client lacks the `is`/`in`/`or`/`count` chain methods the roster reads use — a pure function is the only way to get real coverage without building that fake out first.

- [ ] **Step 1: Write the failing goalie test** — house style: real data in, real value out, tiny factory, no mocks.

```ts
import { describe, it, expect } from "vitest";
import { suggestGoalie, type RosterGoalie } from "./suggest";

const g = (playerId: string, number: number | null, night: number | null): RosterGoalie =>
  ({ playerId, number, night });

describe("suggestGoalie", () => {
  it("picks the team's only goalie whatever night it is", () => {
    expect(suggestGoalie([g("a", 1, 1)], 4)).toBe("a");   // assigned Mon, game Thu
    expect(suggestGoalie([g("a", 1, null)], 4)).toBe("a");
  });
  it("picks the goalie assigned to the game's night", () => {
    const two = [g("a", 1, 1), g("b", 30, 4)];
    expect(suggestGoalie(two, 1)).toBe("a");
    expect(suggestGoalie(two, 4)).toBe("b");
  });
  it("picks nobody when two goalies share a team and neither owns the night", () => {
    expect(suggestGoalie([g("a", 1, 1), g("b", 30, 4)], 2)).toBeNull();
    expect(suggestGoalie([g("a", 1, null), g("b", 30, null)], 2)).toBeNull();
  });
  it("breaks a shared night by the lower jersey, deterministically", () => {
    expect(suggestGoalie([g("b", 30, 4), g("a", 1, 4)], 4)).toBe("a");
  });
  it("picks nobody with no goalie, or an unusable date", () => {
    expect(suggestGoalie([], 4)).toBeNull();
    expect(suggestGoalie([g("a", 1, 1), g("b", 30, 4)], -1)).toBeNull(); // leagueWeekday's no-date
  });
});
```

- [ ] **Step 2** — `npx vitest run src/lib/goalie/suggest.test.ts` → FAIL (module not found).
- [ ] **Step 3** — Implement. ⚠️ Rule 1 outranks rule 2 deliberately: a one-goalie team's goalie is suggested every night, which is what "if there is only one goalie then they are the goalie" means.

```ts
export type RosterGoalie = {
  playerId: string;
  number: number | null;
  /** 0=Sun…6=Sat, or null for "no fixed night". */
  night: number | null;
};

export function suggestGoalie(
  goalies: RosterGoalie[],
  gameWeekday: number,
): string | null {
  if (goalies.length === 0) return null;
  if (goalies.length === 1) return goalies[0].playerId;
  const onNight = goalies
    .filter((x) => x.night === gameWeekday)
    // Two goalies may share a night (no uniqueness constraint, on purpose — a
    // team that alternates must be representable). Lowest jersey wins so the
    // suggestion is stable across reads.
    .sort((a, b) => (a.number ?? 999) - (b.number ?? 999));
  return onNight[0]?.playerId ?? null;
}
```

- [ ] **Step 4** — Run → PASS. Then **prove the test can fail** (`[[prove-a-new-test-can-fail]]`): make rule 1 return `null`, confirm the first case goes red, revert.
- [ ] **Step 5: Write the failing nights test** — cases: stored wins; empty falls back to published weekdays; both empty → `[]`; output sorted and de-duplicated; `hasMultipleNights` at exactly 1 and exactly 2 (that boolean gates every piece of UI).
- [ ] **Step 6** — Run → FAIL, then implement `resolveSeasonNights(stored, publishedWeekdays)`, `hasMultipleNights(nights)`, `NIGHT_LABEL` (`["Sun","Mon",…]`), `NIGHT_LONG` (`["Sunday",…]`).
  ⚠️ Name it `resolveSeasonNights`, **not** `getSeasonNights` — `queries/schedule.ts` already exports that for a different thing (game nights grouped by date). Its caller is the season-scoped `seasonNightsFor()` added in Task 8 Step 6; this function stays pure and takes the weekdays as an argument.
- [ ] **Step 7** — `npm test`
- [ ] **Step 8** — Commit: `feat(schedule): pure helpers for a season's nights and its goalie`

---

## Task 7 — The migration, and nothing else  ⛔ the one-way door

**Files:** `supabase/migrations/0049_player_nights.sql` · `src/lib/db/types.ts` (generated)

⛔ **This task is alone in its commit so it can be reverted alone.** The app code that follows the schema is Task 8; the fixture is Task 9. ⚠️ Expect the tree to be **red between this commit and Task 8's** — that is the accepted cost of a revertible migration.

- [ ] **Step 1** — Write `0049_player_nights.sql`. House style: `--` prose header stating the change, then rationale, `⛔`/`⚠️` markers, cross-references by migration number.

```sql
-- A player is assigned to one of the season's game nights; goalies stop having
-- a table of their own.
--
-- ⛔ THIS DROPS `team_goalie_days` AND `is_default_goalie`, AND THE CONVERSION
-- ABOVE THE DROPS IS THE ONLY THING THAT CARRIES THEM FORWARD. Measured against
-- production 2026-09-11: 6 goalie-day rows (Old Boys) and 3 default flags. All
-- three flags sit on teams with exactly ONE goalie, which the new rule
-- "one rostered goalie => that goalie" reproduces — so the flags convert to
-- nothing on purpose, not by omission.
--
-- ⚠️ A player holding TWO day rows keeps NO night. Blue's goalie is listed on
-- both Mon and Thu and is Blue's only goalie; "no fixed night" is the truthful
-- description of playing every night, and the one-goalie rule covers him.

alter table seasons
  add column game_nights smallint[] not null default '{}';

alter table team_players
  add column night_of_week smallint
    check (night_of_week between 0 and 6);

-- Convert: only a player with exactly one day row takes a night.
update team_players tp
   set night_of_week = gd.day_of_week
  from (
    select player_id, team_id, season_id, min(day_of_week) as day_of_week
      from team_goalie_days
     group by player_id, team_id, season_id
    having count(*) = 1
  ) gd
 where tp.player_id = gd.player_id
   and tp.team_id   = gd.team_id
   and tp.season_id = gd.season_id;

-- Backfill the nights each season actually plays, from its published games.
update seasons s
   set game_nights = coalesce(g.nights, '{}')
  from (
    select season_id,
           -- ⛔ NO `order by` HERE. `array_agg(DISTINCT expr ORDER BY 1)` is a
           -- hard error — 42P10, "in an aggregate with DISTINCT, ORDER BY
           -- expressions must appear in argument list": inside an aggregate a
           -- bare `1` is a constant, not a positional reference. Measured
           -- 2026-09-11 by running it. DISTINCT sorts anyway.
           array_agg(distinct extract(dow from
             (scheduled_at at time zone 'America/New_York'))::smallint) as nights
      from games
     where not is_draft and scheduled_at is not null
     group by season_id
  ) g
 where g.season_id = s.id;

drop table team_goalie_days;
alter table team_players drop column is_default_goalie;
```

- [ ] **Step 2** — `npm run db:reset`, then verify the conversion locally rather than assuming it:
  `npx supabase db query "select name, game_nights from seasons order by name;"`
  ✅ Both statements were **executed against production read-only on 2026-09-11**, so the expected values are known before the migration runs anywhere: the backfill returns Executive `{2}` and Old Boys `{1,4}`; the conversion subquery returns Jonah→1, Louis→4, Bram→1, Wes→4, with Luka correctly excluded by `having count(*) = 1`.
- [ ] **Step 3** — `npm run gen-types`, then prettier-format the output to keep the diff small (house practice).
- [ ] **Step 4** — `npm run typecheck` — expect **failures** naming `rosters.ts`, `players.ts`, `audit.ts`, the score page and `roster-editor.tsx`. **That list is Task 8's worklist. Do not fix it here.**
- [ ] **Step 5** — Commit: `feat(db): a player has a night; the goalie-day table goes`
- [ ] **Step 6** — Prepare (do not run) the production block for the maintainer: a COPY FROM HERE / END COPY migration plus the verification query, with expected output written down in advance — Jonah→1, Louis→4, Bram→1, Wes→4, Luka→null; Executive `{2}`, Old Boys `{1,4}`. ⚠️ Production writes are classifier-blocked from an agent session; hand it over, don't attempt it.

---

## Task 8 — App code follows the schema

**Files:** `rosters.ts` · `players.ts` · `audit.ts` · score page · `roster-editor.tsx` · two `scripts/verify-*.mjs`

Driven entirely by Task 7's typecheck failures, plus two scripts typecheck will **not** name.

- [ ] **Step 1** — `rosters.ts`: delete `setDefaultGoalie` (720-757) and `setGoalieDay` (759-796) whole. In `movePlayerToTeam` (456-483) the departure update drops `is_default_goalie: false` and gains `night_of_week: null`; its `team_goalie_days` delete block goes. Same swap in `removeRosterPlayer`. In `updateRosterPlayer` the `leavingGoal` block (919-943) goes **entirely** — ⚠️ a night is a claim about *when* someone plays, not *what*, so moving F→D must **not** clear it — and its audit `old_data` swaps `is_default_goalie` for `night_of_week`.
- [ ] **Step 2** — `players.ts:406-441`: the merge's `team_goalie_days` collision handling goes. `audit.ts:116, 173`: drop `is_default_goalie`, carry `night_of_week`; `od.is_default_goalie` in pre-migration snapshots is simply ignored.
- [ ] **Step 3** — Score page: add `night_of_week` to the `team_players` select (106), delete the `team_goalie_days` query (118-122) and the `dayGoalie`/`defaultGoalie` lines (193-195), and call `suggestGoalie(goalies, gameDay)` — `gameDay` is the existing `leagueWeekday(game.scheduled_at)`.
- [ ] **Step 4** — `roster-editor.tsx`: delete the Goalie Schedule card (402-467), the Set Default form (333-357), and both imports.
- [ ] **Step 5** — ⛔ **Persist the nights when a schedule is generated — the step the whole feature hangs on.** `generateSchedule` already reads the weekday checkboxes into a `Set` at `schedule.ts:394`; write `game_nights: [...weekdays].sort()` onto the season in the same write that stores the draft. Without this the column is only ever the migration's backfill, and a season built after this ships records nothing.
- [ ] **Step 6** — Add `seasonNightsFor(seasonId)` to `src/lib/queries/season.ts`, `cache()`-wrapped like the other season lookups: return `season.game_nights` when non-empty, else `resolveSeasonNights([], <distinct weekdays of this season's published games>)`.
  ⚠️ **It must be season-scoped.** The team page's obvious source is `detail.games`, which is only *that team's* games — feeding those in would report the wrong nights for any team that does not play every night. After the backfill the query almost never runs.
- [ ] **Step 7** — ⚠️ **The two verification scripts typecheck cannot see:** `scripts/verify-roster-editing.mjs` and `scripts/verify-transfers.mjs` both read `is_default_goalie` / `team_goalie_days` and would break silently — they are plain `.mjs` and not in CI. Update both.
- [ ] **Step 8** — `npm run typecheck && npm test && npx eslint src e2e` — all green.
- [ ] **Step 9** — Commit: `refactor(roster): resolve the goalie from nights, not a default flag`

---

## Task 9 — The seed fixture

**Files:** `supabase/seed.sql` · `e2e/04-rosters.spec.ts:47` · `e2e/13-goalie.spec.ts`

⛔ **Without this every night test is green by omission.** Both seed leagues play a single weekday and every team has exactly one goalie, so nothing can exercise the night picker (it needs ≥2 nights) or the two-goalie resolution.

- [ ] **Step 1** — Make OBHL Spring 2026 genuinely two-night: change `v_l1_anchor + 28` → `+ 30` and `+ 35` → `+ 37`. That moves **rounds 4 and 5** (6 games) to Thursday. ✅ All six are `scheduled`, none finalized — the `if g.rnd <= 3` branch above them is untouched, so no result, stat or standing moves.
- [ ] **Step 2** — Set that season's `game_nights` to `'{2,4}'::smallint[]` in its `insert into seasons`.
- [ ] **Step 3** — Give **Sharks** a second goalie by **converting a position, not adding a player**. Sharks is `i = 1` (`team_names[1]`) and `n_players = 14`; the loop assigns `j = 1 -> 'G'`, `j <= 5 -> 'D'`, else `'F'`. Make `j = 8` a goalie for `i = 1` only. ✅ The roster stays **14**, so `04-rosters.spec.ts:47`'s count assertion needs no change; Sharks gets goalies at **#1 and #8**, which also exercises the lower-jersey tiebreak. Assign #1 `night_of_week = 2` and #8 `night_of_week = 4`.
- [ ] **Step 4** — Add a comment block saying the two-night shape and the second goalie are load-bearing for the night tests and must not be flattened back.
- [ ] **Step 5** — ⚠️ **Check what the fixture disturbs, here and not later.** The roster count is deliberately unchanged (Step 3), so `04-rosters.spec.ts:47` should still pass — confirm it does rather than assuming. Then check `13-goalie` for anything assuming Sharks has exactly one goalie, and `01-public` for anything reading OBHL's upcoming dates, which move two days.
- [ ] **Step 6** — `npm run db:reset`, then `scripts/e2e-locked.sh` over `04-rosters`, `13-goalie`, `01-public`.
- [ ] **Step 7** — Rewrite `13-goalie.spec.ts`'s roster half: lines 119-161 assert the Goalie Schedule card, which is gone. Replace with a **two-goalie team pre-selects by night** test and a **one-goalie team pre-selects its goalie** test. ⚠️ `13:99`'s `rosterRows(page).filter({ hasText: "Goalie" })` matches the position *cell*, which becomes a section heading in Task 10 — re-scope it then, not now.
- [ ] **Step 8** — Commit: `test(seed): a two-night league with two goalies on one team`

---

## Task 10 — The roster in three sections

**Files:** `team-roster-sections.tsx` (new) · `(public)/teams/[slug]/page.tsx` · `queries/teams.ts`

⚠️ **`getTeamBySlug` cannot serve this as written.** Its roster select is only `player_id, jersey_number, position, is_captain` + the name — no `night_of_week`. Add it to the select (`teams.ts:128`) and to `RosterEntry` (`teams.ts:14-21`). While there, add `opts: { client?: DbClient } = {}`, matching every other helper in that file — it is the only one without it, and that is why it has no unit test.

⚠️ **Zero-fill is load-bearing, not an edge case.** `v_goalie_stats` is built only from `status = 'final'` games; production has **0 final games**, so all 19 rostered goalies are absent from it today. Build the Goalies section from the **roster**, left-joined to the stats.

- [ ] **Step 1: Write the failing e2e** in `04-rosters.spec.ts`: on `/obhl/teams/sharks`, headings `Forwards`, `Defence`, `Goalies` are visible; the Goalies section lists both goalies **with zero final games in the fixture**; a `Night` column is present on OBHL (2 nights) and absent on Harbor (1 night).
- [ ] **Step 2** — Run → FAIL.
- [ ] **Step 3** — Build `TeamRosterSections`. Forwards/Defence: `# · Player · Night · GP · G · A · PTS · P·G · PIM`. Goalies: `# · Goalie · Night · GP · W · L · T · GA · SO · GAA · G · A · PTS`. Drop the `Pos` column — the heading says it. Sort each section **PTS desc, then jersey asc**. Night column only when `hasMultipleNights(nights)`, where `nights = await seasonNightsFor(ctx.season.id)` (Task 8 Step 6) — ⛔ **not** derived from `detail.games`, which holds only this team's games. A night outside `nights` renders `—`.
  ⚠️ Thirteen columns will not fit 390px: `W · L · T · SO · G · A` get `hidden sm:table-cell`, inside an `overflow-x-auto` container. `v_goalie_stats` has **no save-percentage column** — those columns are all of it.
- [ ] **Step 4** — Delete the standalone "Goaltending" block from the team page; it is now the Goalies section. ✅ Leave `GoalieStatsTable` alone — `/stats` still uses it.
- [ ] **Step 5** — Standardise on **Defence** in one shared constant: `team-player-table.tsx:13`, `roster-editor.tsx:30`, `players/[playerId]/page.tsx:30` (`duplicate-clusters.tsx:51` already says it). Update `04-rosters.spec.ts:133`'s `Defense: "D"`.
- [ ] **Step 6** — Extend the 390px loop in `02-auth.spec.ts:315` to visit a team page — this puts the widest table in the app on a page that guard never measured.
- [ ] **Step 7** — `scripts/e2e-locked.sh` over `04-rosters`, `01-public`, `02-auth`.
- [ ] **Step 8** — Commit: `feat(roster): show forwards, defence and goalies as sections`

---

## Task 11 — One dialog per player

**Files:** `player-edit-dialog.tsx` (new) · `roster-editor.tsx` · delete `edit-player-form.tsx`, `transfer-player-form.tsx`

⛔ **The dialog is a container, not a write path.** Every control keeps its existing action: `updateRosterPlayer` (number/position/**night**), `updatePlayerStatus`, `toggleCaptain`, `transferPlayer`, `updatePlayerName`. `updateRosterPlayer` gains `night_of_week` as one more field on the UPDATE it already does — not a sibling action.

⛔ **The rename keeps its own button and its own warning copy.** `edit-player-form.tsx:15-24` explains: jersey and position are this team's, the name is on `players`, which has no league. Folding them into one Save hides a cross-league write inside a routine one.

- [ ] **Step 1: Write the failing e2e** in `22-roster-editing.spec.ts` — open the dialog from a row, change the number, save, expect the row to show it. ⚠️ **A dialog renders in a portal, outside the `<tr>`** — scope to `page.getByRole("dialog")`, never `row.getByLabel(...)`.
- [ ] **Step 2** — Run → FAIL.
- [ ] **Step 3** — Build it on `components/ui/dialog` (the pattern `remove-controls.tsx` and `publish-controls.tsx` use), titled with the player's name, sectioned as the approved mockup: number/position/night → one Save; captain/rookie/suspended/injury; transfer; rename-everywhere with its paragraph. Night select only when `hasMultipleNights(nights)`; the editor is handed `nights` from the page's existing `seasonNightsFor()` call rather than making its own.
  ⚠️ **Convert the status toggles to `useActionState` + a transition.** They are plain `<form action={updatePlayerStatus}>` posts today, which is fine in a table cell; inside a Dialog the revalidation round-trip risks tearing down the open state. This is what `EditPlayerForm` already does for its two forms — follow it.
- [ ] **Step 4** — Reduce the editor row to `# · Player + badges · Position · Night · [Edit] [Remove]`, and give the editor the same three sections as Task 10.
- [ ] **Step 5** — Add `night_of_week` to the editor's roster select (`roster-editor.tsx:80`) and to `updateRosterPlayer`.
- [ ] **Step 6** — Rewrite the broken e2e — the largest mechanical cost in the plan, and shallow: every `row.getByRole("button", { name: "Remove"|"Make C"|"Suspend"|"Edit"|"Transfer" })`, `row.getByLabel("Number"|"First name"|/to team/i)` and `row.getByRole("status")` across `04-rosters`, `22-roster-editing` and `13-goalie` now resolves inside the dialog. Also fix `04-rosters.spec.ts:120-137`, which reads `td` by **hard-coded index** (`nth(1)` name, `nth(2)` position) — the Night column shifts both and position becomes a section heading.
- [ ] **Step 7** — `scripts/e2e-locked.sh` over `22-roster-editing`, `04-rosters`, `13-goalie`, `19-transfer`, `06-audit`, `16-league-membership`, `21-season-gating`.
- [ ] **Step 8** — Commit: `feat(roster): edit a player in one dialog`

---

## Verification

**Before calling the work done:**

```bash
npm run typecheck          # two passes: app + e2e
npm test                   # vitest; includes both convention guards
npx eslint src e2e
PORT=3101 scripts/e2e-locked.sh    # full suite, serialised
```

⚠️ **Run the schedule specs three times, not once** (`[[one-green-run-proves-nothing]]`): Phase S is wall-clock bounded, so `11-schedule-builder`, `29-schedule-repair` and `30-schedule-edits` are the ones that flake.

**Drive it in the browser** — the parts no test proves:

1. `/obhl/teams/sharks` as Manager — three sections, Night column, **both goalies listed despite zero final games**.
2. Open a player dialog at 1440px **and** 390px; assign a night; toggle Suspended and confirm **the dialog stays open**; confirm the row updates.
3. `/harbor/teams/<team>` — a one-night league shows **no** Night control anywhere.
4. Sharks' Tuesday and Thursday scoresheets pre-select **different** goalies.
5. `/obhl/schedule` as Manager — edit panel, cancelled restore, **Move a game night**, repair and one-off links.
6. Old `/obhl/schedule-builder/repair` 308s to `/obhl/schedule/repair`; bare `/obhl/schedule-builder` lands on season setup.

**Explicitly untouched — a diff here means something went wrong:** `applyGameWrites`, `publishSchedule`, the `0045`/`0046` RPCs, `assignNights.ts`, `GoalieStatsTable`.

**Then, separately:** hand over the production migration block from Task 7 Step 6. Do not run it from an agent session.

---

## Open risks

1. **Task 7 is the only irreversible step**, and the tree is red until Task 8 lands — accepted, so the migration can be reverted alone.
2. **Task 11's e2e churn is broad and shallow.** Budget re-verification time, not thinking time.
3. **Task 9 moves 6 OBHL games two days later.** No finalized game or stat moves, but any spec reading OBHL's upcoming dates shifts; the full suite is the check.
4. **`getTeamBySlug` gaining `opts.client`** touches a function with several callers — a widening with a default, so source-compatible, but typecheck is the arbiter.
