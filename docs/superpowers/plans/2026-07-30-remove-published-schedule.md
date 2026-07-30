# Remove a Published Schedule — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A season that has not started can have its published schedule deleted outright, and the `published` state tells a manager how to change the schedule instead of reading as a dead end.

**Architecture:** One new `security invoker` Postgres function, `remove_published_schedule`, gated on the existing `season_is_started` and carrying the same advisory-lock + `for update` discipline as `replace_published_schedule`. One new server action and one new client component beside the existing publish pair. No new `publishMode` state and no change to `getPublishState` — removal is available in exactly the modes that already mean "live games exist and the season has not started".

**Tech Stack:** Next.js 16.2.7 App Router, React 19.2.4 server actions + `useActionState`, Supabase/Postgres via PostgREST, vitest (unit), Playwright (e2e, `workers: 1`).

**Spec:** `docs/superpowers/specs/2026-07-30-remove-published-schedule-design.md`

## Global Constraints

- Migration number is **`0027`**, file `supabase/migrations/0027_remove_published_schedule.sql`. Never edit a migration after it has been applied — if a fix is needed after Task 2 is committed, add `0028`.
- `refused` values are exactly `'started'` and `'no_games'`, or SQL `null` on success. No other strings.
- The new function is revoked from `public, anon, authenticated` and granted to `service_role` only. The revoke is **required**, not redundant with omitting a grant: `CREATE FUNCTION` grants EXECUTE to `PUBLIC` by default.
- `perform 1 from games where season_id = p_season and not is_draft for update;` sits **above** the `season_is_started` gate. Do not remove it as redundant. No test catches its removal.
- `publishMode` gains no new state and `src/lib/schedule/publishMode.ts` is not modified.
- Removal is offered in **`published` mode only**. Not in `replace`: `remove_published_schedule` touches only `not is_draft`, so a draft would survive it, and the dialog's "no games until you generate and publish a new one" would be false in front of a manager who already has a draft. Replace is the operation for that case.
- The remove dialog states only what a pre-start removal actually costs. No games count and no calendar-feed line: removal is reachable only before the season starts, so nothing has been played and the games are regenerable from the form above. Lineups are the exception and the only genuinely unrecoverable loss.
- `getPublishState` in `src/lib/queries/schedule.ts` is not modified.
- Copy strings are used verbatim as written in the tasks below.
- Commit message prefixes follow the repo: `feat:` / `fix:` / `test:` / `docs:`. End every commit message with `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>`.
- Run `npm run lint` and `npx tsc --noEmit` before every commit. Both must be clean.

---

## File Structure

| Path | Responsibility |
|---|---|
| `supabase/migrations/0027_remove_published_schedule.sql` | **Create.** The `remove_published_schedule` function, its comment, its revoke/grant. |
| `src/lib/db/types.ts` | **Regenerate.** Adds the RPC's signature. Never hand-edited. |
| `src/lib/actions/schedule.ts` | **Modify.** Adds `RemoveState` and `removeSchedule`. Reuses the existing `revalidateAfterPublish`. |
| `src/components/manage/remove-controls.tsx` | **Create.** The Remove button and its confirm dialog. |
| `src/components/manage/schedule-builder-panel.tsx` | **Modify.** Published line renders in `replace` mode too; adds the guidance copy; mounts `RemoveControls` in `published` mode. |
| `e2e/11-schedule-builder.spec.ts` | **Modify.** Two assertions on the existing republish test, one new removal test. |
| `EXPORTS_HANDOFF.md` | **Modify.** §3 gains the removal paragraph; §6's stale deployment line is corrected; §7 gains two rows. |

---

## Task 1: Published-state copy and the persistent count

Pure UI, no database. Ships value on its own — this is the half that made the page read as a dead end.

**Files:**
- Modify: `src/components/manage/schedule-builder-panel.tsx:257-266`
- Test: `e2e/11-schedule-builder.spec.ts` (existing test at line 122)

**Interfaces:**
- Consumes: `publishMode` (unchanged), `publish.liveCount`, `publish.firstLiveDate`, `publish.lastLiveDate` — all already present.
- Produces: the published-count block, which renders in both `published` and `replace` mode, and inside it a `published`-only branch holding the guidance paragraph. Task 4 mounts `RemoveControls` into that inner branch, not the outer block.

- [ ] **Step 1: Write the failing assertions**

In `e2e/11-schedule-builder.spec.ts`, inside the existing test `"republishing replaces the schedule instead of stacking a second one"`, immediately after this existing line (currently line 142):

