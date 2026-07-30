# One Published Schedule Per Season — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make publishing a schedule *replace* the season's existing published schedule, and refuse entirely once the season has started, so a season can never hold two live schedules and a played game can never be deleted.

**Architecture:** A season has no `schedules` table — a schedule is `games` rows with `is_draft`. The invariant is enforced by one Postgres function that deletes the live games and promotes the drafts inside a single transaction, gated by a second function defining "has the season started". The UI reads that same gate so it can render a locked state instead of a generate form.

**Tech Stack:** Next.js 16.2.7 (App Router, server actions), React 19.2.4, Supabase (Postgres + PostgREST), TypeScript, vitest (unit), Playwright (e2e), Tailwind + shadcn/radix primitives.

**Spec:** `docs/superpowers/specs/2026-07-30-one-published-schedule-design.md`

## Global Constraints

- **This is not the Next.js in your training data.** Read the relevant guide in `node_modules/next/dist/docs/` before writing App Router or server-action code. Heed deprecation notices.
- **Read `SCHEDULE_HANDOFF.md` before touching the generator, and `EXPORTS_HANDOFF.md` §4 before touching postponement or the one-off planner.** This plan touches neither's internals, but it modifies `src/lib/queries/schedule.ts`, which `EXPORTS_HANDOFF.md` calls "the single read path".
- **Migrations are sequential and immutable once shipped.** The next number is `0026`. `main` and the hosted database both carry `0025`.
- **Query helpers in `src/lib/queries/` take options as an object whose `client` defaults to the RLS client.** Manager-gated callers pass `createAdminClient()`. This rule is documented at the top of `src/lib/queries/schedule.ts`; follow it.
- **Commands:** `npm test` (vitest), `npm run test:e2e` (Playwright — its global setup runs `npm run db:reset` and reseeds), `npm run lint`, `npm run gen-types` (regenerates `src/lib/db/types.ts` from the local DB), `npm run db:reset`.
- **Local Postgres:** `postgresql://postgres:postgres@127.0.0.1:54322/postgres` (port from `supabase/config.toml`).
- **Today's date for fixture purposes is 2026-07-30.** The seeded active season (`Spring 2026`, 2026-05-12 → 2026-06-30) is therefore in the past and counts as *started*. This is load-bearing for Tasks 5 and 7.

---

## File Structure

| Path | Responsibility |
|---|---|
| `supabase/migrations/0026_replace_published_schedule.sql` | **Create.** `season_is_started` (the rule) and `replace_published_schedule` (the transaction). |
| `src/lib/db/types.ts` | **Regenerate.** Picks up the two new RPC signatures. Never hand-edit. |
| `src/lib/schedule/publishMode.ts` | **Create.** Pure state→mode decision. No I/O. |
| `src/lib/schedule/publishMode.test.ts` | **Create.** vitest for the above. |
| `src/lib/queries/schedule.ts` | **Modify.** Add `getPublishState`. |
| `src/lib/actions/schedule.ts` | **Modify.** `publishSchedule` calls the RPC and returns a state; `generateSchedule` refuses on a started season. |
| `src/components/manage/publish-controls.tsx` | **Create.** Client component: publish button, replace button + confirm dialog, toast. |
| `src/components/manage/schedule-builder-panel.tsx` | **Modify.** Read publish state, render one of five modes. |
| `supabase/seed.sql` | **Modify.** Add a not-yet-started season so fixtures cover both sides of the rule. |
| `e2e/11-schedule-builder.spec.ts` | **Modify.** Retarget generator tests at the not-started season; add lock and replace coverage. |

---

### Task 1: The migration and the two functions

**Files:**
- Create: `supabase/migrations/0026_replace_published_schedule.sql`
- Modify: `src/lib/db/types.ts` (via `npm run gen-types` — do not hand-edit)

**Interfaces:**
- Consumes: nothing.
- Produces: two RPCs callable as `supabase.rpc(...)`:
  - `season_is_started(p_season: string) → boolean`
  - `replace_published_schedule(p_season: string) → { deleted: number; published: number; refused: string | null }[]`

SQL is not covered by the vitest suite, which only picks up `src/**/*.test.ts`. Verification here is a scripted set of psql assertions, run against a fresh reset. Do not claim this task passes without pasting the actual output.

- [ ] **Step 1: Write the migration**

Create `supabase/migrations/0026_replace_published_schedule.sql`:

```sql
-- A season may have at most one published schedule.
--
-- Publishing was a bulk flip of is_draft, and generation deleted only drafts, so
-- nothing stopped a second generate+publish from leaving the season holding two
-- complete overlapping schedules — both live in the schedule page, both .ics
-- feeds, the CSV, and standings.
--
-- Publishing now replaces: the season's live games are deleted and the drafts
-- take their place, in one transaction. Once the season has started it refuses
-- outright, which is also the entire protection for played games — see below.

-- The rule, defined once. Three consumers: the gate in
-- replace_published_schedule, generateSchedule's early return, and the builder
-- UI. A second copy of this predicate in TypeScript would be free to drift.
--
-- Each predicate covers the others' blind spot:
--   scheduled_at < now()   a night has passed. The load-bearing one: a game
--                          played last night that nobody has scored yet is
--                          still a played game.
--   status <> 'scheduled'  someone acted on it. Catches a game finalized early
--                          with a future date, and a postponed game, whose
--                          scheduled_at is null and so invisible to the first.
--   goals > 0              a score exists. Both columns are not null default 0.
create or replace function public.season_is_started(p_season uuid)
returns boolean language sql stable security invoker set search_path = public as $$
  select exists (
    select 1 from games
     where season_id = p_season and not is_draft
       and (scheduled_at < now()
            or status <> 'scheduled'
            or home_goals > 0 or away_goals > 0)
  );
$$;

comment on function public.season_is_started(uuid) is
  'True once any published game in the season has been played or acted on. The gate on replacing a schedule.';

-- Delete the live schedule and promote the drafts, atomically.
--
-- Run as two PostgREST calls instead, a failure between them leaves the season
-- with ZERO games: old schedule deleted, new one still in draft, and the public
-- schedule page, both calendar feeds and the CSV all empty. Same reasoning as
-- postpone_game/restore_game in 0025.
create or replace function public.replace_published_schedule(p_season uuid)
returns table (deleted int, published int, refused text)
language plpgsql security invoker set search_path = public as $$
declare
  v_deleted int := 0;
  v_published int := 0;
begin
  -- Serialize publishes per season. Without it two managers publishing at once
  -- can both observe drafts present without either's snapshot seeing the other,
  -- and the second deletes what the first just promoted. Released at commit.
  perform pg_advisory_xact_lock(hashtext(p_season::text));

  -- Evaluated inside the transaction on purpose. The rule is time-based, so a
  -- check in TypeScript followed by a separate write would let a game 30 seconds
  -- from its start time tick past while the replace is in flight.
  if season_is_started(p_season) then
    return query select 0, 0, 'started'::text;
    return;
  end if;

  -- Nothing to promote. Without this a stale form submit — draft discarded in
  -- another tab — deletes the live schedule and publishes nothing in its place.
  if not exists (select 1 from games where season_id = p_season and is_draft) then
    return query select 0, 0, 'no_draft'::text;
    return;
  end if;

  delete from games where season_id = p_season and not is_draft;
  get diagnostics v_deleted = row_count;

  update games set is_draft = false where season_id = p_season and is_draft;
  get diagnostics v_published = row_count;

  return query select v_deleted, v_published, null::text;
end;
$$;

comment on function public.replace_published_schedule(uuid) is
  'Replace a season''s published schedule with its drafts, in one transaction. Refuses once the season has started.';

grant execute on function public.season_is_started(uuid) to authenticated;
grant execute on function public.replace_published_schedule(uuid) to authenticated;
```

- [ ] **Step 2: Apply it**

Run: `npm run db:reset`
Expected: completes without error, and the output lists `0026_replace_published_schedule.sql` among the applied migrations.

- [ ] **Step 3: Verify the started rule against the seed**

The seeded Oceanview `Spring 2026` season has `final` games dated May–June 2026, in the past. It must read as started.

Run:

```bash
psql "postgresql://postgres:postgres@127.0.0.1:54322/postgres" -c "
select s.name, l.slug, season_is_started(s.id) as started
from seasons s join leagues l on l.id = s.league_id
order by l.slug, s.name;"
```

Expected: every seeded season reports `started = t`. If any reports `f`, stop — the predicate is wrong or the seed changed.

- [ ] **Step 4: Verify each refusal and the happy path**

This script builds a throwaway league/season in a transaction and rolls it back, so it leaves no trace. Run it whole:

```bash
psql "postgresql://postgres:postgres@127.0.0.1:54322/postgres" <<'SQL'
begin;
insert into leagues (name, slug, is_public) values ('T','t-tmp',false);
insert into seasons (league_id, name, starts_on, ends_on)
  select id, 'S', date '2099-01-01', date '2099-06-01' from leagues where slug='t-tmp';
insert into teams (league_id, name, slug)
  select id, 'A', 'a-tmp' from leagues where slug='t-tmp';
insert into teams (league_id, name, slug)
  select id, 'B', 'b-tmp' from leagues where slug='t-tmp';

create temp view v as select
  (select id from seasons where name='S' and league_id=(select id from leagues where slug='t-tmp')) as season,
  (select id from teams where slug='a-tmp') as a,
  (select id from teams where slug='b-tmp') as b;

-- live schedule (future) + a draft
insert into games (season_id, home_team_id, away_team_id, scheduled_at, is_draft)
  select season, a, b, timestamptz '2099-02-01 19:00-05', false from v;
insert into games (season_id, home_team_id, away_team_id, scheduled_at, is_draft)
  select season, b, a, timestamptz '2099-03-01 19:00-05', true from v;

\echo '--- expect deleted=1 published=1 refused=NULL'
select * from replace_published_schedule((select season from v));
\echo '--- expect 1 live game, 0 drafts'
select count(*) filter (where not is_draft) as live,
       count(*) filter (where is_draft) as drafts
from games where season_id=(select season from v);

\echo '--- expect no_draft (live present, nothing to promote)'
select * from replace_published_schedule((select season from v));

-- make it started via a past date
insert into games (season_id, home_team_id, away_team_id, scheduled_at, is_draft)
  select season, a, b, timestamptz '2020-01-01 19:00-05', true from v;
update games set scheduled_at = timestamptz '2020-01-01 19:00-05'
  where season_id=(select season from v) and not is_draft;
\echo '--- expect started, deleted=0'
select * from replace_published_schedule((select season from v));

-- started via status, with a future date
update games set scheduled_at = timestamptz '2099-02-01 19:00-05', status='final'
  where season_id=(select season from v) and not is_draft;
\echo '--- expect started (future date, but final)'
select * from replace_published_schedule((select season from v));

rollback;
SQL
```

