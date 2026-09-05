# One URL per thing — flattening the manage prefix and merging the duplicated pages

**Protocol — read this and nothing else to resume.**

1. This file is self-contained: the ask, the measurements, the hazards, the seven
   steps and the acceptance bars are all below. ⛔ **Do NOT read
   `LAUNCH_READINESS_HANDOFF.md` (538 lines)** — it covers launching production and
   nothing outstanding in it blocks or is blocked by this work. Open it only if you
   are asked to do launch work instead.
2. ⛔ **Hazards, before any instruction:**
   - `supabase db reset --linked` **wipes production**. Use `db push`. **This change
     needs no migration at all** — it is routing, chrome and page merges.
   - **Mutating `gh` (`pr create`, `pr merge`) and `vercel env` are denied to an
     agent** under the auto-mode classifier, as are mutating HTTP requests to
     production. Ask a human; do not work around it. Read-only `gh` works.
   - ⚠️ **Never bare `git stash`.** The stack is shared across worktrees and other
     sessions use it. Use `git stash push -u -m "<tag>"`, capture the SHA, `apply`
     not `pop`. A temporary WIP commit is better.
   - Other sessions may share this tree — **re-check the branch before every git
     write**.
3. Every number below was **watched appear** (line counts, reference counts, the
   guard table). Where a claim is a reading of the code rather than a measurement,
   it says so in those words.
4. Verify with `npm run typecheck && npm test`, then `PORT=<yours> npm run test:e2e`.
   ⚠️ **Re-measure the baseline, do not quote one** — the counts move with every
   merge. Export a distinct `PORT` per worktree and `lsof -ti:$PORT` before
   believing a red run; `reuseExistingServer` will otherwise hand your suite
   another branch's dev server. Worktrees share ONE Supabase database, so serialize
   e2e. CI runs the full suite, so run only the specs covering your step locally.

**Status: all seven steps shipped, 2026-09-05.** Read *What the implementation
changed about this plan* below before trusting anything in the pages above it:
four things there are false, and the fourth is false in the direction that
matters — the `?tab=manage` this plan called necessary was removed.

The code was written as a stack of six PRs, each branched on the one below and
each reviewed by its own agent:

| Step | Branch | PR |
|---|---|---|
| 1 | `feat/auth-aware-chrome` | #25 |
| 2 | `feat/flatten-manage-prefix` | #26 |
| 3 | `feat/staged-league-gate` | #27 |
| 4 | `feat/merge-rules` | #28 |
| 5 | `feat/merge-team-pages` | #29 |
| 6 | `feat/merge-schedule-score` | #31 |

