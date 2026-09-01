# Per-league URL routing — plan & handoff

**Protocol — read this and nothing else to resume.**

1. This file is self-contained. **Do NOT read** `SCHEDULE_HANDOFF.md` (348 lines),
   `EXPORTS_HANDOFF.md` (264), or `docs/superpowers/{specs,plans}/` (4,469 total).
   `AGENTS.md` points at all of them prominently and none touches routing.
   Read `AGENTS.md` itself (~25 lines) and this file (382). Budget ~410 lines,
   checked after writing — not an estimate.
2. ⛔ **Three irreversible hazards, before any instruction:**
   - `npx supabase db reset --linked` **wipes the production database.** It also
     **re-seeds demo data** unless you pass `--no-seed` — `supabase/config.toml:66-71`
     has `[db.seed] enabled = true`. The reset does **not** delete `auth.users`:
     `manager@obhl.test` / `scorekeeper@obhl.test` / `captain@obhl.test` survive it
     with password `hockey123` (`scripts/seed-users.mjs:37`). Delete them by hand.
   - Once a published game's `scheduled_at` passes, `season_is_started`
     (`supabase/migrations/0026_replace_published_schedule.sql:24`) **permanently**
     locks schedule generate/replace/remove for that season. No UI undoes it.
   - There is **no UI to delete a league or a season.** Cleanup is hand-written SQL.
3. Every count below was **measured** on 2026-08-31 (grep/wc, watched appear).
   Design claims about Next 16 behaviour are **readings** of
   `node_modules/next/dist/docs/` and are labelled where they matter.
4. Verify with: `npm test && npm run test:e2e`. Baseline today: green, and
   `git status --porcelain` is empty.

**Status: design approved section-by-section, nothing implemented.** Working tree
clean, no branch, no commits. Three `/refine-plan` passes applied (see Provenance).
The spec was never written to `docs/superpowers/specs/` — plan mode blocked it.

## Blast radius (measured 2026-08-31)

| Thing | Count | Where |
|---|---|---|
| `revalidatePath` calls | **59** | 11 files in `src/lib/actions/` |
| Guard call sites (`requireManager`/`requireRole`/`requireUser`) | **78** | 23 files, excl. `auth/guards.ts` |
| e2e URL references | **69**, of which **50** need a league prefix | 14 specs + `global-setup.ts` |
| `href` sites | **20** static + **20** template-literal | across `src/**/*.tsx` |

## Context

Two real leagues go live with seasons starting ~mid-September 2026. Each league's
website is shared separately with that league's players; the overwhelming majority
of people care about exactly one league.

The current public site cannot support that. Every public route is
**cookie-switched**: `resolveCurrentLeague` (`src/lib/league/current.ts:18`) reads
the `obhl_league` cookie and falls back to the oldest public league. Hand League
Two's players `site.com/standings` and they land on League One.

This change puts the league in the URL — `/harbor/standings`,
`/harbor/manage/seasons` — for both the public site and the staff tools, and
retires the cookie. Three things fall out of it:

- Shareable, deep-linkable per-league URLs, which is the actual requirement.
- The cross-tab hazard documented at `src/lib/actions/schedule.ts:28-36` dies:
  with no global cookie, a second tab can't retarget a form in the first.
- A league can be **staged privately**. Today `resolveCurrentLeague` filters
  `is_public = true` in both branches, so a non-public league is invisible to the
  manage tools too. After this change a league is manageable before it is public.

## Launch sequence

Routing is **not** on the critical path; the schedule is (hazard 2 above).

1. Bootstrap production: `npx supabase db reset --linked --no-seed`, delete the
   `@obhl.test` auth users, enable the Custom Access Token hook in the dashboard
   (**without it `getSessionUser` returns `role: null` for everyone and nobody can
   reach the manage tools** — the role comes only from the JWT claim,
   `src/lib/auth/session.ts:19-26`), set Site/redirect URLs, seed the manager.
2. Create both leagues (SQL — no UI), seasons, teams, rosters. **Publish both
   schedules** on the current routes.