Expected output, in order:
1. `deleted=1, published=1, refused=NULL`
2. `live=1, drafts=0`
3. `deleted=0, published=0, refused=no_draft`
4. `deleted=0, published=0, refused=started`
5. `deleted=0, published=0, refused=started`

Paste the real output into the commit or task notes. If any line differs, the function is wrong.

- [ ] **Step 5: Regenerate types**

Run: `npm run gen-types`
Then run: `git diff --stat src/lib/db/types.ts`
Expected: `types.ts` changed, and `grep -n "season_is_started\|replace_published_schedule" src/lib/db/types.ts` returns matches under the `Functions` section.

- [ ] **Step 6: Commit**

```bash
git add supabase/migrations/0026_replace_published_schedule.sql src/lib/db/types.ts
git commit -m "feat: add the one-published-schedule database functions"
```

---

### Task 2: `publishMode` — the pure mode decision

**Files:**
- Create: `src/lib/schedule/publishMode.ts`
- Test: `src/lib/schedule/publishMode.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `type PublishMode = "empty" | "draft-only" | "published" | "replace" | "locked"` and `publishMode(state: { liveCount: number; draftCount: number; started: boolean }): PublishMode`. Task 6 renders off this.

This is the one genuinely unit-testable piece, extracted for the same reason `checkOneOffWrite` and `buildOneOffRows` were: pull the decision out of the I/O and test it there. Write the test first.

- [ ] **Step 1: Write the failing test**

Create `src/lib/schedule/publishMode.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { publishMode } from "./publishMode";

