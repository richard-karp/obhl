# Clock-relative test fixture — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `supabase/seed.sql` and the e2e specs derive every date from the clock, so the fixture cannot expire.

**Architecture:** Each seeded season gets a weekday-stable anchor computed from `current_date`; every game, announcement and season boundary becomes an offset from its own season's anchor. The three specs that restate `2026-09-15` read `starts_on` back from the database instead. Two specs that pin `2027` compute their year the way `30-` already does.

**Tech Stack:** Postgres (plpgsql `do` blocks in `seed.sql`), Playwright, `@supabase/supabase-js` admin client.

**Spec:** `docs/superpowers/specs/2026-09-07-clock-relative-fixture-design.md`

## Global Constraints

- **Anchors are weekday-stable.** League 1's games are all Tuesdays, league 2's all Wednesdays, Fall starts a Tuesday. An anchor that lands on an arbitrary weekday breaks `28-`'s `SKIP_DAY`, which is a day-of-month that must be a Thursday.
- **Exact anchor expressions** (verified 2026-09-07 against the local database):
  - League 1 Spring: `date_trunc('week', current_date - 120)::date + 1` → a Tuesday, ~120d back
  - League 2 Spring: `date_trunc('week', current_date - 120)::date + 2` → the Wednesday after it
  - Fall: `date_trunc('week', current_date + 14)::date + 1` → a Tuesday, **9–15 days out** for every possible weekday of "today" (worst case: today is a Sunday → +9)
- **Never write a numeric UTC offset.** Build times as `(anchor + interval 'N days' + time 'HH:MM') at time zone 'America/Toronto'`. The literal `-04` in today's seed is EDT and becomes wrong the moment an anchor lands in EST.
- **Day-offsets are transcribed, never generated.** League 1 nights: `0, 7, 14, 28, 35` (**21 is deliberately absent — a bye week**). League 2 nights: `0, 7, 28` (**14 and 21 absent**). Ice times `19:00, 20:15, 21:30` (league 1) and `19:00, 20:15` (league 2).
- **Season spans:** league 1 Spring `+49d`, league 2 Spring `+47d`, Fall `+197d`.
- **Season names keep their literal year** (`'Spring 2026'`, `'Fall 2026'`) — 17 assertions across 8 specs match them as identifiers. Each needs a comment saying the year is not a claim about the dates.
- ⛔ **`npm run db:reset` is LOCAL only.** Never `supabase db reset --linked`. `global-setup` already runs the local reset before every e2e run, so the seed re-computes each time.
- Verification command for the suite: `PORT=3117 scripts/e2e-locked.sh` (any free port; the flag exists because worktrees share one Supabase and runs must be serialized) — the shared database means runs must be serialized.

---

### Task 1: Anchor helper and league 1's Spring season

**Files:**

- Modify: `supabase/seed.sql:83-107` (season + announcements), `supabase/seed.sql:142-156` (games)

**Interfaces:**

- Produces: three plpgsql variables available to the rest of the seed — `v_l1_anchor date`, `v_l2_anchor date`, `v_fall_anchor date`. Tasks 2 and 3 consume them.

- [ ] **Step 1: Declare the anchors**

In the `declare` block of the first `do $$` in `seed.sql`, add:

```sql
  -- ⛔ WEEKDAY-STABLE, NOT JUST "SOME DAYS AGO". Every league-1 game is a
  -- Tuesday and every league-2 game a Wednesday; `28-`'s SKIP_DAY is a
  -- day-of-month that must land on a Thursday. `date_trunc('week', …)` returns
  -- the ISO Monday, so +1 is Tuesday and +2 is Wednesday.
  v_l1_anchor  date := date_trunc('week', current_date - 120)::date + 1;
  v_l2_anchor  date := date_trunc('week', current_date - 120)::date + 2;
  v_fall_anchor date := date_trunc('week', current_date + 14)::date + 1;
```

- [ ] **Step 2: Replace league 1's season dates**