3. Land this change (Steps A→C), e2e green at each step, then merge.

Nothing here touches game data, so slipping past the first game night costs only
the clean per-league links.

**Pick the two league slugs before creating them** and keep them clear of `login`,
`auth`, `api`, `manage` — the reserved-slug check lands with this work, but the
leagues get created before it does.

## Design

### 1. Route structure

```
src/app/
  page.tsx                        NEW: root landing, league picker
  [league]/
    layout.tsx                    NEW: resolves league, notFound(), generateMetadata
    (public)/
      layout.tsx  page.tsx  loading.tsx
      schedule/  standings/  stats/  rules/
      teams/  teams/[slug]/  players/  players/[playerId]/  games/[gameId]/
    manage/
      layout.tsx
      dashboard/  seasons/  seasons/[seasonId]/  rosters/  rosters/[teamId]/
      schedule-builder/  schedule-builder/one-off/  score/  score/[gameId]/
      people/  announcements/  rules/edit/  import/  audit/
  api/schedule/…                  unchanged
  login/  auth/confirm/           unchanged
```

- `[league]/layout.tsx` resolves once so no page below it needs a null check.
  (*Reading*: `notFound()` "terminates rendering of the route segment in which it
  was thrown" — `docs/01-app/03-api-reference/04-functions/not-found.md`. Valid in
  a layout.)
- `(public)` stays a **route group** (no URL segment) so `/harbor` is the league
  home. `manage` is a **real segment** — this avoids a route conflict between the
  public `/rules` and the manage `/rules/edit`.
- `/login`, `/auth/confirm`, `/api/*` win over `[league]` because static segments
  resolve first — which is also why those slugs must be reserved.
- Root-level `/standings`, `/schedule`, etc. cease to exist. Nothing is shared yet.

### 2. League resolution

Rework `src/lib/league/current.ts`:

- `resolveCurrentLeague(client)` → **`resolveLeagueBySlug(client, slug)`**, wrapped
  in `cache` from `react`. Memoization is **required, not an optimization**: App
  Router layouts can't pass data to pages, so layout and page each resolve
  independently and would otherwise fire 3–4 identical queries per render.
  (*Reading*: `cache` from `react` is the documented dedupe pattern —
  `docs/01-app/01-getting-started/06-fetching-data.md:546-563`.)
- **Lower-case the slug** before lookup so `/Harbor` doesn't 404.
- Resolution is **two-tier on `is_public`**: `[league]/layout.tsx` resolves by slug
  only and 404s on an unknown slug; `(public)/layout.tsx` additionally 404s when
  `!is_public`. This is what enables private staging.
- Keep `getPublicLeagues` for the root landing page; add `getAllLeagues` for the
  manage switcher, or a staged league is unreachable through the UI.
- The landing page needs an **empty state** — on a freshly bootstrapped production
  database it renders before any league exists.
- Delete `LEAGUE_COOKIE`.

`getActiveContext()` (`src/lib/queries/season.ts:16`) takes the resolved league
instead of reading the cookie. Public pages already guard with
`if (!ctx?.season) return <NoSeason />`, so their shape is unchanged.

Manage pages read the league from `params`. `requireManager()` stays role-only —
league-awareness is the next project.

**Per-league metadata.** Add `generateMetadata` to `[league]/layout.tsx` so
`/harbor` carries Harbor's name in title and OG tags. Without it a shared league
link previews as the generic site name. `src/app/layout.tsx:19` keeps `metadataBase`.

**Redirect targets — all three must move together.** `/dashboard` no longer exists
at the root, and none of these callers can know which league the user wants, so all
three go to `/`:

- `src/app/auth/confirm/route.ts:22-23` — the default `next` **and** the sanitizing
  fallback. This is the production sign-in path; missing it means every magic-link
  sign-in lands on a 404.
- `src/lib/actions/auth.ts:63` — dev quick sign-in.
- `src/lib/auth/guards.ts:14` — role-denied redirect.

`redirect("/login")` is unchanged. The "Your account has no role yet" empty state
stays on the league dashboard (`dashboard/page.tsx:38-43`).