⛔ **It did not merge that way, and the reason is worth keeping.** "Merge
bottom-up; GitHub retargets each child as its parent lands" assumes `main` holds
still. It did not: `origin/main` advanced 33 commits (#24) while the stack was
being written, so every PR in it became unmergeable at once, and the collision
included a migration-number clash — both sides had claimed `0039`/`0040` — plus
three pages the stack had DELETED that #24 had since modified. A delete/modify
conflict resolves silently either way, so taking "ours" would have dropped an
archive-aware picker, an edit form and a not-enrolled-this-season guard with no
test to fail.

`main` was therefore merged into the top branch once, #31 became the single PR,
and #25–#29 were closed as superseded. **The lesson is to integrate early rather
than at the end**, not to avoid stacks. Step 7 — the prose — is the commit
carrying this paragraph.

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
cookies through the Supabase server client, so they are already dynamically rendered.
The added cost is one `getClaims()` per render, short-circuiting immediately for
anonymous visitors.

⛔ **This hazard said "there is no middleware anywhere". THAT IS WRONG** — `src/proxy.ts`
exists (Next 16 renamed the `middleware` convention to `proxy`) and refreshes the
Supabase session on every matched request. It does not change the conclusion, which is
why the sentence survived review this long, but do not carry the claim into a step that
reasons about request handling.

⚠️ **`getSessionUser` was NOT memoized when this was written**, so "one `getClaims()` per
render" was false: the layout, the header and the page each asked independently. It is
`cache()`-wrapped as of step 1, which is what makes the sentence true.

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

### 7. Sweep — THE ONLY STEP LEFT

e2e specs, `LAUNCH.md`, `ACCESS_CONTROL_HANDOFF.md` and `LAUNCH_READINESS_HANDOFF.md` all
name `/manage/...` paths in prose. Update them in the same change, not later.

The e2e half is done — it moved with each step. What remains is prose, and it is
wider than the prefix now:

- `LAUNCH.md` (5), `EXPORTS_HANDOFF.md` (2), `ACCESS_CONTROL_HANDOFF.md` (2),
  `LAUNCH_READINESS_HANDOFF.md` (1) name `/manage/...` paths;
- they also name `/rules/edit`, `/rosters/<uuid>` and `/score`, which steps 4–6
  merged away; ⚠️ the team editor does **not** need `?tab=manage` — see item 3
  below, which is the one prediction in this plan that the implementation
  reversed;
- `ACCESS_CONTROL_HANDOFF.md` needs more than a path rewrite. Steps 4 and 6 added
  `canManageLeague` and `canScoreLeague`, which are QUESTIONS AND NOT GUARDS — they
  decide whether to draw an editing surface and protect nothing. That distinction
  belongs in the file whose *Traps* section exists to stop someone confusing the two.

⚠️ Leave `docs/worklists/` and the older `docs/superpowers/specs/` alone. They are
historical records of what was true when written.

## What the implementation changed about this plan

Four things above are now out of date. The first three were found by the review
pass over the six branches; the fourth was found by measuring a claim this plan
made and discovering it was backwards.

⛔ **1. Hazard 1's rule needed an RLS half, and now has one (migration `0039`).**
The conditional `is_public` check landed as written — and it was unreachable for
anyone but a manager. `leagues` had exactly two select paths, `"public read leagues"`
(`using (is_public)`) and `"manager write leagues"` (`manages_league(id)`, i.e. the
role AND membership), so a scorekeeper or captain who genuinely belonged to a staged
league got `null` from `resolveLeagueBySlug` and a 404 one layer above the new rule —
on the league they were staffing.

`0042_member_read_leagues` adds `for select using is_league_member(id)`. SELECT only:
membership is not permission to write a league row. The app half and the RLS half now
say the same thing, and `src/lib/league/visibility.ts` documents them as a pair that
must be widened or narrowed together.

⚠️ **It was written as `0039` and shipped as `0042`** — #24 had claimed `0039`-`0041`
while this stack was being written. Any reference to `0039_member_read_leagues`
elsewhere means this file.

⛔ **And on its own it fixed the 404 while leaving the page empty.** `leagues` was
only the door; every child table — seasons, teams, players, games and six more —
was still public-only, so a scorekeeper of a staged league reached a page that
resolved and showed nothing. `0043_member_read_children` is the other half, adding
a `member read` policy to each of the ten through `player_in_my_league`
(`SECURITY DEFINER`, so it can see past the caller's own RLS). Treat the two as one
decision. ⛔ The tempting one-line version — widening the `_is_public` helpers —
is wrong: `player_is_public` and `game_is_public_final` read them to decide what
ANONYMOUS visitors see, so the lie propagates out of the league.

⚠️ **The test that should have caught this could not.** Both staged-league tests used
accounts that were not members of the staged league, so they pinned "non-member 404s"
and would have stayed green if membership had stopped counting entirely. There is now
a third that uses a member who is not a manager.

⚠️ **2. Merging a page into `(public)` costs the manager their nav, and the fix is
additive.** Three of the six reviews raised this independently: `/rules`,
`/teams/<slug>` and `/schedule` live under `(public)`, so a manager who follows one
loses `ManageNav` and every link in it.

⛔ **Do not fix it by swapping in `ManageNav`.** Its "View site" link would then point
at a page that renders `ManageNav` again, so the one control for getting back to the
public view becomes a no-op. A shared page is a public page with more on it. The
implementation adds a `StaffLinks` row *beneath* `SiteHeader`, built from the same
`staffLinks(role, officeTier)` the manage header uses so the two cannot drift.

⚠️ **3. The merged team page carried its tab in the URL (`?tab=manage`) — and then
stopped having a tab at all.** The diagnosis was right and is worth keeping: Radix
unmounts inactive tab content on the CLIENT, while the server renders every branch it
is given, so a `<TabsContent>` holding the roster editor ran four admin queries — one
an unbounded read of the whole `players` table — on every manager's casual look at a
team page. `?tab=manage` was the fix that kept the tab.

⛔ **4. The tab itself was the wrong answer.** Asked, the user's direction was *"the
manager should just see the page and it should be editable to them"* — so the Manage
tab and `?tab=manage` were both removed, and the editor became a section in a named
landmark (`<section aria-labelledby="manage-roster">`) below the public content,
rendered only when `canManageLeague` says so. The query cost is gated by that
condition rather than by a tab, which is strictly better: a manager who never scrolls
still pays it, but a visitor never does, and there is no URL state to get wrong.

⚠️ **The e2e consequence is the part that bites.** One URL now renders the public
table AND the editor's table, so `getByRole("cell")` and `table tbody tr` match twice
and Playwright's strict mode fails the test. Seven specs had to scope their lookups to
`getByRole("region", { name: "Manage roster" })`. Any future shared page inherits
this: **scope to the landmark, do not reach for `.first()`.**

**Also worth knowing, and not this plan's to fix:** `notFound()` thrown by a page
inside `(public)` answers **HTTP 200**, not 404, because the layout above it has begun
streaming by the time the page throws. It predates this work — reproduced on `main` —
and is tracked as issue #30. Two tests in `15-league-routing.spec.ts` assert on
not-found CONTENT rather than status because of it; both say so.

## Deferred — raised, deliberately not in this plan

- **Captain roster editing.** Needs RLS policies scoped to "the team you captain this
  season". A wrong policy here is invisible until exploited.
- **Scorekeeper date scoping.** `/<league>/schedule` lists a whole season; the ask was
  "that night's games". Needs a definition that survives a 21:30 game finalized at 00:10 —
  "unfinalized" is probably the better rule than a date.

## Acceptance for the whole change

- No URL contains `/manage/`, and no URL contains a UUID where a slug exists.
  ⚠️ **With one deliberate exception: `/manage/office`.** The League Office is not
  scoped to a league — it is the tier that spans them — so it has no `/<league>/`
  to move under. `manage` is a reserved league slug (`0030`), so nothing can
  collide with it, and `next.config.ts`'s redirect requires the SECOND segment to
  be the literal `manage`, which is what keeps `/:league` from eating this one.
- Every old `/manage/...` URL redirects rather than 404ing.
- A signed-in manager sees their badge and a route to their tools on every page.
- An anonymous visitor sees exactly what they see today, everywhere.
- A staged (`is_public = false`) league is 404 to the public and reachable by its members.
- The full e2e suite passes, with the cross-league attack tests in
  `16-league-membership.spec.ts` unchanged in substance.