```sql
  insert into seasons (league_id, name, starts_on, ends_on, is_active, point_system)
    -- ⚠️ THE YEAR IN THIS NAME IS NOT A CLAIM ABOUT THE DATES. The name is the
    -- handle 17 assertions use to find this season; the dates are relative to
    -- today. Do not "fix" the mismatch by pinning the dates back.
    values (v_league, 'Spring 2026', v_l1_anchor, v_l1_anchor + 49, true,
```

- [ ] **Step 3: Replace league 1's announcements**

Offsets from the original: `2026-06-01` = +20d, `2026-05-22` = +10d, `2026-05-12` = +0d.

```sql
      (v_l1_anchor + 20 + time '09:00') at time zone 'America/Toronto'),
      (v_l1_anchor + 10 + time '12:00') at time zone 'America/Toronto'),
      (v_l1_anchor +  0 + time '08:00') at time zone 'America/Toronto');
```

- [ ] **Step 4: Replace league 1's 15 game rows**

⛔ Transcribe these offsets exactly. `21` is absent on purpose.

```sql
      (1, 1, 2, (v_l1_anchor +  0 + time '19:00') at time zone 'America/Toronto'),
      (1, 3, 6, (v_l1_anchor +  0 + time '20:15') at time zone 'America/Toronto'),
      (1, 4, 5, (v_l1_anchor +  0 + time '21:30') at time zone 'America/Toronto'),
      (2, 1, 3, (v_l1_anchor +  7 + time '19:00') at time zone 'America/Toronto'),
      (2, 2, 4, (v_l1_anchor +  7 + time '20:15') at time zone 'America/Toronto'),
      (2, 5, 6, (v_l1_anchor +  7 + time '21:30') at time zone 'America/Toronto'),
      (3, 1, 4, (v_l1_anchor + 14 + time '19:00') at time zone 'America/Toronto'),
      (3, 2, 6, (v_l1_anchor + 14 + time '20:15') at time zone 'America/Toronto'),
      (3, 3, 5, (v_l1_anchor + 14 + time '21:30') at time zone 'America/Toronto'),
      (4, 1, 5, (v_l1_anchor + 28 + time '19:00') at time zone 'America/Toronto'),
      (4, 2, 3, (v_l1_anchor + 28 + time '20:15') at time zone 'America/Toronto'),
      (4, 4, 6, (v_l1_anchor + 28 + time '21:30') at time zone 'America/Toronto'),
      (5, 1, 6, (v_l1_anchor + 35 + time '19:00') at time zone 'America/Toronto'),
      (5, 2, 5, (v_l1_anchor + 35 + time '20:15') at time zone 'America/Toronto'),
      (5, 3, 4, (v_l1_anchor + 35 + time '21:30') at time zone 'America/Toronto')
```

- [ ] **Step 5: Reset and verify the shape is unchanged**

Run: `npm run db:reset`

Then:

```bash
/opt/homebrew/opt/postgresql@16/bin/psql 'postgresql://postgres:postgres@127.0.0.1:54322/postgres' -c "
select (g.scheduled_at at time zone 'America/Toronto')::date - s.starts_on as day_off,
       to_char(g.scheduled_at at time zone 'America/Toronto','HH24:MI') as t, count(*)
  from games g join seasons s on s.id=g.season_id
 where s.name='Spring 2026' and s.is_active
 group by 1,2 order by 1,2;"
```

Expected for league 1: day_off in `{0,7,14,28,35}` with `19:00, 20:15, 21:30` on each — **15 rows, no 21**. (League 2 appears too until Task 2; ignore its rows for now.)

- [ ] **Step 6: Commit**

```bash
git add supabase/seed.sql
git commit -m "test(seed): anchor league 1's spring season to the clock"
```

---

### Task 2: League 2's Spring season

**Files:**

- Modify: `supabase/seed.sql:199-215` (season + announcements), `supabase/seed.sql:255-260` (games)

**Interfaces:**

- Consumes: `v_l2_anchor` from Task 1.

⚠️ If league 2 is seeded inside a _different_ `do $$` block than Task 1's, `v_l2_anchor` is not in scope there — re-declare it with the identical expression in that block's `declare`, and add a comment pointing at Task 1's copy so the two cannot drift.