```ts
    await expect(page.getByText(`Published: ${published} games`)).toBeVisible();
```

add:

```ts
    // The published state has to say how to change the schedule. Without this
    // line the page is a count plus an empty state that says "Generate one
    // above to preview it here before publishing" — neither of which tells a
    // manager that generating a draft is the precondition for replacing.
    await expect(
      page.getByText(/To change the schedule, generate a new one above/),
    ).toBeVisible();
```

Then, immediately after this existing pair of assertions (currently lines 146-149):

```ts
    await expect(
      page.getByRole("button", { name: "Replace published schedule" }),
    ).toBeVisible();
    await expect(page.getByRole("button", { name: /Publish \d+ games/ })).toHaveCount(0);
```

add:

```ts
    // The live schedule stays visible in replace mode. It used to be suppressed
    // here, leaving the button label as the only evidence on the page that a
    // published schedule existed at all — on the screen that deletes it.
    await expect(page.getByText(`Published: ${published} games`)).toBeVisible();
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx playwright test e2e/11-schedule-builder.spec.ts -g "republishing replaces"`

Expected: FAIL. The first new assertion times out waiting for the guidance text, which does not exist yet.

- [ ] **Step 3: Change the panel**

In `src/components/manage/schedule-builder-panel.tsx`, replace this block (currently lines 257-266):

```tsx
          {mode === "published" ? (
            <p className="text-muted-foreground text-sm">
              <span className="text-foreground font-medium">
                Published: {publish.liveCount} games
              </span>
              {publish.firstLiveDate && publish.lastLiveDate
                ? ` · ${formatLongDate(publish.firstLiveDate)} → ${formatLongDate(publish.lastLiveDate)}`
                : ""}
            </p>
          ) : null}
```

with:

```tsx
          {/*
            Rendered in replace mode too, not just published. A manager about to
            replace a schedule needs the schedule they are replacing on the page;
            suppressing it here left the button label as the only evidence it
            existed. A container rather than a bare paragraph because this block
            holds everything about the live schedule — the count, the guidance,
            and the control that removes it.
          */}
          {mode === "published" || mode === "replace" ? (
            <div className="text-muted-foreground space-y-2 text-sm">
              <p>
                <span className="text-foreground font-medium">
                  Published: {publish.liveCount} games
                </span>
                {publish.firstLiveDate && publish.lastLiveDate
                  ? ` · ${formatLongDate(publish.firstLiveDate)} → ${formatLongDate(publish.lastLiveDate)}`
                  : ""}
              </p>
              {/*
                Only in published mode. In replace mode a draft already exists
                and the Replace button is on screen, so telling the manager to
                generate one would describe a step they have already taken.
              */}
              {mode === "published" ? (
                <p>
                  To change the schedule, generate a new one above — you&apos;ll
                  be asked to confirm before it replaces this one.
                </p>
              ) : null}
            </div>
          ) : null}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx playwright test e2e/11-schedule-builder.spec.ts`

Expected: PASS, 10/10 tests in the file.

- [ ] **Step 5: Verify the whole suite and commit**

```bash
npx tsc --noEmit && npm run lint && npm run test
git add src/components/manage/schedule-builder-panel.tsx e2e/11-schedule-builder.spec.ts
git commit -F - <<'EOF'
feat: tell managers how to change a published schedule

The published state rendered a count and an empty state reading "Generate
one above to preview it here before publishing", neither of which says that
generating a draft is what unlocks replacing. The page read as a dead end to
a manager holding a schedule they wanted rid of.

The count now also survives into replace mode, where it was suppressed —
leaving the button label as the only on-page evidence of the schedule about
to be deleted.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
```

---

## Task 2: The `remove_published_schedule` function

**Files:**
- Create: `supabase/migrations/0027_remove_published_schedule.sql`
- Modify: `src/lib/db/types.ts` (regenerated, never hand-edited)

**Interfaces:**
- Consumes: `public.season_is_started(uuid)` from `0026`.
- Produces: `remove_published_schedule(p_season uuid) returns table (deleted int, refused text)`. Task 3 calls it as `admin.rpc("remove_published_schedule", { p_season: seasonId })` and reads `data[0].deleted` (number) and `data[0].refused` (typed `string` — `gen-types` cannot infer nullability for `returns table(...)`, so compare against the literals and never null-check).

- [ ] **Step 1: Write the migration**

Create `supabase/migrations/0027_remove_published_schedule.sql`:

```sql
-- Remove a season's published schedule, leaving it with no games.
--
-- 0026's replace_published_schedule can only delete a live schedule when a draft
-- is standing ready to take its place. is_draft is one-way and every other
-- delete against games in the app is filtered is_draft = true, so a season whose
-- published schedule was simply wrong could be overwritten but never emptied.
--
-- Same gate as the replace, deliberately: protecting played games stays a
-- consequence of "a started season refuses" rather than a rule this function
-- applies, so no code here walks a set of games deciding which to keep.
create or replace function public.remove_published_schedule(p_season uuid)
returns table (deleted int, refused text)
language plpgsql security invoker set search_path = public as $$
declare
  v_deleted int := 0;
begin
  -- Same key as replace_published_schedule, so a remove and a replace on one
  -- season cannot interleave. Released at commit.
  perform pg_advisory_xact_lock(hashtext(p_season::text));

  -- Lock the rows the delete will remove, BEFORE the gate reads them.
  --
  -- Not redundant just because nothing is promoted afterwards — the hazard is in
  -- the gate, not the promotion. Under READ COMMITTED the gate and the delete are
  -- separate statements with separate snapshots, so without this lock a
  -- scorekeeper committing status='final' between them is invisible to the gate
  -- and fatal to the game: the gate reads the pre-finalize snapshot and returns
  -- false, the delete then blocks on the scorekeeper's row lock and on waking
  -- re-evaluates its WHERE against the NEW row version, which still matches
  -- `season_id = ? and not is_draft`. The finalized game is deleted, game_rosters
  -- cascades with it, and the call reports a clean success. 0026 carries the full
  -- reproduction; it was found by review, not by a test, and no test catches its
  -- removal here either.
  perform 1 from games where season_id = p_season and not is_draft for update;

  -- Evaluated inside the transaction, like 0026's. The rule is time-based, so a
  -- check in TypeScript followed by a separate write would let a game 30 seconds
  -- from its start time tick past while the removal is in flight.
  if season_is_started(p_season) then
    return query select 0, 'started'::text;
    return;
  end if;

  -- Nothing live. Reported rather than silently succeeding, so a stale tab's
  -- second submit does not come back as "removed 0 games" and read as a success.
  if not exists (select 1 from games where season_id = p_season and not is_draft) then
    return query select 0, 'no_games'::text;
    return;
  end if;

  delete from games where season_id = p_season and not is_draft;
  get diagnostics v_deleted = row_count;

  return query select v_deleted, null::text;
end;
$$;

comment on function public.remove_published_schedule(uuid) is
  'Delete a season''s published schedule, leaving it with no games. Refuses once the season has started.';

-- service_role only, stated in both directions.
--
-- Reached exclusively through createAdminClient() (removeSchedule in
-- src/lib/actions/schedule.ts). The revoke is not redundant with omitting a
-- grant: CREATE FUNCTION grants EXECUTE to PUBLIC by default, so an un-revoked
-- function is a one-call "delete this season's published schedule" through
-- PostgREST for any authenticated user. See 0026's grant block for the full
-- reasoning, including why 0025's `authenticated` grant is not the pattern to
-- copy here.
revoke execute on function public.remove_published_schedule(uuid) from public, anon, authenticated;
grant execute on function public.remove_published_schedule(uuid) to service_role;
```

- [ ] **Step 2: Apply it and regenerate types**

```bash
npm run db:reset
npm run gen-types
```

Expected: reset completes, and `git diff src/lib/db/types.ts` shows `remove_published_schedule` added to the `Functions` block with `Args: { p_season: string }` and `Returns: { deleted: number; refused: string }[]`.

- [ ] **Step 3: Verify the happy path by hand**

There is no DB-level test harness in this repo, so this is the only verification the gate gets. Run:

```bash
export PATH="/opt/homebrew/opt/postgresql@16/bin:$PATH"
DB="postgresql://postgres:postgres@127.0.0.1:54322/postgres"

# Fall 2026 is the seeded season that has not started, and has no games.
psql "$DB" -X -c "select id from seasons where name = 'Fall 2026';"
```

Take that id, then confirm the two refusal paths and the delete:

```bash
# No games yet -> no_games
psql "$DB" -X -c "select * from remove_published_schedule('<fall-2026-id>');"
# expect: deleted=0, refused=no_games

# Spring 2026 is seeded in the past, so it has started -> started
psql "$DB" -X -c "select * from remove_published_schedule((select id from seasons where name = 'Spring 2026'));"
# expect: deleted=0, refused=started, and the season still has its games:
psql "$DB" -X -c "select count(*) from games where season_id = (select id from seasons where name = 'Spring 2026') and not is_draft;"
```

