# Audit follow-through, part 1: security fixes and feature removals

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the profile self-promotion hole and three smaller access bugs, then delete the esportsdesk full migration and the AI recap/summary features.

**Architecture:** One migration adds a trigger that refuses changes to `profiles.role` and `profiles.player_id` from a user session (every legitimate write already goes through the service-role admin client). Three server actions get a check each. The two removals delete code paths end to end — action, UI, tests, docs — while the full e2e suite still exists to catch breakage. The test rebuild (option B) and the code/comment/doc trims are part 2 and part 3, planned after this merges.

**Tech Stack:** Next.js 16 App Router (read `node_modules/next/dist/docs/` before touching a Next API), Supabase Postgres + RLS, Vitest 4, Playwright.

**Spec:** The audit and decisions in the session of 2026-09-13. The owner chose: fix security first; remove the full importer; remove the AI recap and league summary; then rebuild tests for a finished app.

## Global Constraints

- Work only in this worktree: `/Users/richardkarp/dev/obhl/.claude/worktrees/audit-security-and-removals`, branch `worktree-audit-security-and-removals`. Never `git -C` the main checkout. Never bare `git stash`.
- **Commit only when the owner has approved committing on this branch.** Push and PR only when asked.
- Next migration number is `0050`. Do not edit an existing migration.
- ⛔ Nothing with `--linked` or `db push`: those touch production. The owner pushes `0050` after merge.
- e2e runs reset the ONE local database every worktree shares. Always run e2e through `PORT=3101 scripts/e2e-locked.sh <specs>`, never `npx playwright test` directly.
- An RLS-refused UPDATE reports no error. Assert on the row read back through the admin client, never on `error`.
- Do not add `OBHL_SLOT_RESTARTS` or any search constant to a test config.
- Keep the `ai_recap` and `ai_summary` columns. Dropping them needs deploy-then-push ordering, or the live public home page breaks; they are empty in production. Out of scope.

---

### Task 1: A user session cannot write `profiles.role` or `profiles.player_id`

**Files:**
- Create: `supabase/migrations/0050_profile_privileged_columns.sql`
- Modify: `e2e/16-league-membership.spec.ts` (add one test after the test named `a session cannot mint a manager of another league through the API`)

**Interfaces:**
- Produces: trigger `profiles_privileged_columns_are_server_only` on `public.profiles`. Later tasks rely on service-role writes to these columns still succeeding.

**Background (verified 2026-09-13 on the local stack):** policy `"own profile update"` (`0009_rls_roles.sql:115`) is `for update using (id = auth.uid())` with no column restriction. Signed in as the scorekeeper, `update profiles set role='league_manager' where id=auth.uid()` returned `UPDATE 1`, `auth_role()` became `league_manager`, and the same session could then update 5 other profiles. Setting one's own `player_id` to a captain's player also makes `is_captain_of` (`0038`) true.

- [ ] **Step 1: Write the failing e2e test**

Insert into `e2e/16-league-membership.spec.ts`, directly after the test `a session cannot mint a manager of another league through the API` ends:

```ts
  test("a session cannot rewrite its own role or player link through the API", async () => {
    // 0009's "own profile update" names no columns, so before 0050 any signed-in
    // account could make itself a league manager, or link itself to another
    // league's captain. Measured on the local stack 2026-09-13.
    const db = admin();
    const { data: self } = await db
      .from("profiles")
      .select("id, role, player_id")
      .eq("display_name", "Single League Scorer")
      .single();
    const { data: players } = await db.from("players").select("id").limit(2);
    const other = (players ?? []).find((p) => p.id !== self!.player_id)!;

    const client = await signedInClient("single-league-scorer@obhl.test");
    try {
      await client
        .from("profiles")
        .update({ role: "league_manager" })
        .eq("id", self!.id);
      await client
        .from("profiles")
        .update({ player_id: other.id })
        .eq("id", self!.id);

      // Read the ROW, not the error — a refused write must leave it as it was.
      const { data: after } = await db
        .from("profiles")
        .select("role, player_id")
        .eq("id", self!.id)
        .single();
      expect(after!.role).toBe(self!.role);
      expect(after!.player_id).toBe(self!.player_id);
    } finally {
      // Service role: allowed by 0050, and restores the fixture if the test
      // ran red.
      await db
        .from("profiles")
        .update({ role: self!.role, player_id: self!.player_id })
        .eq("id", self!.id);
      await client.auth.signOut();
    }
  });
```

- [ ] **Step 2: Run it and watch it fail**

Run: `PORT=3101 scripts/e2e-locked.sh e2e/16-league-membership.spec.ts -g "rewrite its own role"`
Expected: FAIL at `expect(after!.role).toBe(self!.role)` — received `league_manager`, expected `scorekeeper`.

- [ ] **Step 3: Write the migration**

Create `supabase/migrations/0050_profile_privileged_columns.sql`:

```sql
-- A signed-in session may not change its own role or player link.
--
-- ⛔ 0009's "own profile update" is `using (id = auth.uid())` with no column
-- list, so any account — the shared scorekeeper login included — could run
-- `update profiles set role = 'league_manager' where id = auth.uid()`. RLS
-- applied it at once, and the JWT hook copied it at the next refresh. Setting
-- `player_id` the same way made `is_captain_of` (0038) true for another
-- league's team. Reproduced on the local stack 2026-09-13.
--
-- Every legitimate write to these columns is a server action on the service-role
-- client (people.ts, seasons.ts, players.ts), so refusing the user-facing roles
-- outright costs nothing. `display_name` stays writable by its owner.
--
-- ⚠️ SECURITY INVOKER ON PURPOSE. `current_user` must be the caller's role; a
-- SECURITY DEFINER trigger would see its owner and let everything through.
create or replace function public.profiles_privileged_columns_are_server_only()
returns trigger language plpgsql set search_path = public as $$
begin
  if current_user not in ('authenticated', 'anon') then
    return new;
  end if;
  if tg_op = 'INSERT' then
    if new.role is not null or new.player_id is not null then
      raise exception 'profiles.role and profiles.player_id are set by the server only'
        using errcode = 'insufficient_privilege';
    end if;
  elsif new.role is distinct from old.role
     or new.player_id is distinct from old.player_id then
    raise exception 'profiles.role and profiles.player_id are set by the server only'
      using errcode = 'insufficient_privilege';
  end if;
  return new;
end $$;

create trigger profiles_privileged_columns_are_server_only
  before insert or update on profiles
  for each row execute function public.profiles_privileged_columns_are_server_only();
```

- [ ] **Step 4: Run the test again and watch it pass**

Run: `PORT=3101 scripts/e2e-locked.sh e2e/16-league-membership.spec.ts -g "rewrite its own role"`
Expected: PASS. `global-setup` runs `db reset`, which applies `0050` from this worktree.

- [ ] **Step 5: Prove the trigger at the SQL level too**

Run:
```bash
docker exec -i supabase_db_obhl psql -U postgres <<'SQL'
select id as sk_id from profiles p join auth.users u on u.id = p.id where u.email = 'scorekeeper@obhl.test' \gset
begin;
set local role authenticated;
select set_config('request.jwt.claims', json_build_object('sub', :'sk_id', 'role', 'authenticated')::text, true);
update profiles set display_name = display_name where id = auth.uid();
update profiles set role = 'league_manager' where id = auth.uid();
rollback;
SQL
```
Expected: the `display_name` update prints `UPDATE 1`; the role update prints `ERROR:  profiles.role and profiles.player_id are set by the server only`.

- [ ] **Step 6: Run the rest of the access specs that write profiles through the app**

Run: `PORT=3101 scripts/e2e-locked.sh e2e/08-people.spec.ts e2e/16-league-membership.spec.ts e2e/20-league-office.spec.ts`
Expected: all pass. A failure naming `set by the server only` means an app path writes these columns on a user client — stop and report it; do not loosen the trigger.

- [ ] **Step 7: Commit (only if approved)**

```bash
git add supabase/migrations/0050_profile_privileged_columns.sql e2e/16-league-membership.spec.ts
git commit -m "fix(rls): a session cannot change its own role or player link"
```

---

### Task 2: A captain email cannot demote or hijack an existing account

**Files:**
- Modify: `src/lib/actions/seasons.ts` (import line for `@/lib/auth/membership`; the captain block in `createTeamForSeason`, between the `if (!userId) { … }` exit and the `admin.from("profiles").upsert(` call)
- Test: `src/lib/actions/seasons.test.ts`

**Interfaces:**
- Consumes: `mayWriteProfileOf(actorId: string, profileId: string): Promise<boolean>` from `@/lib/auth/membership`.

**Background:** when the email belongs to an existing account, `createTeamForSeason` upserts `{ role: "captain", player_id, display_name }` on the admin client. Typing the scorekeeper's or a manager's address demotes that account in every league. `createStaffAccount` (`people.ts`) already refuses exactly this; this task mirrors it.

- [ ] **Step 1: Teach the test fake to record calls and mock the new dependency**

In `src/lib/actions/seasons.test.ts`:

1. Next to `const addMembership = …` add:
```ts
const mayWrite = vi.fn<() => Promise<boolean>>();
/** Every `"<table>.<verb>"` the fake resolved, in order. */
let calls: string[] = [];
```
2. Change the membership mock to:
```ts
vi.mock("@/lib/auth/membership", () => ({
  addLeagueMembership: () => addMembership(),
  mayWriteProfileOf: () => mayWrite(),
}));
```
3. In the fake's `then(resolve)`, as its first line: `calls.push(\`${q.table}.${q.verb}\`);`
4. In `beforeEach`, add `calls = [];` and `mayWrite.mockResolvedValue(true);`.

- [ ] **Step 2: Write the failing tests**

Append inside `describe("createTeamForSeason", …)`:

```ts
  it("leaves an existing staff account's role alone", async () => {
    createUser.mockResolvedValue({
      data: null,
      error: { message: "email address already registered" },
    });
    findUser.mockResolvedValue("existing-user");
    responses["profiles.select"] = { data: { role: "scorekeeper" }, error: null };
    const r = await run();
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/^Added Otters with captain Ada Lovelace/);
    expect(r.message).toMatch(/already has an account as scorekeeper/);
    expect(calls).not.toContain("profiles.upsert");
    expect(addMembership).not.toHaveBeenCalled();
  });

  it("does not relink a captain account the manager cannot write", async () => {
    createUser.mockResolvedValue({
      data: null,
      error: { message: "email address already registered" },
    });
    findUser.mockResolvedValue("existing-user");
    responses["profiles.select"] = { data: { role: "captain" }, error: null };
    mayWrite.mockResolvedValue(false);
    const r = await run();
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/in a league you don't manage/);
    expect(calls).not.toContain("profiles.upsert");
  });
```