**Reserved slugs:** reject `login`, `auth`, `api`, `manage` where leagues are
created — `runEsportsdeskImport` (`src/lib/actions/import.ts`) — and document it for
manual SQL inserts, since there is no league-creation UI.

**Slugs are permanent public identifiers.** Renaming a league changes its slug and
breaks every link already shared. Treat slug changes as a migration, not an edit.

**Known limitation, not addressed:** `format.ts` has a module-level `LEAGUE_TZ` that
`leagueOffset` reads — one timezone for the whole instance.

### 3. Cache invalidation

59 `revalidatePath` calls across 11 files in `src/lib/actions/`, all hardcoding
root-relative paths. Mechanical, but sizeable.

**Calibrate the risk before spending effort here.** `createClient()` awaits
`cookies()` (`src/utils/supabase/server.ts:10`) and every page reaches it — public
pages through `getActiveContext`, manage pages through `requireManager`. So every
page is **already dynamically rendered**: there is no Full Route Cache to
invalidate. What `revalidatePath` still does in a Server Action is purge the client
Router Cache, which matters for post-mutation freshness but degrades gracefully — a
refresh fixes a stale view. Treat this as correctness-of-convention, not a hazard.

**Use route patterns with `type: "page"`, not literal slugs.** (*Reading*:
`docs/01-app/03-api-reference/04-functions/revalidatePath.md` — a pattern plus
`type` refreshes all matching pages.)

```ts
revalidatePath("/seasons")            →  revalidatePath("/[league]/manage/seasons", "page")
revalidatePath(`/seasons/${id}`)      →  revalidatePath("/[league]/manage/seasons/[seasonId]", "page")
```

This needs **no slug threaded into any action** — actions hold `season_id` /
`team_id` / `game_id`, never a slug. A write in one league also invalidates the
other's copy: one extra regeneration, negligible given the above.

Four cases need judgment rather than mechanical translation:

- **`revalidatePath("/")` is overloaded.** Most calls mean the *league* homepage
  (announcements, schedule changes, game finalization) → `/[league]`. Only league
  creation/rename affects the new root landing page and stays `/`.
- **`revalidatePath("/", "layout")`** (`seasons.ts:193`, `import.ts:253,343,351`)
  → `revalidatePath("/[league]", "layout")`.
- **`PUBLIC_PATHS`** (`games.ts:14`) →
  `["/[league]", "/[league]/standings", "/[league]/stats", "/[league]/schedule"]`,
  each with `type: "page"`.
- **`selectLeague`'s invalidation disappears** with the cookie.

Add a Vitest test scanning `src/lib/actions/*.ts` asserting every `revalidatePath`
argument begins with `/[league]` or is on a short root allowlist. This is a
**convention guard** — it catches a missed edit during the sweep, not a bug class.

### 4. Switcher and cookie retirement

- **Delete** `src/lib/actions/league.ts` (`selectLeague`) entirely.
- `src/components/shared/league-switcher.tsx` stops posting a form and becomes
  navigation. **A switch always lands on the league root** — `/oceanview` publicly,
  `/oceanview/manage/dashboard` in staff — never the equivalent sub-path, which
  would 404 on `/harbor/teams/sharks` or `/harbor/manage/seasons/<uuid>`.
- **Drop the switcher from the public header** (`src/components/shared/site-header.tsx`).
  Leave a quiet "all leagues" link back to `/`.
- **Keep the manage switcher** in `src/components/manage/manage-nav.tsx`.
- `src/components/shared/nav-links.tsx` needs **more than an href prefix**. It is a
  client component deriving active state from `usePathname`:
  `link.href === "/" ? pathname === "/" : pathname.startsWith(link.href)`. Both
  branches break under `/[league]/…` — the league home is `/harbor`, not `/`, and
  `startsWith("/standings")` never matches `/harbor/standings`. It also needs the
  slug **as a prop** from the server layout, since a client component can't call the
  resolver. Prefixing hrefs alone ships a nav where nothing highlights.