Expected: `no_games` for Fall 2026, `started` for Spring 2026, and Spring 2026's game count unchanged.

- [ ] **Step 4: Verify the `for update` line by hand**

This is the step that catches the defect no test can. Two `psql` sessions against a season that has **not** started. Use Spring 2026's game rows only as a shape reference — you need an unstarted season with live games, so first give Fall 2026 one:

```bash
psql "$DB" -X -c "
  insert into games (season_id, home_team_id, away_team_id, scheduled_at, is_draft, status)
  select s.id, t1.id, t2.id, now() + interval '30 days', false, 'scheduled'
    from seasons s,
         lateral (select id from teams order by name limit 1) t1,
         lateral (select id from teams order by name offset 1 limit 1) t2
   where s.name = 'Fall 2026';"
```

Session A:

```sql
begin;
update games set status = 'final', home_goals = 3, away_goals = 1
 where season_id = (select id from seasons where name = 'Fall 2026') and not is_draft;
-- do NOT commit yet
```

Session B:

```sql
select * from remove_published_schedule((select id from seasons where name = 'Fall 2026'));
```

Expected: **session B blocks.** It must not return.

Session A: `commit;`

Expected: session B then returns `deleted = 0, refused = started`, and the finalized game still exists:

```sql
select id, status, home_goals from games
 where season_id = (select id from seasons where name = 'Fall 2026') and not is_draft;
```

Without the `for update` line, session B returns immediately with `deleted = 1, refused = null` and the finalized game is gone. That difference is the entire purpose of the line.

- [ ] **Step 5: Reset the fixture**

Not optional and not cosmetic. Step 4 inserted a live game into `Fall 2026` — the same season Task 5's e2e drives. Left in place it shifts every count that test asserts, and the failure will present as a bug in the feature rather than as leftover state.

```bash
npm run db:reset
psql "postgresql://postgres:postgres@127.0.0.1:54322/postgres" -X -c \
  "select count(*) from games where season_id = (select id from seasons where name = 'Fall 2026');"
```

Expected: `0`.

- [ ] **Step 6: Commit**

```bash
npx tsc --noEmit && npm run lint
git add supabase/migrations/0027_remove_published_schedule.sql src/lib/db/types.ts
git commit -F - <<'EOF'
feat: add the remove-published-schedule database function

Deletes a season's live games with no draft standing by to replace them,
which replace_published_schedule cannot do. Same season_is_started gate, so
played games stay protected by the gate rather than by a predicate this
function has to get right.

Carries 0026's advisory lock and its `for update` above the gate. That line
is load-bearing for the same reason and in the same way, and no test catches
its removal — see the hand-verification recipe in the spec's section 6.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
```

---

## Task 3: The `removeSchedule` server action

**Files:**
- Modify: `src/lib/actions/schedule.ts` (append after `publishSchedule`, which ends at line 274)

**Interfaces:**
- Consumes: `remove_published_schedule` from Task 2; the existing `requireManager`, `createAdminClient`, `targetSeason`, `logAudit`, and `revalidateAfterPublish` — all already in this file.
- Produces: `export type RemoveState = { ok: boolean; message: string } | null` and `export async function removeSchedule(prev: RemoveState, formData: FormData): Promise<RemoveState>`. Task 4 passes it to `useActionState<RemoveState, FormData>` and reads `season_id` from a hidden input.

**No unit test.** This action is I/O end to end — auth, one RPC call, revalidation — with no pure logic to isolate, exactly like `publishSchedule` beside it, which is also untested at the unit level. Its behaviour is covered by the e2e in Task 5. Do not invent a test that mocks the Supabase client to assert the mock was called; that asserts the test's own wiring.

- [ ] **Step 1: Add the action**

Append to `src/lib/actions/schedule.ts`:

```ts
export type RemoveState = { ok: boolean; message: string } | null;

/**
 * Delete a season's published schedule, leaving it with no games.
 *
 * The counterpart to `publishSchedule` rather than a variant of it: replacing
 * needs a draft standing ready, and this exists for the case where there is
 * nothing to put in the old schedule's place.
 *
 * Refusals are ordinary outcomes of a stale page, not faults: the season may
 * have started since the tab was opened, or another tab may already have
 * removed the schedule. Both come back as a message, and both revalidate —
 * a refusal means this tab's view is already wrong.
 */
export async function removeSchedule(
  _prev: RemoveState,
  formData: FormData,
): Promise<RemoveState> {
  const user = await requireManager();
  const admin = createAdminClient();
  const seasonId = await targetSeason(admin, String(formData.get("season_id") ?? ""));
  if (!seasonId) return { ok: false, message: "No season selected." };

  const { data, error } = await admin.rpc("remove_published_schedule", {
    p_season: seasonId,
  });
  if (error) return { ok: false, message: error.message };

  const row = data?.[0];
  if (!row) return { ok: false, message: "Nothing happened — try again." };

  if (row.refused === "started") {
    revalidateAfterPublish(seasonId);
    return {
      ok: false,
      message: "The season is under way — the schedule can no longer be removed.",
    };
  }
  if (row.refused === "no_games") {
    revalidateAfterPublish(seasonId);
    return { ok: false, message: "There's no published schedule to remove." };
  }

  // Audited unconditionally. publishSchedule exempts a first publish because it
  // destroys nothing; every successful removal destroys live games, so there is
  // no equivalent cheap case here.
  void logAudit({
    user_id: user.id,
    action: "remove_schedule",
    entity_type: "season",
    entity_id: seasonId,
    old_data: { published_games: row.deleted },
    new_data: { published_games: 0 },
  });

  revalidateAfterPublish(seasonId);

  return {
    ok: true,
    message: `Removed the published schedule — ${row.deleted} games deleted.`,
  };
}
```

- [ ] **Step 2: Verify it typechecks against the generated types**

Run: `npx tsc --noEmit`

Expected: clean. A failure naming `remove_published_schedule` means Task 2's `npm run gen-types` did not run — re-run it.

- [ ] **Step 3: Verify nothing regressed and commit**

```bash
npm run lint && npm run test
git add src/lib/actions/schedule.ts
git commit -F - <<'EOF'
feat: add the removeSchedule action

Wraps remove_published_schedule with the same shape publishSchedule uses:
refusals map to manager-facing messages rather than errors, and revalidate
too, since a refusal means the tab is already stale.

Audited unconditionally — publishSchedule exempts a first publish because it
destroys nothing, and removal has no equivalent case.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
```

---

## Task 4: The `RemoveControls` component and its mount

**Files:**
- Create: `src/components/manage/remove-controls.tsx`
- Modify: `src/components/manage/schedule-builder-panel.tsx`

**Interfaces:**
- Consumes: `removeSchedule` and `RemoveState` from Task 3; the published-count block from Task 1.
- Produces: `RemoveControls({ seasonId, lineupsAtRisk })`. Task 5's e2e drives it by the button name `"Remove published schedule"` and the dialog confirm button named exactly `"Remove"`.

- [ ] **Step 1: Create the component**

Create `src/components/manage/remove-controls.tsx`:

```tsx
"use client";

import { useActionState, useEffect, useState } from "react";
import { toast } from "sonner";
import { removeSchedule, type RemoveState } from "@/lib/actions/schedule";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

/**
 * Delete the published schedule outright, leaving the season with no games.
 *
 * Separate from PublishControls rather than a third branch inside it: that
 * component already forks on `destructive` between two quite different renders,
 * and this action publishes nothing. One component answering two unrelated
 * questions is how that fork got hard to read in the first place.
 *
 * The panel renders this only in "published" mode — live games, no draft, season
 * not started. Deliberately not in "replace": the RPC touches only
 * `not is_draft`, so a draft survives a removal, and the dialog below would be
 * telling a manager who already has one that the season has no games until they
 * generate another. Replace is the operation for that case.
 *
 * The dialog is short on purpose. Removal is reachable only before the season
 * starts, so no game has been played, no result exists, and the games are
 * regenerable from the form above — a games count and a calendar-feed warning
 * would be borrowed ceremony describing a cost that isn't paid. Lineups are the
 * exception: `game_rosters` cascades on game delete, and a captain's lineup does
 * not come back when the schedule is regenerated. That is the one line worth a
 * manager's attention, so it is the only detail here.
 */
export function RemoveControls({
  seasonId,
  lineupsAtRisk,
}: {
  seasonId: string;
  lineupsAtRisk: number;
}) {
  const [open, setOpen] = useState(false);
  const [state, action, pending] = useActionState<RemoveState, FormData>(
    removeSchedule,
    null,
  );

  useEffect(() => {
    if (!state) return;
    if (state.ok) toast.success(state.message);
    else toast.error(state.message);
  }, [state]);

  // Same derivation as PublishControls, and the same load-bearing precondition:
  // `open` is never reset to false on success, so this is correct only while the
  // component is guaranteed to unmount afterwards. It is — a successful removal
  // drops liveCount to 0, which moves the season to "empty" or "draft-only", and
  // the panel renders this control in neither. The caller keys on liveCount so
  // that stays true even if the mode boundaries move later. Read the longer
  // comment on `dialogOpen` in publish-controls.tsx before changing either.
  const dialogOpen = open && !state?.ok;

  return (
    <>
      <Button variant="outline" onClick={() => setOpen(true)}>
        Remove published schedule
      </Button>
      <Dialog open={dialogOpen} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Remove the published schedule?</DialogTitle>
            <DialogDescription asChild>
              <div className="space-y-2">
                <p>
                  The season will have no games until you generate and publish a
                  new one.
                </p>
                {lineupsAtRisk > 0 ? (
                  <p>
                    {lineupsAtRisk} lineup entries captains have already set will
                    be deleted. The games can be regenerated; those cannot.
                  </p>
                ) : null}
              </div>
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <form action={action}>
              <input type="hidden" name="season_id" value={seasonId} />
              <Button type="submit" variant="destructive" disabled={pending}>
                {pending ? "Removing…" : "Remove"}
              </Button>
            </form>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
```