describe("publishMode", () => {
  it("is empty with no live games and no draft", () => {
    expect(publishMode({ liveCount: 0, draftCount: 0, started: false })).toBe("empty");
  });

  it("is draft-only when a draft exists and nothing is live", () => {
    expect(publishMode({ liveCount: 0, draftCount: 40, started: false })).toBe("draft-only");
  });

  it("is published when a live schedule exists and there is no draft", () => {
    expect(publishMode({ liveCount: 40, draftCount: 0, started: false })).toBe("published");
  });

  it("is replace when a draft would displace a live schedule", () => {
    expect(publishMode({ liveCount: 40, draftCount: 42, started: false })).toBe("replace");
  });

  it("is locked once the season has started", () => {
    expect(publishMode({ liveCount: 40, draftCount: 0, started: true })).toBe("locked");
  });

  it("stays locked even with a draft sitting there", () => {
    // A stale draft generated before the first game was played. It must not
    // offer a replace — started outranks every other signal.
    expect(publishMode({ liveCount: 40, draftCount: 42, started: true })).toBe("locked");
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npm test -- publishMode`
Expected: FAIL — cannot resolve `./publishMode`.

- [ ] **Step 3: Implement**

Create `src/lib/schedule/publishMode.ts`:

```ts
/**
 * Which of the builder's five states a season is in.
 *
 * `started` outranks everything: a season under way offers no publish path at
 * all, which is what keeps the delete in `replace_published_schedule` from ever
 * reaching a played game.
 */
export type PublishMode =
  | "empty" // nothing live, nothing drafted
  | "draft-only" // first publish — one click, not destructive
  | "published" // live schedule, no draft to replace it with
  | "replace" // a draft would displace a live schedule — needs confirming
  | "locked"; // season under way

export function publishMode(state: {
  liveCount: number;
  draftCount: number;
  started: boolean;
}): PublishMode {
  if (state.started) return "locked";
  if (state.liveCount === 0) return state.draftCount === 0 ? "empty" : "draft-only";
  return state.draftCount === 0 ? "published" : "replace";
}
```

- [ ] **Step 4: Run it and watch it pass**

Run: `npm test -- publishMode`
Expected: PASS, 6 tests.

- [ ] **Step 5: Commit**

```bash
git add src/lib/schedule/publishMode.ts src/lib/schedule/publishMode.test.ts
git commit -m "feat: decide the schedule builder's mode from publish state"
```

---

### Task 3: `getPublishState` — the read path

**Files:**
- Modify: `src/lib/queries/schedule.ts` (append; do not disturb existing helpers)

**Interfaces:**
- Consumes: `season_is_started` RPC (Task 1).
- Produces:
  ```ts
  type SchedulePublishState = {
    liveCount: number; draftCount: number; started: boolean;
    firstLiveDate: string | null; lastLiveDate: string | null; lineupsAtRisk: number;
  };
  getPublishState(seasonId: string, opts?: { client?: DbClient }): Promise<SchedulePublishState>
  ```
  Tasks 4 and 6 consume this.

`started` comes from the RPC so the rule has one definition. The aggregates are ordinary reads — a wrong count renders a slightly wrong sentence; a wrong rule deletes a season.

No `isUuid` guard is needed here. That rule (documented at the top of the file) covers helpers interpolating a **team** id into a PostgREST `.or()` string; this filters `season_id` with `.eq()`, which is parameterised.

- [ ] **Step 1: Append the helper**

Add to the end of `src/lib/queries/schedule.ts`:

```ts
/**
 * Everything the schedule builder needs to decide what it may offer.
 *
 * `started` is read from the `season_is_started` RPC rather than recomputed
 * here: it is the gate `replace_published_schedule` enforces, and a second copy
 * of that predicate in TypeScript would be free to drift from the one that
 * actually guards the delete.
 */
export type SchedulePublishState = {
  liveCount: number;
  draftCount: number;
  started: boolean;
  /** League-local YYYY-MM-DD of the first/last dated live game; null if none. */
  firstLiveDate: string | null;
  lastLiveDate: string | null;
  /**
   * `game_rosters` rows hanging off live games. They cascade on game delete
   * (0004_games.sql), so a replace silently discards lineups a captain set in
   * advance — the confirm dialog names this when it is non-zero.
   */
  lineupsAtRisk: number;
};

export async function getPublishState(
  seasonId: string,
  opts: { client?: DbClient } = {},
): Promise<SchedulePublishState> {
  const supabase = opts.client ?? (await createClient());

  const [live, drafts, started, lineups] = await Promise.all([
    // Dates come back with the rows rather than as a min/max aggregate so an
    // undated live game still counts toward liveCount.
    supabase
      .from("games")
      .select("scheduled_at")
      .eq("season_id", seasonId)
      .eq("is_draft", false),
    supabase
      .from("games")
      .select("*", { count: "exact", head: true })
      .eq("season_id", seasonId)
      .eq("is_draft", true),
    supabase.rpc("season_is_started", { p_season: seasonId }),
    supabase
      .from("game_rosters")
      .select("id, games!inner(season_id, is_draft)", { count: "exact", head: true })
      .eq("games.season_id", seasonId)
      .eq("games.is_draft", false),
  ]);

  const dates = (live.data ?? [])
    .map((g) => g.scheduled_at)
    .filter((d): d is string => !!d)
    .sort();

  return {
    liveCount: live.data?.length ?? 0,
    draftCount: drafts.count ?? 0,
    started: started.data === true,
    firstLiveDate: dates.length ? leagueDateKey(dates[0]) : null,
    lastLiveDate: dates.length ? leagueDateKey(dates[dates.length - 1]) : null,
    lineupsAtRisk: lineups.count ?? 0,
  };
}
```

`leagueDateKey` and `DbClient` are already imported at the top of this file — do not add duplicate imports.

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors. If `supabase.rpc("season_is_started", ...)` is untyped, Task 1 Step 5 (`npm run gen-types`) did not run — go back and run it.

- [ ] **Step 3: Lint**

Run: `npm run lint`
Expected: no new errors.

- [ ] **Step 4: Commit**

```bash
git add src/lib/queries/schedule.ts
git commit -m "feat: read a season's publish state through the schedule query path"
```

---

### Task 4: The actions

**Files:**
- Modify: `src/lib/actions/schedule.ts:60` (`generateSchedule`), `:179` (`publishSchedule`)

**Interfaces:**
- Consumes: both RPCs (Task 1), `getPublishState` is *not* used here — the RPC is authoritative.
- Produces: `type PublishState = { ok: boolean; message: string } | null` and
  `publishSchedule(prev: PublishState, formData: FormData): Promise<PublishState>`.
  Task 6's client component drives this with `useActionState`.

`publishSchedule` changes shape from a plain void form action to an action-state action, matching `announcement-form.tsx` / `add-team-form.tsx`, so refusals reach the manager as a message instead of a silent no-op.

- [ ] **Step 1: Add the started guard to `generateSchedule`**

In `src/lib/actions/schedule.ts`, immediately after the `if (!seasonId) return;` line inside `generateSchedule` (around line 63), insert:

```ts
  // A started season can't publish, so it shouldn't accept a draft either —
  // generating one would only produce a preview that can never be applied. Same
  // rule as the publish gate, read from the same function.
  const { data: startedGuard } = await admin.rpc("season_is_started", {
    p_season: seasonId,
  });
  if (startedGuard === true) return;
```

- [ ] **Step 2: Replace `publishSchedule`**

Replace the whole of `publishSchedule` (currently lines 178–193) with:

```ts
export type PublishState = { ok: boolean; message: string } | null;

/**
 * Publish the draft schedule, replacing whatever is already live.
 *
 * The delete and the promotion happen inside `replace_published_schedule` so
 * they commit together — as two calls from here, a failure between them would
 * leave the season with no games at all, the old schedule gone and the new one
 * still in draft.
 *
 * Refusals are ordinary outcomes of a stale page, not faults: the manager's tab
 * may have been open since before the first game was played, or the draft may
 * have been discarded in another tab. Both come back as a message.
 */
export async function publishSchedule(
  _prev: PublishState,
  formData: FormData,
): Promise<PublishState> {
  const user = await requireManager();
  const admin = createAdminClient();
  const seasonId = await targetSeason(admin, String(formData.get("season_id") ?? ""));
  if (!seasonId) return { ok: false, message: "No season selected." };

  const { data, error } = await admin.rpc("replace_published_schedule", {
    p_season: seasonId,
  });
  if (error) return { ok: false, message: error.message };

  const row = data?.[0];
  if (!row) return { ok: false, message: "Nothing happened — try again." };

  if (row.refused === "started") {
    return {
      ok: false,
      message: "The season is under way — the schedule can no longer be replaced.",
    };
  }
  if (row.refused === "no_draft") {
    return { ok: false, message: "There's no draft to publish." };
  }

  // A replace deletes live games, which is the most destructive thing a manager
  // can do here. A first publish deletes nothing and stays unaudited, matching
  // the bar the rest of games.ts sets.
  if (row.deleted > 0) {
    void logAudit({
      user_id: user.id,
      action: "replace_schedule",
      entity_type: "season",
      entity_id: seasonId,
      old_data: { published_games: row.deleted },
      new_data: { published_games: row.published },
    });
  }

  revalidatePath("/schedule-builder");
  revalidatePath(`/seasons/${seasonId}`);
  revalidatePath("/schedule");
  revalidatePath("/");

  return {
    ok: true,
    message:
      row.deleted > 0
        ? `Replaced the published schedule — removed ${row.deleted} games, published ${row.published}.`
        : `Published ${row.published} games.`,
  };
}
```

- [ ] **Step 3: Add the audit import**

At the top of `src/lib/actions/schedule.ts`, alongside the existing imports, add:

```ts
import { logAudit } from "@/lib/audit";
```

Note on `const user = await requireManager()`: the existing code calls this bare, discarding the result. It returns `Promise<SessionUser>` (`src/lib/auth/guards.ts:18` → `requireRole`), and `SessionUser` is `{ id: string; email: string | null; role: AppRole | null }`, so `user.id` is the audit's `user_id`. No import change is needed for it.

- [ ] **Step 4: Typecheck and lint**

Run: `npx tsc --noEmit && npm run lint`
Expected: `schedule-builder-panel.tsx` errors on `<form action={publishSchedule}>`, because the action's signature changed. That is expected and Task 6 fixes it. There must be no *other* errors.

- [ ] **Step 5: Commit**

```bash
git add src/lib/actions/schedule.ts
git commit -m "feat: publishing replaces the live schedule and refuses once started"
```

---

### Task 5: Seed a season that has not started

**Files:**
- Modify: `supabase/seed.sql`
- Modify: `e2e/11-schedule-builder.spec.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: an Oceanview season named `Fall 2026`, inactive, dated 2026-09-15 → 2027-03-31, with the same six teams enrolled and **zero games**. Task 7 asserts against it.

**Why this task exists.** Today is 2026-07-30 and the seeded active season runs 2026-05-12 → 2026-06-30 with `final` games. Under Task 1's rule it is *started*, so once Task 6 lands, `/schedule-builder` renders the lock and the five tests in `11-schedule-builder.spec.ts` that exercise the generate form fail. The fixtures need a season on the other side of the rule. Doing it before the UI change keeps the suite green at every commit.

- [ ] **Step 1: Read the Oceanview seed block**

Run: `sed -n '78,180p' supabase/seed.sql`

Identify the variables holding the league id (`v_league`), the season id (`v_season`) and the team ids (`v_team_ids`) at the end of the Oceanview block, and the exact `insert into season_teams` form used there. Match that style exactly — do not invent column names.

- [ ] **Step 2: Add the season**

Immediately **after** the Oceanview games loop ends and **before** the `-- Two Oceanview people we'll also roster in Harbor` comment, insert:

```sql
  -- A season that has not started: no games at all, so season_is_started() is
  -- false and the schedule builder still offers to generate and publish. The
  -- active Spring 2026 season is in the past and reads as started, so without
  -- this there is no fixture on the un-started side of the rule.
  declare
    v_fall uuid;
  begin
    insert into seasons (league_id, name, starts_on, ends_on, is_active, point_system)
      values (v_league, 'Fall 2026', date '2026-09-15', date '2027-03-31', false,
              '{"win":2,"tie":1,"loss":0}'::jsonb)
      returning id into v_fall;

    -- Same six teams, so the generator has something to work with.
    for i in 1 .. array_length(v_team_ids, 1) loop
      insert into season_teams (season_id, team_id) values (v_fall, v_team_ids[i]);
    end loop;
  end;
```

If the surrounding block is a single `do $$ ... $$` with all `declare`s at the top, move `v_fall uuid;` up to that declaration list and drop the nested `declare`/`begin`/`end` wrapper, keeping the two statements inline. Match the file, not this snippet.

- [ ] **Step 3: Apply and verify**

Run: `npm run db:reset`
Then run:

```bash
psql "postgresql://postgres:postgres@127.0.0.1:54322/postgres" -c "
select s.name, s.is_active, season_is_started(s.id) as started,
       (select count(*) from season_teams st where st.season_id = s.id) as teams,
       (select count(*) from games g where g.season_id = s.id) as games
from seasons s join leagues l on l.id = s.league_id
where l.slug = 'obhl' order by s.starts_on;"
```

Expected: two rows. `Spring 2026` → `is_active=t, started=t`. `Fall 2026` → `is_active=f, started=f, teams=6, games=0`.

- [ ] **Step 4: Add a navigation helper to the e2e spec**

In `e2e/11-schedule-builder.spec.ts`, below the existing `signedInAs` helper, add:

```ts
/**
 * The builder's generate/publish flow only exists on a season that hasn't
 * started. The active season is in the past, so these tests drive Fall 2026
 * through its setup page, which renders the same ScheduleBuilderPanel.
 */
async function goToFallSeasonSetup(page: Page) {
  await page.goto("/seasons");
  await page
    .getByRole("row", { name: /Fall 2026/ })
    .getByRole("link", { name: "Setup" })
    .click();
  await page.waitForURL(/\/seasons\//);
}
```

- [ ] **Step 5: Retarget the five form-driven tests**

In the `Path 17 — Schedule Builder` describe block, change the `beforeEach` from:

```ts
    await signedInAs(page, "Manager");
    await page.goto("/schedule-builder");
```

to:

```ts
    await signedInAs(page, "Manager");
    await goToFallSeasonSetup(page);
```

Then fix the two tests that assert page-level chrome which only exists on `/schedule-builder`:

- `"page loads with heading and active season description"` — move it out of the describe block into its own `test(...)` that navigates to `/schedule-builder` directly and keeps its current assertions.
- `"scorekeeper cannot reach /schedule-builder"` — same; it already navigates itself, so just ensure it does not rely on the `beforeEach`.

Leave the assertions inside the other tests unchanged.

- [ ] **Step 6: Run the e2e suite**

Run: `npm run test:e2e -- 11-schedule-builder`
Expected: all tests pass. The UI has not changed yet, so any failure here is a seed or navigation problem, not a feature problem.

- [ ] **Step 7: Run the full suite for seed fallout**

Run: `npm run test:e2e`
Expected: all pass. Pay attention to `03-seasons.spec.ts` — it asserts `toHaveCount(6)` on the *active* season's teams table and matches the seasons list row by `/Spring 2026/`, neither of which `Fall 2026` should disturb. If it fails, the new season leaked into a selector that needs narrowing.

- [ ] **Step 8: Commit**

```bash
git add supabase/seed.sql e2e/11-schedule-builder.spec.ts
git commit -m "test: seed a season that hasn't started and target the builder at it"
```

---

### Task 6: The builder UI

**Files:**
- Create: `src/components/manage/publish-controls.tsx`
- Modify: `src/components/manage/schedule-builder-panel.tsx`

**Interfaces:**
- Consumes: `publishMode` (Task 2), `getPublishState` / `SchedulePublishState` (Task 3), `publishSchedule` / `PublishState` (Task 4), `discardSchedule` (unchanged).
- Produces: the five rendered modes. Task 7 asserts against them.

The panel currently reads drafts only, which is exactly why it cannot see the problem.

- [ ] **Step 1: Build the client controls**

Create `src/components/manage/publish-controls.tsx`:

```tsx
"use client";

import { useActionState, useEffect, useState } from "react";
import { toast } from "sonner";
import { publishSchedule, type PublishState } from "@/lib/actions/schedule";
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
 * Publish, or replace. Only a replace destroys anything, so only a replace is
 * confirmed — a season's first publish stays one click.
 */
export function PublishControls({
  seasonId,
  draftCount,
  liveCount,
  firstLiveDate,
  lastLiveDate,
  lineupsAtRisk,
  destructive,
}: {
  seasonId: string;
  draftCount: number;
  liveCount: number;
  firstLiveDate: string | null;
  lastLiveDate: string | null;
  lineupsAtRisk: number;
  /** True in "replace" mode — a live schedule would be deleted. */
  destructive: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [state, action, pending] = useActionState<PublishState, FormData>(
    publishSchedule,
    null,
  );

  useEffect(() => {
    if (!state) return;
    if (state.ok) {
      toast.success(state.message);
      setOpen(false);
    } else {
      toast.error(state.message);
    }
  }, [state]);

  const range =
    firstLiveDate && lastLiveDate ? ` (${firstLiveDate} – ${lastLiveDate})` : "";

  if (!destructive) {
    return (
      <form action={action}>
        <input type="hidden" name="season_id" value={seasonId} />
        <Button type="submit" disabled={pending}>
          {pending ? "Publishing…" : `Publish ${draftCount} games`}
        </Button>
      </form>
    );
  }

  return (
    <>
      <Button variant="destructive" onClick={() => setOpen(true)}>
        Replace published schedule
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Replace the published schedule?</DialogTitle>
            <DialogDescription asChild>
              <div className="space-y-2">
                <p>
                  This deletes {liveCount} live games{range} and publishes the{" "}
                  {draftCount}-game draft in their place.
                </p>
                <p>Team calendar feeds will change.</p>
                {lineupsAtRisk > 0 ? (
                  <p>
                    {lineupsAtRisk} lineup entries already set for those games
                    will be deleted with them.
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
                {pending ? "Replacing…" : "Replace"}
              </Button>
            </form>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
```

- [ ] **Step 2: Verify the dialog exports**

Run: `grep -n "^export" src/components/ui/dialog.tsx`
If `DialogDescription` or `DialogFooter` is not exported, adjust the imports and markup to whatever the file does export rather than adding exports to a shadcn primitive.

- [ ] **Step 3: Wire the panel**

In `src/components/manage/schedule-builder-panel.tsx`:

Add to the imports:

```tsx
import { getPublishState } from "@/lib/queries/schedule";
import { publishMode } from "@/lib/schedule/publishMode";
import { PublishControls } from "@/components/manage/publish-controls";
```

and remove `publishSchedule` from the `@/lib/actions/schedule` import, leaving `discardSchedule`.

After the existing `const enrolledTeams = await getEnrolledTeams(...)` line, add:

```tsx
  const publish = await getPublishState(seasonId, { client: admin });
  const mode = publishMode(publish);
```

Replace the `<Card>` holding `ScheduleGenerateForm` and the one-off paragraph that follows it with a conditional — when `mode === "locked"`, neither is offered:

```tsx
      {mode === "locked" ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">The season is under way</CardTitle>
          </CardHeader>
          <CardContent className="text-muted-foreground space-y-2 text-sm">
            <p>
              {publish.liveCount} games are published
              {publish.firstLiveDate ? `, starting ${formatLongDate(publish.firstLiveDate)}` : ""}.
              The full schedule can no longer be regenerated or replaced.
            </p>
            <p>
              To change a single game, use Reschedule, Postpone or Cancel on that
              game&apos;s score page.
            </p>
            <p>
              To slot in a tournament final or semifinals,{" "}
              <Link
                href="/schedule-builder/one-off"
                className="text-foreground font-medium underline"
              >
                schedule a one-off game
              </Link>
              .
            </p>
          </CardContent>
        </Card>
      ) : (
        <>
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Generate a balanced schedule</CardTitle>
            </CardHeader>
            <CardContent>
              <ScheduleGenerateForm
                seasonId={seasonId}
                seasonStart={season?.starts_on ?? null}
                seasonEnd={season?.ends_on ?? null}
                teamCount={enrolledCount}
              />
            </CardContent>
          </Card>

          <p className="text-muted-foreground text-sm">
            Adding a tournament final or semifinals mid-season is a different job
            — it takes over a game on a night that&apos;s already scheduled and
            repairs the rest of the season around it.{" "}
            <Link
              href="/schedule-builder/one-off"
              className="text-foreground font-medium underline"
            >
              Schedule a one-off game
            </Link>
            .
          </p>

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
        </>
      )}
```

- [ ] **Step 4: Swap the publish form for the controls**

Inside the existing `(drafts ?? []).length === 0 ? ... : (...)` branch, replace the `<form action={publishSchedule}>…</form>` block (currently lines 196–199) with:

```tsx
            <PublishControls
              seasonId={seasonId}
              draftCount={publish.draftCount}
              liveCount={publish.liveCount}
              firstLiveDate={publish.firstLiveDate}
              lastLiveDate={publish.lastLiveDate}
              lineupsAtRisk={publish.lineupsAtRisk}
              destructive={mode === "replace"}
            />
```

Leave the `discardSchedule` form beside it exactly as it is — Discard stays available in every mode, including `locked`, so a stale draft can be cleared.

- [ ] **Step 5: Typecheck and lint**

Run: `npx tsc --noEmit && npm run lint`
Expected: clean. The Task 4 error about `<form action={publishSchedule}>` is now gone.

- [ ] **Step 6: Check it by hand**

Run: `npm run dev`, sign in as Manager.

- Visit `/schedule-builder` (active `Spring 2026`) → the locked card, no generate form.
- Visit `/seasons` → Setup on `Fall 2026` → generate form present, "No draft schedule".
- Generate a draft (first game night `2026-09-15`, 4 games per team, tick Tue and Thu) → "Publish N games", one click, no dialog. Click it → toast "Published N games."
- Generate again → button now reads "Replace published schedule" → click → dialog names the live count, the date range and the calendar-feed warning → Replace → toast "Replaced the published schedule — removed D games, published N."
- Confirm the season now holds one schedule's worth of games:

```bash
psql "postgresql://postgres:postgres@127.0.0.1:54322/postgres" -c "
select count(*) filter (where not is_draft) as live, count(*) filter (where is_draft) as drafts
from games where season_id = (select id from seasons where name='Fall 2026');"
```

Expected: `live` equals the draft count you just published; `drafts` is 0.

- [ ] **Step 7: Commit**

```bash
git add src/components/manage/publish-controls.tsx src/components/manage/schedule-builder-panel.tsx
git commit -m "feat: replace or lock the schedule builder by publish state"
```

---

### Task 7: End-to-end coverage

**Files:**
- Modify: `e2e/11-schedule-builder.spec.ts`

**Interfaces:**
- Consumes: everything above.
- Produces: regression cover for the reported bug.

- [ ] **Step 1: Add the two tests**

Append inside the `Path 17 — Schedule Builder` describe block:

```ts
  test("republishing replaces the schedule instead of stacking a second one", async ({
    page,
  }) => {
    // The reported bug: generate + publish twice left the season holding two
    // complete overlapping schedules, both live in the exports and standings.
    await page.getByLabel("First game night").fill("2026-09-15");
    await page.getByLabel("Games per team").fill("4");
    await page.locator('label:has-text("Tue") input[name="weekdays"]').check();
    await page.locator('label:has-text("Thu") input[name="weekdays"]').check();
    await page.getByRole("button", { name: "Generate schedule" }).click();

    const publishButton = page.getByRole("button", { name: /Publish \d+ games/ });
    await expect(publishButton).toBeVisible();
    const published = Number(
      (await publishButton.textContent())!.match(/\d+/)![0],
    );
    await publishButton.click();
    await expect(page.getByText(`Published ${published} games.`)).toBeVisible();

    // Second pass — the button must now offer a replace, not another publish.
    await page.getByLabel("First game night").fill("2026-09-15");
    await page.getByLabel("Games per team").fill("4");
    await page.locator('label:has-text("Tue") input[name="weekdays"]').check();
    await page.locator('label:has-text("Thu") input[name="weekdays"]').check();
    await page.getByRole("button", { name: "Generate schedule" }).click();

    await expect(
      page.getByRole("button", { name: "Replace published schedule" }),
    ).toBeVisible();
    await expect(page.getByRole("button", { name: /Publish \d+ games/ })).toHaveCount(0);

    await page.getByRole("button", { name: "Replace published schedule" }).click();
    await expect(page.getByText("Replace the published schedule?")).toBeVisible();
    await expect(page.getByText(`This deletes ${published} live games`)).toBeVisible();
    await page.getByRole("button", { name: "Replace", exact: true }).click();

    await expect(page.getByText(/Replaced the published schedule/)).toBeVisible();
    // One schedule's worth, not two.
    await expect(page.getByText(`Published: ${published} games`)).toBeVisible();
  });

  test("a started season locks the builder", async ({ page }) => {
    // The active Spring 2026 season is in the past, so it has started.
    await page.goto("/schedule-builder");
    await expect(page.getByText("The season is under way")).toBeVisible();
    await expect(page.getByText("Generate a balanced schedule")).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: "Generate schedule" }),
    ).toHaveCount(0);
  });
```

- [ ] **Step 2: Run the spec**

Run: `npm run test:e2e -- 11-schedule-builder`
Expected: all pass.

If the replace test fails on ordering, note that it publishes into `Fall 2026` and leaves games behind, which the earlier `"generates a balanced draft"` test does not expect. Playwright runs tests in file order within a worker, so place this test **last** in the block, and have it clean up by discarding any leftover draft. Do not add cross-test state that later tests depend on.

- [ ] **Step 3: Run everything**

Run: `npm test && npm run test:e2e && npm run lint && npx tsc --noEmit`
Expected: all green. Paste the summary lines.

- [ ] **Step 4: Commit**

```bash
git add e2e/11-schedule-builder.spec.ts
git commit -m "test: cover republishing replacing a schedule and the started lock"
```

---

### Task 8: Update the handoff

**Files:**
- Modify: `EXPORTS_HANDOFF.md`
- Modify: `AGENTS.md`

`AGENTS.md` points agents at the handoffs as the place decisions live. A rule that silently deletes a season's games belongs there.

- [ ] **Step 1: Add a section to `EXPORTS_HANDOFF.md`**

Under §3 ("Decisions you can't recover from the code"), add:

```markdown
**Publishing replaces; a started season refuses.** `publishSchedule` calls
`replace_published_schedule`, which deletes the season's live games and promotes
the drafts in one transaction. It refuses once `season_is_started` is true —
defined as any published game having a past `scheduled_at`, a status other than
`scheduled`, or a non-zero score.

Protecting played games is a *consequence* of that gate, not a separate rule: a
single played game flips the season to started and removes the delete path
entirely, so no code walks a set of games deciding which to keep. Don't
"improve" this by adding a partial replace that keeps played games and drops the
rest — that reintroduces exactly the class of bug the gate was written to make
unreachable, and it needs the generator seeded with games-played and home/away
already accrued or the back half of the season won't balance against the front.

Note that `game_rosters` cascades on game delete, so a replace also discards
lineups a captain set in advance. Reachable only before the season starts, and
the confirm dialog says so.
```

- [ ] **Step 2: Note the fixture dependency in §6 Gotchas**

Add:

```markdown
**The e2e builder tests depend on a season that hasn't started.** The seeded
active season (`Spring 2026`, May–Jun 2026) is in the past and reads as started,
so it renders the locked panel. `Fall 2026` exists in `supabase/seed.sql` purely
to give the generate/publish flow somewhere to run. If the builder tests start
failing with "Generate schedule not found", check that season still has zero
games — publishing into it from a manual session will lock it on the next run
only if a game's date has passed, so prefer far-future dates there.
```

- [ ] **Step 3: Add the files table row**

In §7, add:

| `supabase/migrations/0026_replace_published_schedule.sql` | `season_is_started`, `replace_published_schedule` |
| `src/lib/schedule/publishMode.ts` + test | the builder's five modes |

- [ ] **Step 4: Commit**

```bash
git add EXPORTS_HANDOFF.md AGENTS.md
git commit -m "docs: record that publishing replaces and a started season refuses"
```

---

## Self-Review

**Spec coverage.** Every section maps to a task: §1 started rule → Task 1; §2 replace function → Task 1; §3 actions and the message table → Task 4; §4 read path → Task 3; §5 UI modes and dialog → Tasks 2 and 6; §6 verification → Tasks 1 (SQL), 2 (unit), 7 (e2e); §7 deployment note → Task 1 Step 2.

**One thing the spec did not anticipate:** the seeded active season is in the past and therefore started, so the existing e2e suite breaks the moment the UI becomes state-aware. Task 5 exists to cover that and has no counterpart section in the spec. It is a fixture gap the feature exposes, not a design change.

**Type consistency.** `SchedulePublishState` (Task 3) is consumed by `publishMode` (Task 2), which accepts a structural subset — `liveCount`, `draftCount`, `started` — so the full state satisfies it. `PublishState` (Task 4) is the action-state type and is distinct from `SchedulePublishState`; the names are close, and Task 6 imports both. `PublishMode` values are used verbatim in Task 6's comparisons (`"locked"`, `"replace"`, `"published"`).

**Verified while writing, not left to the implementer:** `requireManager()` returns `Promise<SessionUser>` with `id: string`; `components/ui/dialog.tsx` exists; `Toaster` is mounted globally in `src/app/layout.tsx:52`; `useActionState` is the established action pattern across `src/components/manage/`; local Postgres is on port 54322.

**Known soft spot.** Task 6 Step 2 still asks the implementer to confirm `dialog.tsx`'s exact exports before importing `DialogDescription`/`DialogFooter`. The file exists but its export list was not read, and adding exports to a shadcn primitive to satisfy this plan would be the wrong fix.