> ⚠️ **Trap — BOTH headers carry a measured layout comment.** Same class of fix,
> recorded in two places; the plan originally warned about only one.
>
> **`site-header.tsx:23-30`** (public): `min-w-0` lets the right-hand cluster give
> way, and **the league switcher is deliberately the element that shrinks and
> ellipsises** so nav links aren't cut off — "pinned, it left the bar 35px over its
> box just as the nav links appear at `md`." That is commit `be1845f`. Removing the
> switcher removes that shrinking element, so its replacement must occupy similar
> width with the same shrink behaviour, or re-measure.
>
> **`manage-nav.tsx:33-52`**: the inline nav's width budget assumes the switcher is
> present and shrinking, which keeps the manager's 10 links intact down to `md`.
> Keep it roughly the same footprint or re-measure per that file's instructions.

Manage nav links (`manage-nav.tsx:14-31`) all gain the `/[league]/manage` prefix, as
do the 40 `href` sites across the page components.

### 5. Testing

**The e2e suite is the safety net and the bulk of the test work.** 14 specs plus
`global-setup.ts`; 50 of 69 URL references gain a league prefix. Update them
*within* each step below, not in a sweep at the end.

**`e2e/09-access.spec.ts` is the exception**: it asserts role-denial *behaviour*,
and Step B changes that redirect target from `/dashboard` to `/`. It needs a logic
change, not a path prefix — prefixing it mechanically produces a failure that looks
like a routing bug and isn't.

New unit tests (pure, matching the existing Vitest pattern): the `revalidatePath`
scanner; reserved-slug rejection; `resolveLeagueBySlug` two-tier `is_public`
behaviour and slug lower-casing.

New e2e coverage for failure modes this change creates:

- unknown slug → 404
- non-public league → 404 at `/harbor`, reachable at `/harbor/manage/dashboard`
- **leagues don't bleed** — `/harbor/standings` ≠ `/oceanview/standings`. The seed
  creates two leagues, so this is testable immediately and is the most valuable new
  test here.
- switcher lands on league root
- magic-link / dev sign-in lands on `/`, not a 404

## Execution

Three steps, each leaving the app working and the suite green. Do not collapse them
— the intermediate states are the point.

**Step A — public routes.**
Add `resolveLeagueBySlug` (+ `cache()`, lower-casing), `[league]/layout.tsx` with
`notFound()` and `generateMetadata`, and the root landing page. Move `(public)/*`
under `[league]/(public)/`. Rewrite the public `revalidatePath` calls and
`PUBLIC_PATHS`. Rework `nav-links.tsx` (hrefs **and** active state). Update public
e2e specs.
**Remove `LeagueSwitcher` from `site-header.tsx` in this step, not Step C** — once
public routes carry the slug, the cookie it writes is no longer read by any public
page, so leaving it ships a control that silently does nothing. Heed the
`site-header.tsx:23-30` trap above; re-check the bar at `md`.
Manage is untouched and keeps working on `resolveCurrentLeague` — the two resolvers
coexist through this step, deliberately. The manage switcher still sets the cookie,
so manage league-switching keeps working.
*Done when:* public specs green, `/obhl` and `/harbor` show different data, manage
tools still function unchanged.

**Step B — manage routes.**
Move `(manage)/*` to `[league]/manage/*`. Fix the three `/dashboard` redirects.
Rewrite the manage `revalidatePath` calls. Update `manage-nav.tsx` links and manage
e2e specs, including the `09-access.spec.ts` logic change.
*Done when:* full e2e suite green, sign-in lands on `/`, nothing resolves at the old
root paths.

**Step C — retire the cookie.**
Delete `src/lib/actions/league.ts` and `LEAGUE_COOKIE`, remove
`resolveCurrentLeague`, rework `league-switcher.tsx` to navigate, add
`getAllLeagues` for the manage switcher. Add the reserved slug check.
*Done when:* no reference to `obhl_league` remains, switcher navigates to league
roots, manage nav does not overflow at `md`.

## Verification

```bash
npm run db:reset && npm run seed:users   # local, two seeded leagues
npm test                                 # unit incl. scanner + slug tests
npm run test:e2e                         # 14 specs + global-setup
npm run dev
```