- [ ] **Step 3: Run them and watch them fail**

Run: `npx vitest run src/lib/actions/seasons.test.ts`
Expected: the two new tests FAIL (`r.ok` is `true`); the existing 7 pass.

- [ ] **Step 4: Implement**

In `src/lib/actions/seasons.ts`, change the membership import to:
```ts
import { addLeagueMembership, mayWriteProfileOf } from "@/lib/auth/membership";
```

Insert immediately before `const { error: profErr } = await admin.from("profiles").upsert({`:

```ts
      // An existing account keeps its role: `profiles.role` is account-wide, so
      // writing "captain" here would demote a manager or scorekeeper in every
      // league they work. Same rule as `createStaffAccount` in people.ts.
      if (uErr) {
        const { data: existing } = await admin
          .from("profiles")
          .select("role")
          .eq("id", userId)
          .maybeSingle();
        const refusal =
          existing?.role && existing.role !== "captain"
            ? `${captainEmail} already has an account as ${existing.role.replace("league_", "")}, and a role is account-wide, so it was left unchanged`
            : !(await mayWriteProfileOf(manager.id, userId))
              ? `${captainEmail} already has an account in a league you don't manage, so it was left unchanged`
              : null;
        if (refusal) {
          revalidatePath("/[league]/seasons/[seasonId]", "page");
          return {
            ok: false,
            message: `Added ${name} with captain ${captainName}, but ${refusal}.`,
          };
        }
      }
```

- [ ] **Step 5: Run the tests and watch them pass**

Run: `npx vitest run src/lib/actions/seasons.test.ts`
Expected: 9 passed.

- [ ] **Step 6: Commit (only if approved)**

```bash
git add src/lib/actions/seasons.ts src/lib/actions/seasons.test.ts
git commit -m "fix(seasons): a captain email never rewrites an existing account"
```

---

### Task 3: A staff account can only be linked to a player in this league

**Files:**
- Modify: `src/lib/actions/people.ts` (imports; `createStaffAccount` right after `const admin = createAdminClient();`)
- Create: `src/lib/actions/people.test.ts`

**Interfaces:**
- Consumes: `leaguesOfPlayer(playerId: string, admin: Admin): Promise<string[]>` from `@/lib/league/of-entity`.

**Background:** the posted `player_id` is never checked. A manager of league A can post a league-B captain's player, and the new account then passes `is_captain_of` for that B team through the database API.

- [ ] **Step 1: Write the failing test**

Create `src/lib/actions/people.test.ts`:

```ts
/**
 * `createStaffAccount` refuses a linked player from another league before it
 * creates any login. The database and auth API are stubbed; this pins the order
 * of the check, not the writes.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const createUser = vi.fn();
const leaguesOfPlayer = vi.fn<() => Promise<string[]>>();

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/auth/guards", () => ({
  requireLeagueManager: () => Promise.resolve({ id: "mgr-1" }),
}));
vi.mock("@/lib/auth/users", () => ({
  findUserIdByEmail: () => Promise.resolve(null),
}));
vi.mock("@/lib/league/of-entity", () => ({
  leaguesOfPlayer: () => leaguesOfPlayer(),
}));
vi.mock("@/utils/supabase/admin", () => ({
  createAdminClient: () => ({ auth: { admin: { createUser } } }),
}));

const form = () => {
  const fd = new FormData();
  fd.set("league_id", "league-a");
  fd.set("email", "new.captain@example.test");
  fd.set("role", "captain");
  fd.set("player_id", "player-1");
  return fd;
};

beforeEach(() => {
  vi.clearAllMocks();
  // Stops the action right after the check, at the first write.
  createUser.mockResolvedValue({ data: null, error: { message: "stop here" } });
});

describe("createStaffAccount", () => {
  it("refuses a player from another league before creating a login", async () => {
    leaguesOfPlayer.mockResolvedValue(["league-b"]);
    const { createStaffAccount } = await import("./people");
    const r = await createStaffAccount(null, form());
    expect(r).toEqual({
      ok: false,
      message: "Pick a player from this league's rosters.",
    });
    expect(createUser).not.toHaveBeenCalled();
  });

  it("goes on to create the login for a player rostered in this league", async () => {
    leaguesOfPlayer.mockResolvedValue(["league-a", "league-b"]);
    const { createStaffAccount } = await import("./people");
    const r = await createStaffAccount(null, form());
    expect(createUser).toHaveBeenCalled();
    expect(r).toEqual({ ok: false, message: "stop here" });
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run src/lib/actions/people.test.ts`
Expected: the first test FAILS (`createUser` was called, result is `stop here`); the second passes.

- [ ] **Step 3: Implement**

In `src/lib/actions/people.ts` add the import:
```ts
import { leaguesOfPlayer } from "@/lib/league/of-entity";
```

In `createStaffAccount`, directly after `const admin = createAdminClient();`:
```ts
  // `is_captain_of` trusts `profiles.player_id`, so a player from another
  // league would hand that league's lineup writes to this account.
  if (playerId && !(await leaguesOfPlayer(playerId, admin)).includes(leagueId)) {
    return { ok: false, message: "Pick a player from this league's rosters." };
  }
```

- [ ] **Step 4: Run it and watch it pass**

Run: `npx vitest run src/lib/actions/people.test.ts`
Expected: 2 passed.

- [ ] **Step 5: Commit (only if approved)**

```bash
git add src/lib/actions/people.ts src/lib/actions/people.test.ts
git commit -m "fix(people): a staff account links only to a player in this league"
```

---

### Task 4: Team logos accept only PNG, JPEG and WebP

**Files:**
- Create: `src/lib/utils/logo-type.ts`, `src/lib/utils/logo-type.test.ts`
- Modify: `src/lib/actions/logos.ts:17-24`, `src/components/manage/logo-upload.tsx:14`

**Interfaces:**
- Produces: `logoFileType(fileName: string): { ext: string; contentType: string } | null`, `LOGO_ACCEPT: string`.

**Background:** the extension and `contentType` come from the browser and go into a public bucket. An `.svg` or a spoofed type can carry script on the Storage origin.

- [ ] **Step 1: Write the failing test**

Create `src/lib/utils/logo-type.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { logoFileType } from "./logo-type";

describe("logoFileType", () => {
  it("maps raster extensions to their content type", () => {
    expect(logoFileType("crest.png")).toEqual({ ext: "png", contentType: "image/png" });
    expect(logoFileType("CREST.JPG")).toEqual({ ext: "jpg", contentType: "image/jpeg" });
    expect(logoFileType("crest.jpeg")).toEqual({ ext: "jpeg", contentType: "image/jpeg" });
    expect(logoFileType("crest.webp")).toEqual({ ext: "webp", contentType: "image/webp" });
  });

  it("refuses anything else, SVG included", () => {
    expect(logoFileType("crest.svg")).toBeNull();
    expect(logoFileType("crest.html")).toBeNull();
    expect(logoFileType("crest")).toBeNull();
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run src/lib/utils/logo-type.test.ts`
Expected: FAIL — cannot resolve `./logo-type`.

- [ ] **Step 3: Implement**

Create `src/lib/utils/logo-type.ts`:

```ts
/**
 * The image types a team logo may be. SVG is left out on purpose: the logos
 * bucket is public, and an SVG can carry script.
 */