- [ ] **Step 1: Replace the season dates**

```sql
    values (v_league, 'Spring 2026', v_l2_anchor, v_l2_anchor + 47, true,
```

- [ ] **Step 2: Replace the announcements** (`2026-05-13` = +0d, `2026-05-15` = +2d)

```sql
      (v_l2_anchor + 0 + time '09:00') at time zone 'America/Toronto'),
      (v_l2_anchor + 2 + time '10:00') at time zone 'America/Toronto');
```

- [ ] **Step 3: Replace the 6 game rows** — offsets `0, 7, 28`; **14 and 21 absent**

```sql
      (1, 1, 4, (v_l2_anchor +  0 + time '19:00') at time zone 'America/Toronto'),
      (1, 2, 3, (v_l2_anchor +  0 + time '20:15') at time zone 'America/Toronto'),
      (2, 1, 3, (v_l2_anchor +  7 + time '19:00') at time zone 'America/Toronto'),
      (2, 4, 2, (v_l2_anchor +  7 + time '20:15') at time zone 'America/Toronto'),
      (3, 1, 2, (v_l2_anchor + 28 + time '19:00') at time zone 'America/Toronto'),
      (3, 3, 4, (v_l2_anchor + 28 + time '20:15') at time zone 'America/Toronto')
```

- [ ] **Step 4: Reset and verify both leagues at once**

Run: `npm run db:reset`, then the query from Task 1 Step 5.

Expected: league 1 `{0,7,14,28,35}`, league 2 `{0,7,28}`. Both anchors are a Tuesday and the Wednesday after it:

```bash
/opt/homebrew/opt/postgresql@16/bin/psql 'postgresql://postgres:postgres@127.0.0.1:54322/postgres' -c "
select name, starts_on, to_char(starts_on,'Dy') as dow, ends_on - starts_on as span,
       starts_on < current_date as in_the_past from seasons order by starts_on;"
```

Expected: both Springs `in_the_past = t`, spans `49` and `47`, days `Tue` and `Wed`.

- [ ] **Step 5: Commit**

```bash
git add supabase/seed.sql
git commit -m "test(seed): anchor league 2's spring season to the clock"
```

---

### Task 3: The Fall season — the one that expires

**Files:**

- Modify: `supabase/seed.sql:178`

**Interfaces:**

- Consumes: `v_fall_anchor` from Task 1 (re-declare in this block if out of scope, as Task 2 notes).

- [ ] **Step 1: Replace the Fall season dates**

```sql
      -- ⛔ THIS IS THE SEASON THE WHOLE CHANGE EXISTS FOR. It must be UNSTARTED
      -- for the builder specs to work: `season_is_started` flipping is what
      -- locks the builder and falsifies `11-`'s stated premise. The anchor is a
      -- Tuesday 9–15 days out for every possible weekday of "today".
      -- ⚠️ The year in the name is not a claim about the dates.
      values (v_league, 'Fall 2026', v_fall_anchor, v_fall_anchor + 197, false,
```

- [ ] **Step 2: Reset and verify it is future AND unstarted**

Run: `npm run db:reset`, then:

```bash
/opt/homebrew/opt/postgresql@16/bin/psql 'postgresql://postgres:postgres@127.0.0.1:54322/postgres' -c "
select s.name, s.starts_on, to_char(s.starts_on,'Dy') as dow,
       s.starts_on - current_date as days_out, season_is_started(s.id) as started
  from seasons s where s.name = 'Fall 2026';"
```

Expected: `dow = Tue`, `days_out` between 9 and 15, **`started = f`**.

- [ ] **Step 3: Verify no literal year survives in any date**

Spec success criterion 1. Season NAMES keep their year deliberately; no date or
timestamp may.

```bash
grep -nE "date '20[0-9]{2}|timestamptz '20[0-9]{2}" supabase/seed.sql || echo "CLEAN"
```

Expected: `CLEAN`. Any hit is a date the conversion missed.

- [ ] **Step 4: Commit**

```bash
git add supabase/seed.sql
git commit -m "test(seed): the fall season is always ahead of the clock"
```