Then by hand, against the seeded `obhl` and `harbor` leagues:

1. `/` lists both leagues; each card links to its league.
2. `/obhl/standings` and `/harbor/standings` show different tables.
3. `/nope` 404s; `/OBHL` resolves (case-insensitive).
4. Set `harbor` to `is_public = false` in SQL: `/harbor` 404s,
   `/harbor/manage/dashboard` still loads. Restore it.
5. Sign out, sign in via the dev panel → lands on `/`, not a 404. With Mailpit
   running, repeat with a real magic link to exercise `auth/confirm/route.ts`.
6. Public league pages have no switcher, only an "all leagues" link; league name in
   `<title>`. **Narrow through `md`** — header must not overflow (`be1845f`), and
   the active nav link must highlight on every page.
7. Manage switcher moves between `/obhl/manage/dashboard` and
   `/harbor/manage/dashboard`; manage nav does not overflow at `md`.
8. Edit an announcement in one league; that league's home reflects it.
9. `/api/schedule/team/<teamId>/feed.ics` still resolves — API routes are keyed by
   id and unchanged.

## Carried findings — NOT part of this project

These surfaced while designing and must not be lost. None is fixed.

**`saveRules` writes the wrong league's rules.** `src/lib/actions/rules.ts:12-17`
does not use `resolveCurrentLeague`; it does
`.from("leagues").select("id").order("created_at", {ascending:true}).limit(1).single()`
— always the **oldest** league. Invisible with one league. With two, a manager
switched to the second league who edits rules silently overwrites the first
league's. Made worse by `league_rules` (`0006_rules.sql`) keeping **no history** and
`saveRules` being the only manage action that never calls `logAudit` — so the
overwrite is both unrecoverable and untraceable. Folds naturally into Step B, since
it needs the same league resolution.

**People & Roles is global and can hard-delete accounts.** `PeoplePage` lists every
profile with no league filter, and `removeStaff` (`src/lib/actions/people.ts:72-78`)
calls `admin.auth.admin.deleteUser(id)`. Any manager can delete or re-role any
other, including you. Interim guard (~20 lines, no schema change): refuse when the
target's role is `league_manager`. Worth doing **before** handing out manager
accounts, independently of the access-control project.

**Next project — per-league access control.** Decided, not built:
managers grant access only within leagues they already belong to (no superadmin
tier); `players` stays globally writable with scoping riding on `team_players`;
captains are already correctly scoped via `team_players` → season → league, so
captain accounts are safe to hand out now. A person may be manager *and* captain —
this needs **no** multi-role model, because manager write access is a superset;
what it needs is to stop `people.ts:48,66` nulling `player_id` for non-captain
roles, and to derive the captain UI surfaces (`dashboard/page.tsx:93`,
`score/[gameId]/page.tsx:83`) from the player link rather than `role === "captain"`.
Model is therefore `profile_leagues(profile_id, league_id)` — membership only, role
enum and JWT hook untouched. Until it lands: you are sole manager, captain-only
accounts for everyone else.

## Provenance

Designed 2026-08-31 via `superpowers:brainstorming` (architectural path), then three
`/refine-plan` passes. Decisions taken, in order: path-prefix URLs over
subdomains/separate domains; **both** public and manage move (user chose this over
the recommended public-only, accepting the larger pre-launch scope);
`/harbor/manage/…` shape; drop the public switcher, keep the manage one.

Refinement passes found, in order: (1) magic-link sign-in redirecting to a deleted
`/dashboard`, and no execution sequencing — both applied; (2) Step A shipping a
dead public switcher, and `09-access.spec.ts` needing logic not prefixes — applied;
(3) the `site-header.tsx` measurement trap and `nav-links.tsx` active-state
breakage — applied. Passes 2 and 3 found things only by **opening files** rather
than reasoning about them.

**First action on resuming:** write this design to
`docs/superpowers/specs/2026-08-31-per-league-routing-design.md` and commit it —
`AGENTS.md` says design docs live there, and plan mode blocked writing it.