const LOGO_TYPES: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
};

export const LOGO_ACCEPT = "image/png,image/jpeg,image/webp";

/** The stored extension and content type for an upload, or null to refuse it. */
export function logoFileType(
  fileName: string,
): { ext: string; contentType: string } | null {
  const dot = fileName.lastIndexOf(".");
  if (dot < 0) return null;
  const ext = fileName.slice(dot + 1).toLowerCase();
  const contentType = LOGO_TYPES[ext];
  return contentType ? { ext, contentType } : null;
}
```

In `src/lib/actions/logos.ts`, add `import { logoFileType } from "@/lib/utils/logo-type";` and replace

```ts
  const ext = (file.name.split(".").pop() || "png").toLowerCase();
  const path = `teams/${teamId}.${ext}`;
```
with
```ts
  const type = logoFileType(file.name);
  if (!type) return;
  const path = `teams/${teamId}.${type.ext}`;
```
and replace `contentType: file.type || "image/png",` with `contentType: type.contentType,`.

In `src/components/manage/logo-upload.tsx`, add `import { LOGO_ACCEPT } from "@/lib/utils/logo-type";` and change `accept="image/*"` to `accept={LOGO_ACCEPT}`.

- [ ] **Step 4: Run it and watch it pass**

Run: `npx vitest run src/lib/utils/logo-type.test.ts`
Expected: 2 passed.

- [ ] **Step 5: Commit (only if approved)**

```bash
git add src/lib/utils/logo-type.ts src/lib/utils/logo-type.test.ts src/lib/actions/logos.ts src/components/manage/logo-upload.tsx
git commit -m "fix(logos): accept only png, jpeg and webp uploads"
```

---

### Task 5: Remove the esportsdesk full migration

**Files:**
- Modify: `src/lib/actions/import.ts` (rewrite), `src/lib/import/esportsdesk.ts`, `src/components/manage/esportsdesk-import.tsx` (rewrite), `src/lib/actions/import-rosters.ts` (two comments), `src/lib/actions/import.test.ts`, `src/lib/actions/league-guards.test.ts`, `e2e/17-roster-import.spec.ts` (rewrite), `AGENTS.md`, `README.md`
- Delete: `src/lib/import/distribute.ts`, `src/lib/import/distribute.test.ts`

**Interfaces:**
- Produces: `previewEsportsdeskImport(_prev, formData): Promise<ImportPreviewState>` where `ImportPreviewState = { ok: true; preview: ParsedLeague; url: string } | { ok: false; message: string } | null` — `gameCount` is gone. `ImportRunState` keeps its shape, and `import-rosters.ts` keeps importing it from `./import`.

**Background (measured):** production's audit log has exactly two `import_league` entries, both `mode: "rosters_only"`. The full path (`runEsportsdeskImport`, schedule and stats scrapers, `distributeStats`) has never run against a real source. Every preview also fetched the esportsdesk schedule page just to count games that rosters-only mode never shows.

- [ ] **Step 1: Rewrite `src/lib/actions/import.ts`**

Replace the whole file with:

```ts
"use server";