- [ ] **Step 2: Mount `RemoveControls`**

Add the import beside the existing `PublishControls` import:

```tsx
import { RemoveControls } from "@/components/manage/remove-controls";
```

Then, inside the block Task 1 created, still inside the `<div className="text-muted-foreground space-y-2 text-sm">`, fold the control into the **same** `published`-only branch that holds the guidance paragraph. Replace this, from Task 1:

```tsx
              {mode === "published" ? (
                <p>
                  To change the schedule, generate a new one above — you&apos;ll
                  be asked to confirm before it replaces this one.
                </p>
              ) : null}
```

with:

```tsx
              {mode === "published" ? (
                <>
                  <p>
                    To change the schedule, generate a new one above — you&apos;ll
                    be asked to confirm before it replaces this one.
                  </p>
                  {/*
                    Published mode only, sharing the guidance's branch: both
                    speak to a season holding a live schedule and no draft. In
                    replace mode the manager already has a replacement, and the
                    remove dialog's wording would be wrong there — see the
                    component's own comment.

                    Keyed on liveCount so the derived dialog-open state in
                    RemoveControls stays correct by construction: a successful
                    removal takes liveCount to 0, remounting under a fresh key.
                  */}
                  <RemoveControls
                    key={publish.liveCount}
                    seasonId={seasonId}
                    lineupsAtRisk={publish.lineupsAtRisk}
                  />
                </>
              ) : null}
```

- [ ] **Step 3: Verify it renders and nothing regressed**

```bash
npx tsc --noEmit && npm run lint && npm run test
npx playwright test e2e/11-schedule-builder.spec.ts
```

Expected: all clean, 10/10 e2e in the file. The removal path itself is not yet covered — Task 5 adds that.

- [ ] **Step 4: Commit**

```bash
git add src/components/manage/remove-controls.tsx src/components/manage/schedule-builder-panel.tsx
git commit -F - <<'EOF'
feat: let a manager remove a published schedule

A season whose published schedule was wrong could be overwritten but never
emptied. The Remove control sits beside the published count, in the published
state only — replace already has a replacement, and a draft survives the RPC.

The dialog says only what a pre-start removal costs. Nothing has been played
and the games regenerate from the form above, so a count and a calendar
warning would be ceremony; captains' lineups cascade and do not come back,
so that is the line the dialog carries.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
```

---

## Task 5: End-to-end coverage of the removal

**Files:**
- Modify: `e2e/11-schedule-builder.spec.ts`

**Interfaces:**
- Consumes: everything from Tasks 1–4. Drives the UI only.
- Produces: nothing consumed by later tasks.

- [ ] **Step 1: Write the failing test**

Add as the last test inside the `test.describe("Path 17 — Schedule Builder", ...)` block, after `"a started season locks the builder"`:

```ts
  test("removing a published schedule leaves the season with no games", async ({
    page,
  }) => {
    // Order-independent on purpose. Playwright runs this file with workers: 1,
    // so the republish test above normally leaves Fall 2026 already published
    // and this branch does not run — but the test then still works under
    // `-g` in isolation, or if the tests above are reordered.
    const removeButton = page.getByRole("button", {
      name: "Remove published schedule",
    });
    if ((await removeButton.count()) === 0) {
      await page.getByLabel("First game night").fill("2026-09-15");
      await page.getByLabel("Games per team").fill("4");
      await page.locator('label:has-text("Tue") input[name="weekdays"]').check();
      await page.locator('label:has-text("Thu") input[name="weekdays"]').check();
      await page.getByRole("button", { name: "Generate schedule" }).click();
      await page.getByRole("button", { name: /Publish \d+ games/ }).click();
    }

    await expect(removeButton).toBeVisible();

    await removeButton.click();
    await expect(page.getByText("Remove the published schedule?")).toBeVisible();
    // Asserted by shape. The dialog deliberately carries no game count — a
    // pre-start removal destroys nothing that can't be regenerated — so there
    // is no number here to pin the test to.
    await expect(
      page.getByText(/The season will have no games until you generate/),
    ).toBeVisible();
    // `exact` matters: without it this also matches the "Remove published
    // schedule" trigger behind the dialog.
    await page.getByRole("button", { name: "Remove", exact: true }).click();

    // Back to zero. All three assertions are needed: the count going away shows
    // the games are gone, the control going away shows the mode moved, and the
    // empty state shows the panel recovered rather than rendering nothing.
    await expect(page.getByText(/Published: \d+ games/)).toHaveCount(0);
    await expect(removeButton).toHaveCount(0);
    await expect(page.getByText("No draft schedule")).toBeVisible();
  });
```

- [ ] **Step 2: Run it against a clean database to verify it passes**

```bash
npm run db:reset
npx playwright test e2e/11-schedule-builder.spec.ts
```

Expected: PASS, 11/11 in the file.

- [ ] **Step 3: Verify the test discriminates**

A test that passes whether or not the feature works is worse than no test. Temporarily append `and false` to the delete's WHERE clause in `supabase/migrations/0027_remove_published_schedule.sql`, so it reads:

```sql
  delete from games where season_id = p_season and not is_draft and false;
```

Mutate it this way rather than commenting the statement out: `get diagnostics v_deleted = row_count` on the next line reads the row count of whatever DML ran last, so deleting the statement entirely leaves that reading a non-DML result and the function's behaviour becomes murky rather than wrong-in-a-known-way. With `and false` the delete still runs, matches nothing, and the RPC returns a clean `deleted = 0, refused = null` — the exact shape a silently broken delete would produce.

Then:

```bash
npm run db:reset
npx playwright test e2e/11-schedule-builder.spec.ts -g "removing a published schedule"
```

Expected: **FAIL** — `Published: N games` is still on the page after the removal, so the `toHaveCount(0)` assertion fails.

Remove the `and false`, `npm run db:reset`, and confirm it passes again. Verify with `git diff supabase/migrations/0027_remove_published_schedule.sql` that the file is back to its committed state before moving on — a stray `and false` left in a migration would ship a remove button that removes nothing.

- [ ] **Step 4: Run the full suite and commit**

```bash
npm run db:reset
npm run test && npx playwright test
```

Expected: unit 177/177; e2e 66 passed / 1 skipped / 0 failed. The skip is a pre-existing `ANTHROPIC_API_KEY` gate. The baseline before this plan was 65 passed, so exactly one new test.

```bash
git add e2e/11-schedule-builder.spec.ts
git commit -F - <<'EOF'
test: cover removing a published schedule

Drives generate, publish, remove, and asserts the season is back to zero by
three independent signals. Verified to fail when the migration's delete is
removed, so it discriminates rather than passing vacuously.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
```

---

## Task 6: Record the decisions in the handoff

**Files:**
- Modify: `EXPORTS_HANDOFF.md` §3, §6, §7

**Interfaces:**
- Consumes: the shipped behaviour from Tasks 1–5.
- Produces: nothing.

- [ ] **Step 1: Add the removal paragraphs to §3**

In `EXPORTS_HANDOFF.md`, immediately after the paragraph ending `...Reachable only before the season starts, and the confirm dialog says so.`, insert:

```markdown
**Removing is the same gate without the promotion.** `removeSchedule` calls
`remove_published_schedule`, which deletes the season's live games and leaves it
empty. It carries 0026's advisory lock and its `for update` above the gate, and
that line is needed here for exactly the same reason — the hazard is in the gate
reading a stale snapshot, not in the promotion that follows it. Don't drop it on
the grounds that this function promotes nothing.

**Why there is no bulk cancel for a started season.** It was designed and
deliberately not built; the spec
(`docs/superpowers/specs/2026-07-30-remove-published-schedule-design.md` §5)
carries the predicate and the reasoning. The short version: schedule work
happens before a season begins, mid-season change is individual games and is
itself rare, and the fallback is cancelling them from the score pages — already
possible, already reversible. Leaving it unbuilt is what keeps the played-game
guarantee above structural: nothing selects which live games to delete.
```

- [ ] **Step 2: Correct the stale deployment line in §6**

