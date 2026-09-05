# One URL per thing — flattening the manage prefix and merging the duplicated pages

**Status:** design approved 2026-09-05, not yet implemented.

## The ask, in the user's words

> "I want B but also is it necessary to have a separate route tree? I'd rather it didn't."
> "merge them into one page, I don't like that there is an extra /manage/ in the url,
> it's something the managers have to remember."

Two goals, and the second is the sharper one: **a manager should never have to know
a URL prefix exists.** A signed-in manager on `/lcc/standings` today sees byte-identical
chrome to an anonymous stranger — no badge, no way back to their tools — and the tools
themselves live behind a prefix and a UUID.

## What makes this cheap, and why the prefix is there at all

⛔ **`manage` is in the URL by accident of a directory name.** `(public)` has
parentheses — a Next.js **route group**, excluded from the URL. `manage` is a plain
directory, so it appears. Renaming the folder to `(manage)` removes the prefix from
every page at once, with no page rewritten and no link logic changed beyond strings.

⚠️ **There are no route collisions today**, because the two trees use different nouns:
`rosters` vs `teams`, `score` vs `games`, `schedule-builder` vs `schedule`. So the
rename is safe on its own. What it exposes is the real problem — *two URLs for the same
thing* — which is what the merges below fix.

## Measured facts (not assumed)

| Fact | Value |
|---|---|
| `/manage` references in `src` | 137, across 45 files |
| `/manage` references in `e2e` | 184, across 22 of 23 spec files |
| Route collisions after the rename | none |

**Pair sizes**, which is how the merge decisions were made:

| Public | Manage twin | Ratio | Verdict |
|---|---|---|---|
| `/rules` 29 | `/manage/rules/edit` 32 | 1.1× | one page wearing two hats — merge |
| `/teams/[slug]` 138 | `/manage/rosters/[teamId]` 373 | 2.7× | same content, richer tools — merge |
| `/games/[gameId]` 45 | `/manage/score/[gameId]` 290 | 6.4× | a summary vs a scoresheet — nest, don't merge |
| `/schedule` 131 | `/manage/schedule-builder` 72 | **0.55×** | a calendar vs a generator — keep separate |

⛔ **That last row is the one to internalise.** `schedule-builder` is *smaller* than the
public schedule because it is not a schedule page with edit buttons — it is a generator
(constraints, preview, publish). Merging a view with a tool because they concern the same
rows is how a 400-line page with two unrelated modes gets built.

## ⛔ Every manage page guards itself — this is what makes the move safe

Verified 2026-09-05 by reading all fifteen:

- `requireLeagueManager` — announcements, audit, import, people, people/duplicates,
  rosters, rosters/[teamId], rules/edit, schedule-builder, schedule-builder/one-off,
  seasons, seasons/[seasonId]
- `requireLeagueRole` — score, score/[gameId]
- `requireUser` + `isLeagueMember` — dashboard

`manage/layout.tsx` only does `if (!user) redirect("/login")`. **It is convenience, not
the boundary.** The protection travels with the page, so moving pages between route
groups cannot drop a guard.

⚠️ **The corresponding trap:** while moving files, do NOT "tidy up" a per-page guard that
looks redundant against the new layout. The layout is the weaker check; deleting the
page's own guard would be a real regression that nothing visibly breaks.

## Target URL map

**Shared pages — one URL, more affordances when you're entitled:**

| URL | Absorbs | Manager/captain additionally gets |
|---|---|---|
| `/<league>/teams/<slug>` | `/manage/rosters/<uuid>` | add, transfer, archive, numbers, positions, captains |
| `/<league>/teams` | `/manage/rosters` | — |
| `/<league>/schedule` | `/manage/score` | a Score button per game |
| `/<league>/games/<id>/score` | `/manage/score/<id>` | the scoresheet |
| `/<league>/rules` | `/manage/rules/edit` | inline editing |

**Manager-only pages — prefix simply gone:** `/dashboard`, `/people`,
`/people/duplicates`, `/seasons`, `/seasons/<id>`, `/schedule-builder`,
`/schedule-builder/one-off`, `/announcements`, `/import`, `/audit`.

**Untouched, public-only:** `/standings`, `/stats`, `/players/<id>`, league home.

**The UUID disappears.** `/manage/rosters/9f2a4c1e-…` becomes `/teams/sharks`.
`teams.slug` already exists and is already unique per league.

## Hazards

⛔ **1. The staged-league gate changes meaning, and both failure directions are bad.**
`(public)/layout.tsx` today runs `if (!league || !league.is_public) notFound()` — that is
what lets a league be built privately before launch. Once `/teams/<slug>` is one page,
the check must become conditional on identity:

    if (!league.is_public && !(user && await isLeagueMember(user.id, league.id)))
      notFound();

Backwards one way it leaks an unpublished league to the public; backwards the other it
locks a manager out of staging one. **Prove it by knocking the clause out and watching a
test go red**, in both directions — an anonymous request to a staged league, and a
member's request to the same.