import { requireManager } from "@/lib/auth/guards";
import {
  fetchEsportsdeskLeague,
  parseEsportsdeskUrl,
  type ParsedLeague,
} from "@/lib/import/esportsdesk";

export type ImportPreviewState =
  | { ok: true; preview: ParsedLeague; url: string }
  | { ok: false; message: string }
  | null;

/** Fetch + parse an esportsdesk league so the manager can review before importing. */
export async function previewEsportsdeskImport(
  _prev: ImportPreviewState,
  formData: FormData,
): Promise<ImportPreviewState> {
  await requireManager();
  const url = String(formData.get("url") ?? "").trim();
  // The esportsdesk childSeasonID to scrape; empty = the league's current season.
  const sourceSeason = String(formData.get("season") ?? "").trim() || null;
  const ids = parseEsportsdeskUrl(url);
  if (!ids) {
    return {
      ok: false,
      message: "Paste an esportsdesk URL that includes clientID and leagueID.",
    };
  }
  try {
    const preview = await fetchEsportsdeskLeague(
      ids.clientId,
      ids.leagueId,
      sourceSeason,
    );
    if (preview.teams.length === 0) {
      return { ok: false, message: "No teams found at that URL." };
    }
    return { ok: true, preview, url };
  } catch (e) {
    return {
      ok: false,
      message: `Couldn't read from esportsdesk: ${(e as Error).message}`,
    };
  }
}

/**
 * What `runRosterOnlyImport` reports back.
 *
 * ⚠️ `ok: true` IS A PARTIAL SUCCESS. A clean run never returns — it redirects
 * into the league it just made — so this arm means the run finished with
 * something to report: teams or rosters that did not land, or a membership grant
 * that failed. In that last case `canOpen` is false and the page must not offer
 * a link into a league the manager cannot open.
 */
export type ImportRunState =
  | { ok: true; slug: string; canOpen: boolean; message: string }
  | { ok: false; message: string }
  | null;
