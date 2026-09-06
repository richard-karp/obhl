# One site, not two — merged chrome, team-logo ink, sign-out destination

**Protocol — read this and nothing else to resume.**

1. This file is the RECORD of work that is built and committed on
   `refactor/one-site-chrome-and-logo-ink` (PR #39, open, **not merged, not
   pushed further**). The design doc is
   `docs/superpowers/specs/2026-09-06-one-site-chrome-and-logo-ink-design.md`;
   read it only if you need _why_ a thing was decided. ⛔ Do not read
   `LAUNCH_READINESS_HANDOFF.md` (867 lines) for this work — nothing in it
   blocks it.
2. ⛔ **§1 below is a DEPLOY GATE. Read it before shipping anything on this
   branch.**
3. Every number here was **watched appear** in a browser at Chromium
   `Desktop Chrome` metrics. Claims about how code is _shaped_ say so.
4. Verify with `npm run typecheck && npx vitest run`, `npx eslint src e2e`,
   `npx prettier --check src e2e supabase/migrations`, then the FULL
   `npx playwright test`. Export a distinct `PORT` and a matching
   `NEXT_PUBLIC_SITE_URL` — see §6.

---

## 1. ⛔ DEPLOY GATE — migration `0044` ships with or before this code

`supabase/migrations/0044_team_logo_in_stats_views.sql` re-issues four views
(`v_skater_stats`, `v_goalie_stats`, `v_skater_season_totals`,
`v_goalie_season_totals`) with `team_logo_path` and `team_logo_text_color`
appended. **It has been applied LOCALLY only.** The user runs `db push`.

Deploying the code against a database without it does not take the site down —
it produces one page that lies:

| Caller                             | Reads                                | Without 0044                                                                                                                                                                    |
| ---------------------------------- | ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `players.ts:getPlayerBio` fallback | names the two columns **explicitly** | PostgREST 42703 for the whole request → blank team, blank position, no jersey for every substitute player. **Now logged** (`getPlayerBio fallback failed:`); it does not throw. |
| stats tables, leaderboards         | `select("*")`                        | keep working, draw the old monogram — the defect this branch fixes, silently un-fixed                                                                                           |

Deploying `0044` first is harmless at any time: the columns are additive and
nothing reads them until the code lands. The gate is restated at the top of the
migration itself and beside the `select` in `players.ts`.

**Watched 2026-09-06:** the four view bodies were diffed token-by-token against
the migrations that last issued them (0024 for `v_skater_stats`, 0037 for the
other three). They are identical apart from the two appended columns and the
`or replace` the two totals views needed. No dropped predicate, no changed join,
no reordered column.

## 2. What shipped

| Step                         | Commit      | What                                                                                                 |
| ---------------------------- | ----------- | ---------------------------------------------------------------------------------------------------- |
| 1 — team-logo ink and crests | `553b42d`   | 15 of 19 `TeamLogo` call sites never passed `logoPath` / `textColor`; all now do. Migration 0044.    |
| 3 — sign-out destination     | `6ada257`   | `/<league>` instead of `/login`; slug posted as a hidden field and **resolved**, never interpolated. |
| 2 — one chrome               | `8455541`   | Header moves to `[league]/layout.tsx` for every page; `ManageNav`'s shell deleted; `crossLink` gone. |
| review fixes                 | this commit | §3–§5 below.                                                                                         |

⛔ **No guard moved.** `(public)`'s `requireVisibleLeague`, `(manage)`'s
`if (!user) redirect("/login")` and every `requireLeagueManager` /
`requireGameRole` are where they were. All 11 `(manage)` pages were audited
individually; `e2e/27-one-chrome.spec.ts` asserts that a page which left the nav
is still refused by its own guard.

## 3. The header budget — RE-MEASURED 2026-09-06

