# League creation belongs to no league — moving the importer to the root

**Protocol — read this and nothing else to resume.**

1. This file is self-contained: the ask, the measurements, the two decisions the
   user took, the hazards, the seven steps and the acceptance bars are all below.
   ⛔ **Do NOT read `LAUNCH_READINESS_HANDOFF.md` (1150+ lines)** — nothing in it
   blocks or is blocked by this work. ⛔ **Do NOT read
   `docs/superpowers/specs/2026-08-31-per-league-routing-design.md` (383 lines)**
   to learn why the page sits where it does; the two lines that answer it are
   quoted below.
2. ⛔ **Hazards, before any instruction:**
   - `supabase db reset --linked` **wipes production**. `npm run db:reset` is the
     local one. **This change needs no migration at all** — it is one route, one
     redirect, one nav entry and two guards.
   - ⚠️ **Never bare `git stash`.** Use `git stash push -u -m "<tag>"`, capture
     the SHA, `apply` not `pop`. Other sessions share this tree — **re-check the
     branch before every git write.**
   - Export a distinct `PORT` and run e2e only via `scripts/e2e-locked.sh` —
     worktrees share one Supabase database.
3. Every claim below is marked **measured** (watched appear on 2026-09-08 against
   `docs/deferred-code-work` at `45cd834`) or **read** (a reading of the code, not
   run). Nothing is unmarked.
4. Verify with `npm run typecheck && npx vitest run && npx eslint src e2e`, then
   the two e2e specs named in step 6. ⚠️ **Re-measure the baseline, do not quote
   one** — counts move with every merge.