```

- [ ] **Step 2: Trim `src/lib/import/esportsdesk.ts`**

Delete the `ParsedGame` and `ParsedStat` types, `MONTHS`, `pad2`, `fetchEsportsdeskSchedule` and `fetchEsportsdeskStats` (everything from `export async function fetchEsportsdeskSchedule(` to the end of the file). Then run `npx tsc --noEmit` and `npx eslint src/lib/import/esportsdesk.ts`, and delete any helper they now report unused. Keep `parseEsportsdeskUrl`, `fetchEsportsdeskLeague` and everything they call.

- [ ] **Step 3: Delete the stats distributor**

```bash
git rm src/lib/import/distribute.ts src/lib/import/distribute.test.ts
```

- [ ] **Step 4: Carry the redirect warning into `src/lib/actions/import-rosters.ts`**

Replace the docblock above `export async function runRosterOnlyImport(` with:

```ts
/**
 * Import ONLY teams and players from an esportsdesk season, as the starting
 * draft for a new OBHL season. Positions aren't on esportsdesk (all default to
 * F); goalies are fixed in Rosters afterwards.
 */
```

Replace the comment paragraph that begins `// A clean run ends in the league it just made — see the long note at the tail` (it ends before `// ⚠️ THE GATE IS SHORTER THAN ITS SIBLING'S BY ONE CONJUNCT`) with:

```ts
  // A clean run ends in the league it just made.
  //
  // ⛔ THIS LINE MUST STAY OUTSIDE EVERY `try`. `redirect` works by throwing, so
  // an enclosing `catch` would swallow it and the run would silently fall
  // through — `node_modules/next/dist/docs/01-app/03-api-reference/04-functions/redirect.md`
  // says so twice.
  //
  // `replace`, not the server-action default `push`: leaving the one-shot form
  // in history means Back lands on a blank form for a league that already exists.
```

Then read the `// ⚠️ THE GATE IS SHORTER THAN ITS SIBLING'S…` paragraph that follows. It compares against the deleted importer, so rewrite it to state the gate's two conjuncts on their own terms: no problems and membership granted.

- [ ] **Step 5: Rewrite `src/components/manage/esportsdesk-import.tsx` for rosters only**

Replace the whole file with:

```tsx
"use client";

import { useActionState } from "react";
import Link from "next/link";
import {
  previewEsportsdeskImport,
  type ImportPreviewState,
  type ImportRunState,
} from "@/lib/actions/import";
import { runRosterOnlyImport } from "@/lib/actions/import-rosters";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";

export function EsportsdeskImport() {
  const [preview, previewAction, previewing] = useActionState<
    ImportPreviewState,
    FormData
  >(previewEsportsdeskImport, null);
  const [run, runAction, running] = useActionState<ImportRunState, FormData>(
    runRosterOnlyImport,
    null,
  );
  const completed = run?.ok ? run : null;

  return (
    <div className="space-y-6">
      {/* Step 1 — paste URL, fetch preview */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">1. Source</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <form action={previewAction} className="space-y-2">
            <Label htmlFor="url">esportsdesk league URL</Label>
            <div className="flex gap-2">
              <Input
                id="url"
                name="url"
                required
                placeholder="https://www.esportsdesk.com/leagues/teams.cfm?leagueID=23014&clientID=5727"
              />
              <Button type="submit" disabled={previewing}>
                {previewing ? "Reading…" : "Preview"}
              </Button>
            </div>
            <p className="text-muted-foreground text-xs">
              Any esportsdesk page URL works as long as it has clientID and
              leagueID. Imports the teams and players only — no games, results,
              or stats.
            </p>
            {preview && !preview.ok ? (
              <p
                role="alert"
                aria-live="polite"
                className="text-destructive text-sm"
              >
                {preview.message}
              </p>
            ) : null}
          </form>
        </CardContent>
      </Card>

      {/* Step 2 — review + import */}
      {preview?.ok ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">
              2. Review — {preview.preview.leagueName}
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <p className="text-muted-foreground text-sm">
              {preview.preview.teams.length} teams ·{" "}
              {preview.preview.teams.reduce((n, t) => n + t.players.length, 0)}{" "}
              players
            </p>

            {/* Season picker — for leagues with multiple seasons, reloads the
                preview for the chosen season (esportsdesk childSeasonID). */}
            {preview.preview.seasons.length > 1 ? (
              <form
                action={previewAction}
                className="flex flex-wrap items-end gap-2"
              >
                <input type="hidden" name="url" value={preview.url} />
                <div className="space-y-1">
                  <Label htmlFor="season">Season</Label>
                  <select
                    id="season"
                    name="season"
                    key={preview.preview.season ?? ""}
                    defaultValue={preview.preview.season ?? ""}
                    onChange={(e) => e.currentTarget.form?.requestSubmit()}
                    className="border-input bg-background h-9 rounded-md border px-3 text-sm"
                  >
                    {preview.preview.seasons.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.label}
                      </option>
                    ))}
                  </select>
                </div>
                {previewing ? (
                  <span className="text-muted-foreground pb-2 text-xs">
                    Loading…
                  </span>
                ) : null}
              </form>
            ) : null}

            <div className="divide-y rounded-lg border">
              {preview.preview.teams.map((t) => {
                const caps = t.players.filter((p) => p.isCaptain);
                return (
                  <div
                    key={t.sourceTeamId}
                    className="flex items-center justify-between gap-3 px-3 py-2 text-sm"
                  >
                    <span className="font-medium">{t.name}</span>
                    <span className="text-muted-foreground">
                      {t.players.length} players
                      {caps.length ? (
                        <Badge
                          variant="secondary"
                          className="ml-2 px-1.5 py-0 text-[0.65rem]"
                        >
                          C:{" "}
                          {caps
                            .map((c) => `${c.firstName} ${c.lastName}`)
                            .join(", ")}
                        </Badge>
                      ) : null}
                    </span>
                  </div>
                );
              })}
            </div>

            {completed ? (
              // ⚠️ Only a PARTIAL success lands here: a clean run redirects from
              // the action. This block is the only record of what came up short.
              <div
                role="status"
                aria-live="polite"
                className="space-y-2 rounded-md bg-emerald-50 px-3 py-2 text-sm text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300"
              >
                <p>{completed.message}</p>
                {/* ⛔ No link when the membership grant failed: it would bounce
                    to the picker and read as a broken link. */}
                {completed.canOpen ? (
                  <Link
                    href={`/${completed.slug}/seasons`}
                    className="inline-block font-medium underline underline-offset-2"
                  >
                    Open the new league →
                  </Link>
                ) : null}
              </div>
            ) : (
              <form
                action={runAction}
                className="grid gap-3 sm:grid-cols-2 sm:items-end"
              >
                <input type="hidden" name="url" value={preview.url} />
                <input
                  type="hidden"
                  name="season"
                  value={preview.preview.season ?? ""}
                />
                <div className="space-y-1">
                  <Label htmlFor="league_name">New league name</Label>
                  <Input
                    id="league_name"
                    name="league_name"
                    required
                    defaultValue={preview.preview.leagueName}
                  />
                </div>
                <div className="space-y-1">
                  <Label htmlFor="season_name">Season name</Label>
                  <Input
                    id="season_name"
                    name="season_name"
                    defaultValue="Imported Season"
                  />
                </div>
                <div className="flex items-center gap-3 sm:col-span-2">
                  <Button type="submit" disabled={running}>
                    {running ? "Importing…" : "Import rosters"}
                  </Button>
                  {run && !run.ok ? (
                    <p role="alert" className="text-destructive text-sm">
                      {run.message}
                    </p>
                  ) : null}
                  <span className="text-muted-foreground text-xs">
                    Creates a new inactive league with these teams and players
                    and nothing else. Set any goalie positions in Rosters
                    (esportsdesk rarely records them).
                  </span>
                </div>
              </form>
            )}
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}
```

- [ ] **Step 6: Cut `src/lib/actions/import.test.ts` to the rosters-only importer**

1. Delete the whole `describe("runEsportsdeskImport", …)` block.
2. Delete the `fetchSchedule` and `fetchStats` mocks, their two lines in the `vi.mock("@/lib/import/esportsdesk", …)` factory, and the `ParsedGame`/`ParsedStat` type imports.
3. Run `npx eslint src/lib/actions/import.test.ts`. Delete every declaration it reports unused (expected: `MATCHED_GAME`, `UNMATCHED_GAME`, `matchedStats`, and any schedule/stats-only state in the fake). Repeat until it reports none.
4. Replace the file's header docblock with:
```ts
/**
 * What the rosters-only import REPORTS, and when it redirects instead.
 *
 * ⚠️ The database and the HTML parser are stubbed. This proves which failures
 * get recorded and which block the redirect — nothing about the writes, and
 * nothing about the parser (`esportsdesk.test.ts` covers that).
 */
```

- [ ] **Step 7: Update the guard allowlists in `src/lib/actions/league-guards.test.ts`**

In `ROLE_ONLY_ALLOWED`, change `"import.ts": 2,` to `"import.ts": 1,`. In `NO_LEAGUE_ACTIONS`, delete the `"import.ts:runEsportsdeskImport"` entry. In the docblock above `ROLE_ONLY_ALLOWED`, change "Both importers grant the creating manager membership" to "The importer grants the creating manager membership".

- [ ] **Step 8: Rewrite `e2e/17-roster-import.spec.ts`**

Replace the whole file with:

```ts
/** The new-league page offers the rosters-only esportsdesk import, and nothing else. */
import { test, expect } from "@playwright/test";

test("the new-league page offers a rosters-only import", async ({ page }) => {
  await page.goto("/login");
  await page.getByRole("button", { name: "Manager" }).click();
  await page.waitForURL("/");
  await page.goto("/manage/leagues/new");

  await expect(page.getByLabel("esportsdesk league URL")).toBeVisible();
  await expect(page.getByRole("button", { name: "Preview" })).toBeVisible();
  await expect(page.getByText(/imports the teams and players only/i)).toBeVisible();
  await expect(page.getByText(/full migration/i)).toHaveCount(0);
});
```

- [ ] **Step 9: Update the docs**

In `AGENTS.md`, replace everything from the line starting `⚠️ **The esportsdesk importer has NO automated end-to-end coverage.**` through the line `` `docs/superpowers/specs/2026-09-08-league-creation-at-the-root-design.md`, `` and the `under *Acceptance*.` line after it, with:

```markdown
⚠️ **The esportsdesk importer is rosters-only, and its unit tests stub the
network and the database.** `import.test.ts` proves which failures are reported;
`esportsdesk.test.ts` proves the roster parser against saved HTML. Neither can
see a change in esportsdesk's markup. The one real run (2026-09-09) found a
silent data loss the stubs could not — unnumbered players printed as `-` matched
nothing (fixed in PR #60). Treat a green suite here as saying nothing about a
live source. The full migration (schedule, results, stats) was removed on
2026-09-13; it had never run against a real source.
```

In `README.md`, change `a league from an esportsdesk URL (rosters only, or a full migration with the` and the rest of that sentence to say it imports the teams and players of an esportsdesk league as a new inactive league. Read the full sentence first and keep the grammar of the list item.

- [ ] **Step 10: Verify nothing still references the removed path**

Run: `grep -rn -E 'runEsportsdeskImport|fetchEsportsdeskSchedule|fetchEsportsdeskStats|distributeStats|gameCount|ParsedGame|ParsedStat|full migration' src e2e AGENTS.md README.md`
Expected: no output (`e2e/21-season-gating.spec.ts` mentions only `runRosterOnlyImport`, which is fine).

Run: `npx tsc --noEmit && npx eslint src/lib/actions src/lib/import src/components/manage/esportsdesk-import.tsx e2e/17-roster-import.spec.ts && npx vitest run src/lib/actions/import.test.ts src/lib/import src/lib/actions/league-guards.test.ts`
Expected: no type or lint errors; `import.test.ts` 3 passed, `esportsdesk.test.ts` 5 passed, guards test passes.

- [ ] **Step 11: Run the importer e2e**

Run: `PORT=3101 scripts/e2e-locked.sh e2e/17-roster-import.spec.ts e2e/32-create-league.spec.ts`
Expected: all pass.

- [ ] **Step 12: Commit (only if approved)**

```bash
git add -A src/lib/actions src/lib/import src/components/manage/esportsdesk-import.tsx e2e/17-roster-import.spec.ts AGENTS.md README.md
git commit -m "refactor(import): remove the esportsdesk full migration"
```

---

### Task 6: Remove the AI game recap and league summary

**Files:**
- Modify: `src/lib/actions/games.ts`, `src/lib/actions/seasons.ts`, `src/lib/actions/audit.ts`, `src/lib/queries/games.ts`, `src/app/[league]/(manage)/games/[gameId]/score/page.tsx`, `src/app/[league]/(manage)/seasons/[seasonId]/page.tsx`, `src/app/[league]/(public)/page.tsx`, `src/app/[league]/(manage)/audit/page.tsx`, `src/components/manage/season-switcher.tsx`, `e2e/01-public.spec.ts`, `e2e/03-seasons.spec.ts`, `e2e/05-scoring.spec.ts`, `package.json`, `package-lock.json`

**Interfaces:**
- Removes: `generateGameRecap`, `generateLeagueSummary`, `getLatestGameWithRecapData`, `LatestRecapGame`. Nothing else depends on them.

**Background (measured):** `ANTHROPIC_API_KEY` is not set in Vercel production, so both buttons throw into the error page. Production has 0 games with `ai_recap` and 0 seasons with `ai_summary`. The owner chose removal on 2026-09-13.

- [ ] **Step 1: Delete the actions**

`src/lib/actions/games.ts`: delete the docblock `Generate an AI game recap using Claude…` and the whole `generateGameRecap` function. In the `requireGameRole` docblock, replace ``this is the half that covers the reads, the admin-client write in `generateGameRecap`, and the refusal happening before any work is done.`` with `this is the half that covers the reads and the refusal happening before any work is done.`

`src/lib/actions/seasons.ts`: delete `import Anthropic from "@anthropic-ai/sdk";`, the docblock `Generate an AI league summary using Claude…`, and the whole `generateLeagueSummary` function. Then delete the imports of `getStandings`, `getSkaterLeaders` and `getRecentResults` if `npx eslint src/lib/actions/seasons.ts` reports them unused.

`src/lib/actions/audit.ts`: delete the `case "generate_recap": { … }` block in `revertAuditEntries`.

`src/lib/queries/games.ts`: delete `export type LatestRecapGame` and `export async function getLatestGameWithRecapData`.

- [ ] **Step 2: Delete the UI**

`src/app/[league]/(manage)/games/[gameId]/score/page.tsx`: remove `generateGameRecap,` from the `@/lib/actions/games` import, the `ai_recap,` line from the games select, and the whole `{canManage && game.status === "final" && ( <Card> … AI Game Recap … </Card> )}` block.

`src/app/[league]/(manage)/seasons/[seasonId]/page.tsx`: remove `generateLeagueSummary,` from the `@/lib/actions/seasons` import, change the select to `"id, name, league_id, is_active, starts_on, ends_on"`, and delete the `{/* League summary */}` comment and its `<Card>`.

`src/app/[league]/(public)/page.tsx`: remove the `getLatestGameWithRecapData` import, drop `latestGame` from the `Promise.all` destructure and `getLatestGameWithRecapData(season.id),` from its array, and delete both the `{latestGame?.ai_recap && ( … )}` and `{season.ai_summary && ( … )}` cards.

`src/app/[league]/(manage)/audit/page.tsx`: in `entryLabel`, delete `case "generate_recap":` with its return and `case "generate_summary":` with its return. In `isRevertible`, delete the `case "generate_recap":` line. Old entries, if any, then fall through to the generic label and are not revertible.

`src/components/manage/season-switcher.tsx`: in the docblock, replace `` than the whole row — `ai_summary` alone can be a paragraph of generated prose,
 * and none of it is wanted in the browser. `` with `than the whole row.`

- [ ] **Step 3: Delete the AI e2e tests**

`e2e/01-public.spec.ts`: delete the test `shows the League Update card when an AI summary exists, hides it when null`.
`e2e/03-seasons.spec.ts`: delete the whole `test.describe("Path 8 — AI league summary", …)` block, and change the header docblock to `Path 7: Season setup.`
`e2e/05-scoring.spec.ts`: delete the test `AI game recap card visible on finalized game for manager`.

- [ ] **Step 4: Remove the dependency**

Run: `npm uninstall @anthropic-ai/sdk`
Expected: `package.json` and `package-lock.json` no longer list it.

- [ ] **Step 5: Verify nothing still references it**

Run: `grep -rn -E 'anthropic|Anthropic|ai_recap|ai_summary|generateGameRecap|generateLeagueSummary|LatestRecapGame|AI Game Recap|League Update' src e2e package.json | grep -v 'src/lib/db/types.ts'`
Expected: no output. `types.ts` keeps the columns on purpose (see Global Constraints).

Run: `npx tsc --noEmit && npm run lint && npx vitest run src/lib/actions`
Expected: no type errors, no lint errors, the actions tests pass.

- [ ] **Step 6: Run the touched e2e specs**

Run: `PORT=3101 scripts/e2e-locked.sh e2e/01-public.spec.ts e2e/03-seasons.spec.ts e2e/05-scoring.spec.ts e2e/06-audit.spec.ts`
Expected: all pass.

- [ ] **Step 7: Commit (only if approved)**

```bash
git add -A src e2e package.json package-lock.json
git commit -m "refactor: remove the AI game recap and league summary"
```

---

### Task 7: Whole-branch verification

**Files:** none changed.

- [ ] **Step 1: Static checks and unit suite**

Run: `npm run typecheck && npm run lint && npm test`
Expected: no errors. Unit count = baseline 644 − 18 full-import tests − the `distribute.test.ts` tests + 2 (seasons) + 2 (people) + 2 (logo-type). Take the `distribute.test.ts` count from the baseline log.

- [ ] **Step 2: Production build**

Run: `npm run build`
Expected: success. This is what catches a non-async export from a `"use server"` file.

- [ ] **Step 3: Full e2e once, under the lock**

Run: `PORT=3101 scripts/e2e-locked.sh`
Expected: all pass, except the pre-existing skip count minus the one AI skip. If a failure looks order-dependent (a spec relying on an earlier spec's writes), re-run that spec alone before calling it a regression.

- [ ] **Step 4: Report for the owner**

List: commits made (if approved); unit and e2e counts before and after; and the production step only the owner can take:
1. Merge and let Vercel deploy.
2. Run `npx supabase db push` from the checkout that has the Supabase link. It applies `0050` only.
3. Confirm with `npx supabase db query --linked "select tgname from pg_trigger where tgrelid = 'public.profiles'::regclass and not tgisinternal"` — expect `profiles_privileged_columns_are_server_only` in the list.