⚠️ **2. `MAX_INLINE_LINKS` and the header width budget must be re-measured.**
`site-header.tsx` carries a measured comment: the "All leagues" link is the element that
gives way at narrow widths, and it works *because* it is strictly narrower than the
league switcher it replaced. Adding a badge, a Manage link and sign-out to that cluster
is exactly the change that comment predicts will recreate the overflow. Same for
`manage-nav.tsx:MAX_INLINE_LINKS = 5`, whose comment says anything added past the
threshold "needs re-measuring here."

⚠️ **3. Leave `0030`'s reserved slugs alone.** It reserves `api`, `auth`, `login`,
`manage`, `_next` as league slugs, with a comment explaining `manage` is reserved so no
league answers to `/manage/manage/dashboard`. After this change `manage` is no longer a
route segment — but removing the reservation is a migration that buys nothing and costs a
review.

⛔ **4. Do not end up with two write paths to the same table.** The merged team page must
*reuse* the existing roster actions, not grow its own. `0036` exists because a second,
naive implementation of a transfer destroyed goalie records through `v_goalie_stats`'
inner join while the games stayed on the schedule, reporting no error.

⚠️ **5. `getSessionUser()` on public pages costs nothing new.** Those pages already read
cookies through the Supabase server client and there is no middleware or `revalidate`
anywhere, so they are already dynamically rendered. The added cost is one `getClaims()`
per render, short-circuiting immediately for anonymous visitors.

## Steps

Each step is independently shippable and independently verifiable. **The order is
deliberate: the defect fix lands first, the mechanical change second, and the merges —
which are the only steps that change behaviour — last, one at a time.**

### 1. Auth-aware chrome (the actual defect)

`SiteHeader` is a server component, so it can `await getSessionUser()` itself — no
prop-drilling, no client bundle growth. It gains a role badge, a link back to the tools,
and sign-out, for a signed-in viewer only.

⛔ **`src/app/page.tsx` must be included.** The league picker is where a completed
sign-in lands (its own docstring says so) and it has no header at all — just a heading
and a theme toggle. Fixing only the league header leaves the exact confusion that
prompted this work.

Extract the account cluster into one component shared by `SiteHeader` and `ManageNav`, so
the two cannot drift.

**Acceptance:** signed in, the badge is on every page including `/`; signed out, the
chrome is unchanged from today; the header does not overflow at `md`.

### 2. Rename `manage/` → `(manage)/`

Mechanical. 137 `src` references and 184 `e2e` references become the new paths. No page
logic changes.

Add a catch-all at `/<league>/manage/[...rest]` that permanently redirects to the new
path, so existing bookmarks and any link already shared keep working.

**Acceptance:** every route resolves at its new URL; every old URL redirects; typecheck
and the full e2e suite pass with only path strings changed.

### 3. The shared-page gate

Implement the identity-conditional `is_public` check from Hazard 1 as one helper, used by
every page that is about to become shared. Land it with tests before any page depends on
it.

**Acceptance:** anonymous request to a staged league 404s; a member's request renders;
knocking out either half turns a test red.

### 4. Merge `/rules`

Smallest pair, 29 vs 32 lines. Proves the pattern end to end.

### 5. Merge `/teams/<slug>`

The big one. Public content always; the editing surface rendered for a manager, or a
captain of *that* team. Extract the editing UI into a component rather than growing a
500-line page.

⚠️ **Captain scope is unchanged by this step.** A captain may set a dressed lineup
(`game_rosters`), not edit the roster (`team_players`). Widening that needs new RLS
policies and is explicitly out of scope here — see *Deferred* below.

### 6. Merge the schedule/score index, nest the scoresheet

`/schedule` absorbs `/manage/score`'s list, gaining a Score button per game for a
scorekeeper or manager. The scoresheet moves to `/games/<id>/score`.

### 7. Sweep

e2e specs, `LAUNCH.md`, `ACCESS_CONTROL_HANDOFF.md` and `LAUNCH_READINESS_HANDOFF.md` all
name `/manage/...` paths in prose. Update them in the same change, not later.

## Deferred — raised, deliberately not in this plan

- **Captain roster editing.** Needs RLS policies scoped to "the team you captain this
  season". A wrong policy here is invisible until exploited.
- **Scorekeeper date scoping.** `/manage/score` lists a whole season; the ask was
  "that night's games". Needs a definition that survives a 21:30 game finalized at 00:10 —
  "unfinalized" is probably the better rule than a date.

## Acceptance for the whole change

- No URL contains `/manage/`, and no URL contains a UUID where a slug exists.
- Every old `/manage/...` URL redirects rather than 404ing.
- A signed-in manager sees their badge and a route to their tools on every page.
- An anonymous visitor sees exactly what they see today, everywhere.
- A staged (`is_public = false`) league is 404 to the public and reachable by its members.
- The full e2e suite passes, with the cross-league attack tests in
  `16-league-membership.spec.ts` unchanged in substance.