**Status: MERGED to `main` 2026-09-09 in `8e2066f` (PR #55, 21 commits).** All
seven steps shipped. On the merge commit: typecheck clean, **517 unit tests over 41
files**, eslint clean, full e2e green in CI.

⚠️ **PR #55, not #47.** #47 was the original and GitHub auto-closed it the instant
its base branch `docs/deferred-code-work` (#45) merged and was deleted — a closed
PR's base cannot be retargeted and it cannot be reopened once the base is gone.
#55 is the same 21 commits rebased onto `main`; verified content-identical by
diffing the two heads, which differ only in files `main` itself changed.

⚠️ **Several things in the pages below were WRONG when written and are corrected in
place**, marked **[corrected after building]** or **[corrected after review]**. The
largest is §5, whose original justification does not hold. Read the corrections
before trusting the paragraph around them. What the build and six review rounds
additionally found is in *What building this changed*, at the end; read that before
touching the RLS half.

No deadline attached. It is independent of every item in
`docs/worklists/2026-09-07-9466c507-deferred-code-work.md`, and in particular it is
**not** IA approach C (item 7) — that one restructures the *schedule* routes inside
a league. This one moves a single page *out* of `[league]` entirely. Do not fold
them together; they share no file.

## The ask, in the user's words

> "I want to import a new league and create a season but the import exist inside a
> league. Shouldn't league creation/import be at the / level where the league
> switcher is?"

Two halves, and they get opposite answers. **League creation → yes, move it.**
**Season creation → no, it is already right**: `createSeason` (`src/lib/actions/seasons.ts:41`)
takes a `league_id` and belongs to `/<league>/seasons`. The import already creates
its own season, inactive. What is missing between the two halves is a link, and
step 5 is that link.

## The code already agrees — three proofs

**All measured.**

| Claim | Evidence |
|---|---|
| The import creates a **new** league; it never reads the one in the URL | `src/lib/actions/import.ts:133-134` and `src/lib/actions/import-rosters.ts:100-101` both `.from("leagues").insert({ name: leagueName, slug: leagueSlug, is_public: true })` from form fields |
| These are the **only** two league inserts in the tree | `grep -rn 'from("leagues")' src` — 10 hits, 2 inserts (above), 2 deletes (their own rollbacks at `import.ts:178`, `import-rosters.ts:142`), 6 reads |
| The UI carries no league either | `<EsportsdeskImport />` is rendered with **no props** (`import/page.tsx:30`); the component is 280 lines with no `useParams`, no router push, no slug in any `href` |

⛔ **The guards already disagree with each other, and the action is the one telling
the truth.** The page runs `requireLeagueManager(ctx.league.id)`
(`src/app/[league]/(manage)/import/page.tsx:23`) — role **and** membership of a
league it will not touch. Both actions run `requireManager()` only
(`import.ts:91`, `import-rosters.ts:51`), with a comment saying why in as many
words:

> Role only, and deliberately: this creates a league that does not exist yet, so
> there is no membership to check it against.

**And the cache invalidation already points at the root.** `revalidatePath("/")`
appears at `import.ts:323,417,427` and `import-rosters.ts:241`, each carrying the
comment *"This import creates a league; the root landing page lists them."* The
other two calls in each group revalidate the **route patterns** `/[league]/seasons`
and `/[league]`, not a resolved slug — so they already invalidate every league
instance and need no edit when the page moves.

## Why it is where it is — an artifact, not a decision

**Read.** `2026-08-31-per-league-routing-design.md:98` shows the whole flat
`/manage/*` tree acquiring a `[league]/` prefix in one move, with `import/` in the
list. The same spec (line ~159) then says, of reserved slugs:

> reject `login`, `auth`, `api`, `manage` where leagues are created —
> `runEsportsdeskImport` … and document it for manual SQL inserts, **since there is
> no league-creation UI.**

The importer *is* the league-creation UI. Nothing acknowledged that when it was
reparented under `[league]`, and no spec since has revisited the placement.

## The strongest argument: today's bootstrap is a dead end

**Measured.** With zero leagues in the database, `src/app/page.tsx:121` renders
`EmptyState title="No leagues yet"` — and there is no way out of it. Reaching the
only code that can create a league requires a URL of the form `/<slug>/import`,
which requires a league to already exist. Office tier does not rescue this:
`memberLeagueIds` (`src/lib/auth/membership.ts:39-42`) resolves an office member's
leagues by selecting **every** league, which on a fresh instance is `[]`.

So the first league on any instance must be hand-written in SQL purely to obtain a
URL. Moving the page to the root closes that.

## Decisions taken by the user, 2026-09-08

⛔ **Both were asked and answered. Do not re-open them mid-build.**

**1. Guard: `requireManager()` — any `league_manager`.** Not the office tier. This
makes the page exactly as strict as the action it submits to, which is the whole
point of the move.

⚠️ **State the delta precisely, because "widening" overstates it.** The *capability*
was never gated by membership: any `league_manager` who belongs to at least one
league can already create any league today, by submitting the form from their own
league's `/import`. Office members reach every league's copy already
(`membership.ts:39`). The accounts that gain reach are exactly one kind: **a
`league_manager` who is a member of no league** — today refused at every
`/<slug>/import` by the membership half, tomorrow admitted at the root. That
account is reachable (a role granted before a league assignment), and admitting it
is correct: it is the account most likely to be creating the first league.

**2. Deleting a league: out of scope, stated explicitly.** Five comments across the
two importers say "there is no UI to delete one", and
`import-rosters.ts:244` goes further, telling a manager that "re-running the import
would create a second league, since there is no way to delete this one" — advice
for a control that does not exist. That gap is **not** widened by this change and is
not closed by it. What already mitigates it stays: both actions reject an empty or
reserved slug *before the first write*, and the rosters-only path also refuses a
source that parses to zero teams (`import-rosters.ts:96`). A typo'd league name is
still permanent and public. See *Deferred* below.

## Target

| | Today | After |
|---|---|---|
| Route | `/<league>/import` | `/manage/leagues/new` |
| Guard | `requireLeagueManager(league.id)` | `requireManager()` |
| Nav | staff row, league-relative | staff row, `absolute: true`, beside League Office |
| Root page | no creation affordance | "New league" for a signed-in manager |
| Chrome | `SiteHeader` + `StaffLinks` + `(manage)` container | its own container + "← All leagues", exactly like `/manage/office` |

**Why `/manage/leagues/new` and not `/manage/import`.** Two reasons, the first
mandatory:

⛔ **A redirect from `/:league/import` would match `/manage/import` and loop.**
`:league` eats `manage`, `import` matches literally, and the destination is the
source. `next.config.ts` already documents the sibling case for `/manage/office`
("This cannot swallow the League Office… the source below requires the SECOND
segment to be the literal `manage`"). A three-segment destination cannot be matched
by a two-segment anchored source, so the loop is structurally impossible rather
than avoided by ordering.

Second: it names the outcome rather than the mechanism. Import is the only creation
path *today*; a blank-create form is the obvious next one and belongs on the same
page under the same URL.

**`manage` is already the root namespace for league-less staff routes** — reserved
in `src/lib/league/reserved-slugs.ts` and mirrored by
`supabase/migrations/0030_league_slug_reserved.sql`, and already carrying
`/manage/office`. This change adds a second tenant to a namespace built for exactly
this; it does not create one.

## Hazards

⛔ **1. One e2e asserts the behaviour this change removes. Delete it, do not repair
it.** `e2e/16-league-membership.spec.ts:165` lists `"/import"` in `MANAGE_PATHS`,
whose loop asserts *"a manager of another league is refused at <path>"* and expects
a redirect to `/`. After the move that refusal is wrong. ⛔ Do not keep
`/<league>/import` alive to keep the test green, and do not weaken the loop — remove
the one entry, in the same commit as the guard change, and replace it with the
positive assertion in step 6. The surrounding `// NOT "/teams"` / `// NOT "/rules"`
comments in that array are the established way to record why a path is absent;
follow it.

⛔ **2. There is no `src/app/manage/layout.tsx`, and the new page must not assume
one.** **Measured:** `find src/app/manage -type f` returns exactly
`office/page.tsx`. The `SiteHeader` and the `StaffLinks` row are drawn by
`src/app/[league]/layout.tsx:111-113`, which the new route is outside of. So the
page gets the bare root shell and must draw its own container and its own back-link,
the way `office/page.tsx` does at its top (`mx-auto w-full max-w-4xl flex-1 px-4
py-8`, then `← All leagues`). ⚠️ It also loses the league switcher, which is
correct — there is no current league — but it means the back-link is the **only**
way out of the page. Step 5 exists because of this.

⚠️ **3. Do not "tidy" the page guard down to the layout.** There is no layout to
tidy it into. `requireManager()` on the page is the whole boundary, and the two
actions keep their own — a form action is reachable by anyone who can construct the
request, which is the trap `ACCESS_CONTROL_HANDOFF.md`'s *Traps* section is about.

⚠️ **4. `revalidatePath` needs no edit and must not get one.** The pattern-form
calls (`/[league]`, `/[league]/seasons`) are already league-agnostic. Rewriting them
to a resolved slug would be a regression dressed as a cleanup.

## Steps

Each step is independently green. Steps 1–3 are the move; 4–5 are what the move
makes necessary; 6–7 are tests and prose.

### 1. The page moves

Create `src/app/manage/leagues/new/page.tsx` from
`src/app/[league]/(manage)/import/page.tsx`. Drop the `params` prop, the
`resolveLeagueBySlug` call, the `notFound()` and the `ctx` shim; the guard becomes a
bare `await requireManager()`. Add the container and the `← All leagues` link,
copied from `office/page.tsx`. Delete the old directory.

⚠️ Keep the existing `PageHeader` copy ("Import from esportsdesk" / the two-mode
description) verbatim. The route names the outcome, the header names what the page
currently does, and changing both at once makes the diff harder to review for no
gain.

*Acceptance:* `/manage/leagues/new` renders for a manager; `/<league>/import` 404s
(the redirect lands in step 2); `npm run typecheck` clean.

### 2. The redirect

Add to `next.config.ts`, with a comment recording the loop hazard from *Target*
above:

```
{ source: "/:league/import", destination: "/manage/leagues/new", permanent: true }
```

⚠️ Ordering against the five existing entries does not matter — no other source
matches a two-segment `/<x>/import`. Say so in the comment, as the neighbouring
entries do, so the next reader does not re-derive it.

*Acceptance:* `/obhl/import` → 308 → `/manage/leagues/new`. `/manage/office` still
resolves (it always did; assert it anyway, once).

### 3. The nav entry

`src/components/shared/staff-links.tsx` — remove `{ path: "/import", label:
"Import" }` from `LINKS.league_manager` (line 37, the only `/import` reference in
`src`). Add it to the `absolute: true` list built in `staffLinks()`, beside League
Office, as `{ path: "/manage/leagues/new", label: "New league", absolute: true }`.

The `absolute` mechanism already exists for exactly this and needs no change — its
comment says "for links that belong to no league — today only the League Office";
update that word.

⚠️ Unlike the office link this one is **not** tier-gated: every `league_manager`
gets it, matching step 1's guard. A `scorekeeper` or `captain` must not see it.

*Acceptance:* a manager sees "New league" in the staff row on any league page; a
scorekeeper does not.

### 4. The root affordance

`src/app/page.tsx`. For a signed-in `league_manager`, render a link to
`/manage/leagues/new`. Two placements, both needed:

- Beside the account cluster (or under the heading) on the normal page.
- ⛔ **Inside the empty state.** Today it reads *"Once a league is published it will
  appear here"* (line 121) — for a manager on a fresh instance that is a dead end,
  and it is the exact case this whole change exists to fix. The empty state must
  offer the link.

⚠️ `user.role` is instance-wide and this page has no league, so the role **is** the
right check here — this is the one page where the membership half has nothing to say.
That is the opposite of the rule everywhere else; say so in a comment, because it
reads like the mistake `staff-links.tsx` warns about.

*Acceptance:* signed out, the page is byte-identical to today. Signed in as a
manager, the link appears in both the populated and the empty states.

### 5. The import ends in the league it made

⛔ **[corrected after building] THIS SECTION'S ORIGINAL ARGUMENT WAS FALSE, and it
is quoted here because it is the kind of wrong that survives review.** It said:

> after the move, a completed import leaves the manager on a page with no league
> chrome at all and a success message naming a league they cannot click

That does not happen. The new league is created `is_public: true`, so `/` lists it the
moment the action returns, and the relocated page carries a `← All leagues` link. The
way out was two clicks before the move and two clicks after. The move even *improves*
it slightly: on `/<old league>/import` the manager was surrounded by the wrong
league's staff row, including a "Seasons" link pointing at the wrong league.

**Why that mattered.** A false justification made this step look load-bearing. Scoped
down later, someone would have kept it believing the move required it. It does not:
this step is separable, and it shipped as its own commit for that reason.

**What it actually is:** the second half of the user's ask, and the user's own
correction of the first draft — *"after the import the manager should be in the league
they created."* Not a link. A redirect.

⛔ **[corrected after review] "THE SPLIT FALLS EXACTLY WHERE THE CODE ALREADY
DIVIDES" WAS FALSE, and it is the second claim in this section to be wrong in the
same direction.** It was true of `runRosterOnlyImport`, which has always kept a
`problems[]`, and false of `runEsportsdeskImport`, which skipped every failure in its
team loop with a bare `continue` — the team insert did not even destructure its error.
Only the `catch` blocks were checked when this was written; the in-loop `continue`s
were not. So the redirect shipped past a partial import in the full importer, whose
counts in the old success message had been the only thing that ever revealed a
shortfall. Caught by an independent reviewer, not by the session that wrote it; fixed
in `d6f8961`, which gives that function the same accounting and gates its redirect on
it.

⚠️ **The generalisable part:** two sibling functions doing the same job are not
evidence for each other. The invariant was read off one and assumed of the other,
and the docblock on `ImportRunState` asserted it for both.

**The shape.** Redirect on the clean exits; keep the report on the partial ones —
which after the fix above is genuinely where both functions divide:

- `redirect(`/${leagueSlug}/seasons`, RedirectType.replace)` at `import.ts`'s clean
  exit and `import-rosters.ts`'s, the latter behind `problems.length === 0 && membership.ok`. Both are
  already at the function's top level, **outside every `try`**, so nothing had to be
  restructured.
- ⛔ **Not at the two exits inside `catch` blocks.** Two reasons, either sufficient.
  `node_modules/next/dist/docs/01-app/03-api-reference/04-functions/redirect.md` says
  twice that `redirect` throws and must be called outside `try`, so a redirect there
  would be swallowed silently. And those exits carry the **only** report of what
  failed — the schedule error, the stats error, the list of teams that did not import.
- `ImportRunState` is therefore now a discriminated union whose `ok: true` arm means
  *partial* success, carrying `slug` so the page can offer a way in after the manager
  has read the report. One edit covers both actions: `import-rosters.ts` imports the
  type.
- `RedirectType.replace`, not the server-action default of `push`: the create form is
  a completed one-shot, and Back would otherwise land on a blank form for a league
  that already exists.

⚠️ The `completed` derivation at `esportsdesk-import.tsx:44` keeps a success across a
mode toggle, deliberately. The link hangs off `completed`, not `run`.

⚠️ **`statRowCount` went with the message.** It existed only to be counted into the
clean success string; with that string replaced by a redirect, eslint found it unused.
Removed rather than silenced. If a landing banner ever wants the tally, take it from
`rosterRows.length` — do not reintroduce a counter with no reader.

✅ **No confirmation banner, deliberately.** The clean message's one unique hint —
"set any goalie positions in Rosters" — is already on the form above the submit
button in both modes, so nothing unique is lost, and this avoids adding `searchParams`
to a seasons page that takes `params` only.

*Acceptance:* a clean import lands on `/<slug>/seasons`; a partial import stays put,
shows its report, and offers a link. ⚠️ **Neither is covered by e2e** — both import
specs are network-free by design and never complete a run. Verify by hand.

### 6. Tests

- `e2e/17-roster-import.spec.ts:10,32` — two `page.goto("/obhl/import")` become
  `page.goto("/manage/leagues/new")`. Both tests are network-free by design (see the
  block comment at line 17); keep them that way.
- `e2e/16-league-membership.spec.ts:165` — delete the `"/import"` entry per hazard 1,
  leaving a comment in the array's established style.
⚠️ **It is `32`, not `31`, and the reason is worth knowing before you add the next
one.** PR #46 (item 1 of the deferred-work dossier) took `e2e/31-stale-draft.spec.ts`
while this was being written. The two branches never conflict in git — different
filenames — so nothing warns you; the collision only shows up as two specs numbered
31 after both land. **Check `origin`'s open branches, not just your own tree, before
claiming a spec number.**

- **New, and the point of the change:** `e2e/32-create-league.spec.ts` — who reaches
  `/manage/leagues/new` (Manager, One-league mgr, **No-league mgr**), who is refused
  (scorekeeper → `/`, signed out → `/login`), that `/obhl/import` redirects to it,
  that `/manage/office` is not swallowed by that redirect, and that the staff row and
  the root page each offer the link to the right accounts.

⛔ **[corrected after building] THE FIXTURE WAS ADDED. This section originally said
not to.** It said to check whether a member-of-nothing manager exists and, if not, to
"record the second as untested rather than inventing a fixture inside this change."

Measured: no such account existed. All five membership-bearing fixtures have leagues,
and `commissioner@`/`deputy@` have `leagues: []` but an office tier, which
`memberLeagueIds` turns into implicit membership of **every** league — so none of the
seven could stand in for the one account whose reach this change widens. Leaving it
untested would have meant shipping the only behavioural change with no test at all.

`no-league-mgr@obhl.test` was therefore added as an eighth seeded account, following
`scripts/seed-users.mjs`'s own convention (*"SIX AND SEVEN ARE NEW ACCOUNTS, NEVER AN
ELEVATED FIXTURE"*), which exists for exactly this case.

- Also assert a `scorekeeper` is refused (`requireManager` redirects to `/`).

*Acceptance:* `npm run typecheck && npx vitest run && npx eslint src e2e` clean, and
specs 16, 17 and 32 green. ⚠️ Adding a seeded account is not local to those: run
02 (auth), 08 (People) and 20 (office) too — the new row lands in the office's
appoint dropdown and in every profile listing.

### 7. Prose

**Measured 2026-09-08:** grepping the four handoffs for the import turns up
`ACCESS_CONTROL_HANDOFF.md:187-191` (the `previewEsportsdeskImport` SSRF note) and
`LAUNCH_READINESS_HANDOFF.md:277,295` (the same note, and `import_league` being the
one audit action with no test). **None of them is a route table, and this change
touches none of those claims** — so no handoff edit is forced.

What to add: one line to
`docs/worklists/2026-09-07-9466c507-deferred-code-work.md` recording that the
importer moved, so item 7's reader does not confuse the two IA changes. And the
status line at the top of this file.

## Acceptance for the whole change

✅ **BAR 1 IS MET FOR ROSTERS-ONLY.** Run against a real esportsdesk source by
the maintainer on 2026-09-09: `runRosterOnlyImport` end to end, including the
redirect into `/<slug>/seasons`.

⛔ **And it did not pass cleanly — it exposed a silent data loss on the first
try.** The roster parser required a jersey *number*; esportsdesk prints an
unnumbered player's as `-`, so those rows matched nothing and the players were
dropped with no error and no entry in `problems[]`. 9 players were missing from a
league that had already been imported and looked correct. Fixed in PR #60.
⚠️ **Note where it was: the parser** — the one layer every test in this change
deliberately stubs. The shortfall machinery this spec spent four review rounds
building cannot see a row the parser never produced.

⛔ **It is NOT met for a full migration.** `runEsportsdeskImport` adds the
schedule block, the stats block and the `notes[]` shortfall machinery, and none
of that has met a real source — no test makes the outbound fetch either. Bar 2
(force a partial import and confirm the shortfall is named) is also unrun.

⚠️ **This paragraph previously said the importer had "NEVER BEEN RUN", which was
false when written.** It was inferred from the absence of a test rather than
asked, and the maintainer had already run it. The absence of a test is evidence
about tests, not about the world.

1. On an instance with **zero** leagues, a signed-in manager can create the first
   one entirely through the UI, with no SQL. ⚠️ This is the bar the change exists to
   clear; test it against a fresh `npm run db:reset`, not against the seed.
2. `/<league>/import` redirects; no link in `src` points at it.
3. The page's guard and the actions' guards are the same guard.
4. A scorekeeper and a captain cannot reach it.
5. Typecheck, unit, eslint and specs 16/17 clean.

## Deferred — raised, deliberately not in this plan

- **Deleting a league.** Decided out of scope above. It needs a cascade decision
  across seasons, teams, players and audit, its own guard and its own audit action,
  and it would be the one destructive control on the instance. ⚠️ Note that
  `import-rosters.ts:244` and `import.ts:326` both *instruct* the manager to delete a
  league. Whoever closes this gap should fix those two strings in the same change;
  whoever does not should leave them, because the advice is still the only recovery
  there is (by hand, in SQL).
- **Creating a league from blank**, with no esportsdesk source. The route is named
  for it and the page is where it would go. Nothing today needs it.
- **Staging new leagues** (`is_public: false` at creation). Considered as a cheaper
  substitute for delete and not taken: it changes behaviour for both existing
  importers and for every league already created, which is a bigger blast radius
  than the route move it would have ridden along with. The root page already badges
  staged leagues ("Not yet public"), so the surface for it exists if it is ever
  wanted.
- **Renaming the page and its header to match the route.** Step 1 keeps the copy.

## What building this changed

Three things the plan did not know. The third is the one to read.

### A unit test already enforced the argument this spec makes

`src/lib/actions/league-guards.test.ts:205` asserts *"uses no role-only guard in a
manage page"* over every page under `[league]/(manage)`. So the guard swap and the
file move are **not separable even temporarily**: changing `requireLeagueManager` to
`requireManager()` in place turns `npx vitest run` red, and only moving the file out
of that tree makes it legal. The test is an independent statement of this whole
document's case — role-only guards do not belong inside a league.

After the move the page is covered by neither of that file's assertions, which is
correct: both rules are wrong for a page belonging to no league, and
`manage/office/page.tsx` has always sat outside the scan for the same reason. ⛔ Do
not extend `MANAGE_DIR` to `src/app/manage/` to "restore coverage" — it would fail
both root-level pages by design.

### The fixture turned a correct RLS policy red

⚠️ **Read this before touching the `profiles` policies or that test.** Adding
`no-league-mgr@obhl.test` broke `16-league-membership.spec.ts`'s *"another league's
staff are not readable through the API"*. The policy is right; the **test's model of
it was incomplete**, and no seeded account had ever exposed that.

That test built its `allowed` set from `profile_leagues` rows on the shared league —
i.e. from `shares_league_with`, the `manager read profiles` policy. But **two**
policies grant SELECT here. `manager write profiles` is `for all`, and in Postgres a
`for all` policy's `USING` clause applies to SELECT as well. Its rule is
`may_write_profile`, which for a manager with no tier reduces to
`office_tier_of(them) is null and contains_leagues_of(them)` — and
`contains_leagues_of` asks whether they have a league that is not also yours, so an
account with **no** leagues satisfies it **vacuously**.

That is deliberate, not a hole: adding a brand-new account to your league means
writing a profile that is a member of nothing at the instant you write it. People &
Roles depends on it.

It had gone unmodelled because no seeded account was unassigned *and* tierless — the
office pair have no memberships, but their tier fails the `office_tier_of(them) is
null` half, so they stay invisible. `No League Manager` is the first account in that
gap. The test now models both policies, and gained an assertion that the office stays
invisible — which the widened `allowed` set would otherwise have quietly hidden.

⛔ The lesson for the next fixture: **an account's `leagues: []` does not make it a
member of nothing** if it carries an office tier. Those are different states, and
only the tierless one exercises the membership guards.

### What two code reviews changed, and which one found what

The branch was reviewed twice in parallel — once by the session that wrote it, once
by an agent with no prior context. **They found disjoint sets, which is the argument
for running both.**

Only the fresh reviewer found the Major: the full importer's silent `continue`s, above.
The self-review had read the same function twice and checked the `catch` blocks both
times, because that was where its own reasoning had been.

Only the self-review found two things the fresh eye could not: that the commit and PR
claimed *"Verified by hand"* for a redirect nobody had ever run — no agent can audit
what was or was not executed — and that `addLeagueMembership` discarded its upsert
result, which the redirect turned from a confusing failure into a silent one.

Both independently found the duplicate "New league" link on a league-less instance.

⚠️ **Still outstanding, and deliberately not fixed here:** `set-password` is a
top-level route missing from `RESERVED_LEAGUE_SLUGS` and from `0030`'s constraint. A
league named "Set password" gets an address that never resolves, and since this change
the import navigates the manager to `/set-password/seasons` — a 404 — rather than
showing a message. Pre-existing, needs a migration, belongs in its own change.

### A dead variable, found by lint rather than by reading

Replacing the clean success message with a redirect left `statRowCount` with no
reader. See §5 — removed, not silenced.

## Provenance

Written 2026-09-08 by session 9466c507 on branch `docs/deferred-code-work`, from the
user's question quoted at the top. The two decisions in *Decisions taken* were put to
the user and answered before this file was written. No code was changed.