Summing the bar's children plus gaps and padding against its own client width,
at 768px. The 2026-09-05 figures in `site-header.tsx` were stale in BOTH
directions: the password work added a "Password" link to the cluster, and this
branch removed the "Manage" cross-link.

| viewer                            | cluster   | bar with nav inline, at md (768) | was       |
| --------------------------------- | --------- | -------------------------------- | --------- |
| anonymous                         | **110px** | **697** — 71px slack             | 110 / 697 |
| signed in, member                 | **336px** | **923** — over by 155            | 325 / 912 |
| signed in, stranger to the league | **261px** | **848** — over by 80             | 190 / 777 |

Anonymous is unchanged to the pixel, which is what says the method matched. The
conclusions are the ones they were, by a wider margin: the inline nav starts at
`lg` signed in (923 / 1024, 101px clear) and `md` anonymous, and the switch stays
keyed on `user` rather than `member`.

## 4. Two behaviour changes, decided rather than overlooked

### ⚖️ Both of §4's open questions were DECIDED 2026-09-06 — do not re-open them silently

- **The staff row stays non-sticky.** The user was shown the measurement and both
  candidate fixes with their costs, and chose to ship it as it is and revisit only
  after using it. It already behaved this way on the three shared pages that
  predate this work, so it is at least consistent. Neither candidate was built.
- **The picker keeps published-first, then the viewer's own.** Chosen over
  interleaving by `created_at`: the public list is what the page is _for_, and a
  member's unpublished leagues read as an appendix only they can see. The
  alternative would mean widening both reads to carry a date column neither
  returns today.

### The staff row no longer sticks — measured, not assumed

`ManageNav`'s deleted shell was `sticky top-0 z-40`, so a manager's links stayed
pinned down a long audit or season page. The row does not, and `sticky top-14`
does **not** restore it. Measured 2026-09-06, signed in:

| viewport | header height                                                | staff row height |
| -------- | ------------------------------------------------------------ | ---------------- |
| 1280     | **57px** (`h-14` bar + its 1px border)                       | 41px             |
| 1024     | 57px                                                         | 41px             |
| 768      | **98px** (bar + the league links' own row inside the header) | 41px             |
| 390      | 98px                                                         | 41px             |

A row pinned at 56px therefore slides _underneath_ the header at `md` and below
and, being 41px tall, disappears entirely after ~42px of scroll. Two candidates
were left unbuilt, and both want a decision rather than a guess:

- `lg:sticky lg:top-[57px]` — measures correctly at 1024 and 1280, does nothing
  below. Needs a background decision: `bg-muted/30` over scrolling content shows
  it through, where `ManageNav`'s row sat inside a `bg-background/80
backdrop-blur` header. Changing that alpha is a visible design change.
- a wrapper making header + row one sticky unit — no magic number, but it adds a
  `<div>` around `<header>` and would have to be conditional to keep an anonymous
  visitor's markup byte-for-byte unchanged.

### The picker lists member leagues, badged

Removing the "Manage" cross-link left a **staged** league reachable from nowhere
on `/`: `getPublicLeagues` filters `is_public`, and for a single-league manager
the cross-link pointed at exactly that league while `LeagueSwitcher` renders
`null` below two leagues. The user chose listing member leagues over restoring a
narrower link.

⚠️ **Staged is READ from `is_public` on the row.** It was first derived as
"reachable by this account, absent from the public list", on the reasoning that
`getPublicLeagues` filters that exact column so absence is the same fact by
another route. A review round found that equivalence holds only while the public
read succeeds and returns everything: it returned `[]` on any error (that error
was discarded), and PostgREST caps a read at `max_rows` 1000. Both make a public
league _absent_, and the badge then asserts "Not yet public" over a league the
public can see — the one thing this badge exists to prevent, failing in the
harmful direction. `getMemberLeagues` now selects `is_public` and returns a type
one field wider than `LeagueOption`; `getPublicLeagues` logs its error. The slug
set survives, but only to deduplicate a league that is both public and yours.

## 5. Where the reasoning lives now

- `src/components/shared/staff-links.tsx` — was `components/manage/manage-nav.tsx`.
  Renamed because it no longer exports `ManageNav` and is drawn by the public
  layout. Carries the `MAX_INLINE_LINKS` obituary, the accepted duplicate-nav
  cost (`99f44d1`), the sticky loss, and the 390px flex measurement.
- `src/components/shared/site-header.tsx` — the bar's width budget (§3).
- `src/app/[league]/layout.tsx` — why drawing the header above the visibility
  gate exposes nothing: `leagues` has three SELECT policies whose disjunction is
  `decideLeagueVisible` restated, so anyone who resolves a league already passes
  the gate. `requireVisibleLeague` is kept as the app half of a mirrored pair.
- `src/lib/actions/auth.ts` — why the sign-out slug is resolved, not interpolated.

## 6. Environment

- `.env.local` pins `NEXT_PUBLIC_SITE_URL=http://localhost:3000`. In a worktree
  on any other port, `e2e/24-password-auth.spec.ts` fails with
  `ERR_CONNECTION_REFUSED` — the emailed recovery link redirects to :3000. Export
  a matching `NEXT_PUBLIC_SITE_URL` alongside `PORT`.
- Worktrees share ONE local Supabase. Serialize e2e runs; a `db reset` from
  another worktree drops 0044's columns until this branch's migrations are
  applied again. `e2e/25` now captures and restores the exact rows it changes
  rather than writing schema defaults back, because that damage outlives the run.

## 7. What the spec's audit got wrong

The 19-row `TeamLogo` call-site table was **exactly right** — no missing rows, no
spurious ones. Four things around it were not, and they are recorded here because
the spec is still the file someone reaches for:

1. **§3's claim that the standings view carries `team_logo_text_color` is false.**
   It does not. `getStandings` side-reads it from `teams` via `season_teams`, a
   decision documented in `src/lib/queries/standings.ts` and left standing;
   `logo_path` was added to that same read. Migration `0044` was for the four
   _stats_ views only.
2. **`crossLink` had three callers, not two** — `src/app/page.tsx` passed one too.
3. **`/set-password` renders no `AccountCluster`**, so it has no sign-out control
   and cannot test the `/` fallback. The league picker is the page that draws the
   cluster with no league, and `26-sign-out-destination.spec.ts` uses it instead.
4. **§4 omits the league switcher**, which lived inside the deleted `ManageNav`
   shell and had three e2e tests across specs 15/16/20. See §4 above for where it
   went and why it cannot live in `AccountCluster`'s `children` slot.

## 8. Measured, and deliberately not done

**Measured** — unit **379 tests / 31 files**; full e2e **205 passed, 1 skipped, 0
failed**; typecheck, `eslint src e2e` and `prettier --check` clean over everything
this branch touches. The 5-test `src/components/shared/team-logo.test.ts` **passed
on its first run** — the control confirming `TeamLogo` was never the bug.
⚠️ `npm run gen-types` output was prettier-formatted to keep the diff to the 8 new
columns; it also picked up one pre-existing drift, `player_in_my_league`, missing
from the committed types.

**Not done, deliberately:**

- In `schedule-builder-panel.tsx`, only the `select` column list and the two
  `<TeamLogo>` calls. Nothing in `actions/schedule.ts`, `lib/schedule/*`, the
  generate/publish/remove/one-off forms, or `actions/games.ts` — a parallel
  session owns those (PR #38).
- `/manage/office`'s missing chrome, and a `slug ~ '^[a-z0-9-]+$'` CHECK
  constraint: both out of scope, the second needs a migration.
- **Five pre-existing plan/spec docs still fail `prettier --check`** (2026-07-30
  ×2, 2026-08-12 ×2, 2026-08-13). Not this branch's, and reformatting them would
  be the repo-wide prettier commit that becomes merge conflicts for the parallel
  session.