Replace this paragraph:

```markdown
**Deployment state at time of writing.** `main` and the hosted database
(`bipxqfszjwncjquymhon`) both have migration `0025`. Whether the Vercel app had
picked up `main` was not confirmed — there is no CI workflow or `vercel.json` in
the repo, so the deploy trigger is unknown. Schema-ahead-of-code is harmless in
this direction (the column is simply unused), but postponement won't clear dates
until the app is running `7275303` or later.
```

with:

```markdown
**Deployment state.** The hosted database (`bipxqfszjwncjquymhon`) has `0026`;
`main` does not yet have the code that calls it. There is no CI workflow or
`vercel.json` in the repo, so the deploy trigger is unknown. Schema-ahead-of-code
is the correct direction here and is harmless — the functions are simply
uncalled. The reverse is not: `getPublishState` fails closed on an RPC error, so
code that ships ahead of its migration locks the builder for every manager. A PR
preview did exactly that, which is how the ordering got established. Apply
migrations first, then merge.
```

- [ ] **Step 3: Add the new files to the §7 table**

Insert after the `publish-controls.tsx` row:

```markdown
| `src/components/manage/remove-controls.tsx` | remove, and its confirm dialog |
```

and after the `0026_replace_published_schedule.sql` row:

```markdown
| `supabase/migrations/0027_remove_published_schedule.sql` | `remove_published_schedule` |
| `docs/superpowers/specs/2026-07-30-remove-published-schedule-design.md` | removal design; §5 is the unbuilt bulk cancel |
```

- [ ] **Step 4: Commit**

```bash
git add EXPORTS_HANDOFF.md
git commit -F - <<'EOF'
docs: record removal, and why there is no bulk cancel

The `for update` line needs its own note in the removal function, because the
obvious reading — no promotion, so no race — is wrong. Also corrects the
deployment-state paragraph, which still claimed 0025 on both sides, and
records the ordering rule a PR preview established the hard way.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
```

---

## Self-Review

**Spec coverage.** Every section maps to a task: §1 gate → Task 2; §2 RPC → Task 2; §3 actions, and `getPublishState` untouched → Task 3; §4 UI, separate component, the `key`, discoverability copy → Tasks 1 and 4; §5 unbuilt bulk cancel → Task 6 Step 1 (recorded, not built); §6 verification → Task 2 Steps 3-4 and Task 5; §7 deployment → Task 6 Step 2. No gaps.

**Two deliberate departures from the spec**, both decided during plan refinement and both narrowing it:

- **Spec §4 offers removal in `published` and `replace`; this plan offers it in `published` only.** The RPC touches only `not is_draft`, so a draft survives a removal — the spec's own dialog copy ("leaves the season with no schedule") would have been false in replace mode. It also matches §3's justification, that removal exists "for the case where there is nothing to put in the old schedule's place." A manager holding a draft who wants an empty season has Discard draft → Remove.
- **The dialog is shorter than spec §4's draft.** No games count, no calendar-feed line. Removal is gated to before the season starts, so nothing has been played and the games regenerate from the form directly above. Only the cascading lineups survive as a real cost, and they now lead the dialog instead of trailing it.

**Placeholders.** None. Every code step carries the literal code; every verification step carries the command and its expected output.

**Type consistency.** `RemoveState` is defined in Task 3 and consumed by name in Task 4. `removeSchedule`'s signature `(prev: RemoveState, formData: FormData) => Promise<RemoveState>` matches `useActionState<RemoveState, FormData>`. The RPC name `remove_published_schedule` and its `deleted` / `refused` fields are identical in Tasks 2 and 3. `RemoveControls`' two props — `seasonId: string`, `lineupsAtRisk: number` — are declared in Task 4 Step 1 and passed in Task 4 Step 2 with the same names.

**Checked against the live schema while refining**, so the implementer does not discover these mid-task: `games` has exactly three NOT NULL columns without defaults (`season_id`, `home_team_id`, `away_team_id`), all supplied by Task 2 Step 4's insert, which also satisfies `games_distinct_teams`; and `audit_log.action` is free `text` with no check constraint, so `remove_schedule` needs no migration of its own.

**Two things worth a reviewer's attention.**

- Task 5 Step 3 asks the implementer to deliberately break the migration to prove the test discriminates, then restore it. If that step is skipped, the branch ships a test nobody has confirmed can fail. It is the same class of check that caught a vacuous assertion on the previous branch.
- Task 2 Step 4's two-session `psql` check is the only verification the `for update` line ever gets. Deleting that line leaves every automated test in the repo green.