---

### Task 4: The three specs stop restating the date

**Files:**

- Modify: `e2e/11-schedule-builder.spec.ts` (6 `fill()` calls at 214, 257, 280, 357, 401, 516)
- Modify: `e2e/23-schedule-constraints.spec.ts:33`
- Modify: `e2e/28-schedule-form-state.spec.ts:99` and `:105`

**Interfaces:**

- Produces: a helper `fallStart(): Promise<string>` in each spec, returning `starts_on` as `YYYY-MM-DD`. Copied into each file, **not** imported — relative TS imports between specs do not load under this Playwright version (measured 2026-09-06; see `30-`'s header).

- [ ] **Step 1: Add the helper to each of the three specs**

```ts
/**
 * The seeded Fall season's first night, read from the database.
 *
 * ⛔ NEVER RESTATE THIS DATE. It used to be `const FIRST_NIGHT = "2026-09-15"`,
 * which was the seed's own literal — and on 2026-09-16 that season would have
 * STARTED, locking the builder and falsifying this spec's premise. The seed owns
 * the date; a spec that repeats it can disagree with the fixture it runs against.
 */
async function fallStart(): Promise<string> {
  const { data } = await admin()
    .from("seasons")
    .select("starts_on")
    .eq("name", "Fall 2026")
    .single();
  return data!.starts_on as string;
}
```

⚠️ `11-` may not have an `admin()` helper. If not, copy the one from
`e2e/30-schedule-edits.spec.ts:17-23` verbatim into it.

- [ ] **Step 2: Replace the six `fill()` calls in `11-`**

Each becomes:

```ts
await page.getByLabel("First game night").fill(await fallStart());
```

- [ ] **Step 3: Replace the constants in `23-` and `28-`**

Delete `const FIRST_NIGHT = "2026-09-15";` from both and replace each use with `await fallStart()`. ⚠️ Both files use `FIRST_NIGHT` inside `test()` bodies, so `await` is legal at every site — check each with grep before editing:

```bash
grep -n "FIRST_NIGHT" e2e/23-schedule-constraints.spec.ts e2e/28-schedule-form-state.spec.ts
```

- [ ] **Step 4: Fix `28-`'s SKIP_DAY, which is a weekday in disguise**

`const SKIP_DAY = "24"` is a **day-of-month that must be a Thursday inside the Fall window**. With a moving anchor, 24 is a Thursday roughly one year in seven.

```ts
/**
 * A Thursday inside the season, skipped — far enough out not to starve it.
 *
 * ⛔ COMPUTED, BECAUSE "24" WAS ONLY A THURSDAY IN 2026. This is a day-of-month
 * typed into a date picker, and the test's meaning depends on the weekday it
 * lands on, not on the number.
 */
async function skipDay(): Promise<string> {
  const start = new Date(`${await fallStart()}T12:00:00Z`);
  const d = new Date(start);
  d.setUTCDate(d.getUTCDate() + 14); // well inside the window
  while (d.getUTCDay() !== 4) d.setUTCDate(d.getUTCDate() + 1); // 4 = Thursday
  return String(d.getUTCDate());
}
```

Replace `SKIP_DAY` with `await skipDay()` at both use sites (`:105` declaration, `:134` filter).

- [ ] **Step 5: Verify no pinned date survives**

```bash
grep -rn "2026-09-15" e2e/ src/ supabase/ || echo "CLEAN"
```

Expected: `CLEAN`, or matches only inside comments that describe the old bug.

- [ ] **Step 6: Run the three specs**

Run: `PORT=3117 scripts/e2e-locked.sh e2e/11-schedule-builder.spec.ts e2e/23-schedule-constraints.spec.ts e2e/28-schedule-form-state.spec.ts`

Expected: all green.

- [ ] **Step 7: Commit**

```bash
git add e2e/11-schedule-builder.spec.ts e2e/23-schedule-constraints.spec.ts e2e/28-schedule-form-state.spec.ts
git commit -m "test: read the fall season's date from the seed instead of restating it"
```

---

### Task 5: The two specs that pin 2027

**Files:**

- Modify: `e2e/14-one-off-game.spec.ts`, `e2e/29-schedule-repair.spec.ts`

- [ ] **Step 1: Find every pinned year**

```bash
grep -n "2027\|2028" e2e/14-one-off-game.spec.ts e2e/29-schedule-repair.spec.ts
```

- [ ] **Step 2: Replace with a computed year, matching `30-`**

```ts
/**
 * ⛔ COMPUTED, NEVER PINNED. This spec seeded `One-Off Test 2027` at a literal
 * 2027-01-05 and would have broken in January 2027 exactly as `11-` was about to
 * break in September 2026. Same defect, further out.
 */
const YEAR = new Date().getUTCFullYear() + 2;
const SEASON = `One-Off Test ${YEAR}`;
const FIRST_NIGHT = `${YEAR}-01-05`;
const SEASON_END = `${YEAR}-06-30`;
```

Use `Repair Test ${YEAR}` in `29-`. ⚠️ Both specs also match their season by name elsewhere — grep for the literal season name and replace every occurrence with the template.

- [ ] **Step 3: Run both specs**

Run: `PORT=3117 scripts/e2e-locked.sh e2e/14-one-off-game.spec.ts e2e/29-schedule-repair.spec.ts`

Expected: green.

- [ ] **Step 4: Commit**

```bash
git add e2e/14-one-off-game.spec.ts e2e/29-schedule-repair.spec.ts
git commit -m "test: compute the one-off and repair season years"
```

---

### Task 6: Prove it cannot expire

**Files:** none — this is verification.

⛔ **THIS TASK IS THE POINT OF THE WHOLE PLAN.** A green suite today proves only
today; that is exactly the failure being fixed. Do not skip it.

- [ ] **Step 1: Full suite, normal clock**

Run: `npm run typecheck && npx vitest run && npx eslint src e2e && PORT=3117 scripts/e2e-locked.sh`

Expected: **221 passed, 1 skipped, 0 failed** (baseline watched 2026-09-07). A different total is fine if explained; a _failure_ is not.

- [ ] **Step 2: Full suite with the clock moved past every old pinned date**

Set the machine clock forward to **2027-06-01** — past `2026-09-15` (the old Fall start) and past `2027-01-05` (the old one-off/repair seasons) — then re-run `npm run db:reset` and the full suite.

⚠️ If changing the machine clock is impractical, do this instead and say so in
the commit: temporarily replace `current_date` in the three anchor expressions
with `date '2027-06-01'`, run `npm run db:reset`, run the full suite, then
revert. It exercises the same arithmetic without touching the system clock.

Expected: same result as Step 1. **A failure here means the fixture still has an expiry and the plan has not succeeded.**

⛔ **AND CHECK THE CLOCKS EXPLICITLY — this is the run that exercises EST.** With
the clock at 2027-06-01, league 1's anchor falls in February, which is EST. If
any `-04` literal survived, every game moved an hour and some crossed onto the
wrong league-local night.

```bash
/opt/homebrew/opt/postgresql@16/bin/psql 'postgresql://postgres:postgres@127.0.0.1:54322/postgres' -c "
select distinct to_char(g.scheduled_at at time zone 'America/Toronto','HH24:MI') as ice_time
  from games g join seasons s on s.id=g.season_id
 where s.name='Spring 2026' order by 1;"
```

Expected, exactly: `19:00`, `20:15`, `21:30` — the same three ice times as under
EDT. Anything else (`18:00`, `20:30`) means a numeric offset survived. This is
spec success criterion 5.

- [ ] **Step 3: Restore the clock and confirm**

Run `npm run db:reset` once more and re-run the three specs from Task 4 to confirm the fixture is back to normal.

- [ ] **Step 4: Record the result**

Append to this plan a short "What was built" section: the two suite results, whether the clock or the substitution route was used, and anything the spec turned out to be wrong about.

- [ ] **Step 5: Commit**

```bash
git add docs/superpowers/plans/2026-09-07-clock-relative-fixture.md
git commit -m "docs: record the clock-forward verification"
```
