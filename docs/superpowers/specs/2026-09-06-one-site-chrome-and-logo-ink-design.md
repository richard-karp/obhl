# One site, not two — merged chrome, team-logo ink, and where sign-out lands

**Protocol — read this and nothing else to resume.**

1. This file is self-contained: the ask, the full call-site audit, the hazards,
   the three steps and the acceptance bars are all below. ⛔ **Do NOT read
   `LAUNCH_READINESS_HANDOFF.md` (867 lines)** — nothing in it blocks this work.
   ⚠️ **`ACCESS_CONTROL_HANDOFF.md` (244 lines) is worth ONE targeted read** before
   step 2 — its *Traps* section only. Every manage page guards itself; that is what
   makes the chrome change safe, and §4 explains why.
2. ⛔ **Hazards, before any instruction:**
   - ⛔ **THE GUARDS ARE NOT THE CHROME. Do not remove a single guard.** This
     change moves headers. Every `requireLeagueManager` / `requireGameRole` call
     stays exactly where it is, and `(manage)/layout.tsx`'s `if (!user)
     redirect("/login")` stays too. A page that stops being reachable from a nav is
     still reachable by typing its URL, and the guard is the only thing between
     that URL and the data.
   - ⛔ **Do not touch the schedule builder or any scheduling action.** A parallel
     session owns those, and publishing is a one-way door with a 2026-09-10
     deadline. If a logo fix lands you in `schedule-builder-panel.tsx`, change the
     `<TeamLogo>` props and its `select` list and **nothing else in that file**.
   - `supabase db reset --linked` **wipes production**. Use `db push`.
     ⚠️ **This change probably needs no migration** — `logo_text_color` already
     exists (`0041`) and is `not null default 'light'`. It needs one **only** if a
     database VIEW has to expose a column it does not already carry; see §3.
   - **Mutating `gh` and `vercel env` are denied to an agent.** Read-only works.
   - ⚠️ **Never bare `git stash`** — the tree is shared. `git stash push -u -m
     "<tag>"`, then `apply`, not `pop`. **Re-check the branch before every git
     write**; another session commits here.
3. Claims are marked. **Watched** means a command was run and its output read.
   **A reading** means it follows from the code and has not been executed.
4. Verify with `npm run typecheck && npm test`, then `PORT=<yours> npm run test:e2e`.
   ⚠️ **Re-measure the baseline, do not quote one.** Export a distinct `PORT` and
   `lsof -ti:$PORT` before believing a red run. Worktrees share ONE Supabase
   database, so serialize e2e.

---

## 1. The ask, in the user's words

> - Dark lettering on the logos does not seem to be present in schedule blocks but
>   I'm not sure this is true elsewhere. Fix this.
> - Why do I see manager and view site links? There shouldn't be a separate site
>   for managers they should just have more options for actions to take/pages to
>   view. All options for them to take should be visible/toggleable when viewing
>   the site.
> - When a staff signs out they should be brought to the hp not the email enter
>   screen.

**Two decisions the user made on 2026-09-06, when asked:**

- **Staff chrome: always visible, no toggle.** One header everywhere; a staff
  member always sees their extra links in a row beneath it. No "Manage" link, no
  "View site" link, no mode to be in or out of.
- **Sign out lands on the league's public home** (`/<league>`), not `/` and not
  `/login`. The league has to be plumbed through to `signOut`, which does not
  receive it today.

## 2. The logo bug — diagnosed, with the full audit

**It is not a styling bug. `TeamLogo` is correct and always has been.** It takes
`textColor` (`"dark"` → `text-slate-900`, anything else → `text-white`) and
`logoPath` (an uploaded image instead of the monogram). Its own doc comment names
the failure mode exactly: *"the `null` a caller that has not plumbed the column
through will pass."*

**The bug is that most callers never pass them.** Watched 2026-09-06 by reading
every call site:

| Call site | `logoPath` | `textColor` |
|---|---|---|
| `(public)/teams/page.tsx:65` | ✅ | ✅ |
| `(public)/teams/[slug]/page.tsx:138` | ✅ | ✅ |
| `manage/roster-editor.tsx:177` | ✅ | ✅ |
| `manage/team-branding-form.tsx:54` | n/a — live preview | ✅ |
| `(manage)/seasons/[seasonId]/page.tsx:199` | ❌ | ✅ |
| `public/standings-table.tsx:56` | ❌ | ✅ |
| `(public)/players/[playerId]/page.tsx:89` | ✅ | ❌ |
| **`manage/schedule-builder-panel.tsx:762`** | ❌ | ❌ |
| **`manage/schedule-builder-panel.tsx:768`** | ❌ | ❌ |
| `(manage)/dashboard/page.tsx:218` | ❌ | ❌ |
| `(manage)/dashboard/page.tsx:247` | ❌ | ❌ |
| `(public)/page.tsx:125` | ❌ | ❌ |
| `public/skater-stats-table.tsx:171` | ❌ | ❌ |
| `public/goalie-stats-table.tsx:168` | ❌ | ❌ |
| `public/game-row.tsx:28` | ❌ | ❌ |
| `public/box-score.tsx:26` | ❌ | ❌ |
| `manage/score-board.tsx:289` | ❌ | ❌ |
| `(public)/players/[playerId]/page.tsx:361` | ❌ | ❌ |
| `(public)/players/[playerId]/page.tsx:435` | ❌ | ❌ |

**19 call sites; 4 correct, 15 wrong in one way or the other.** The user's guess
was right and understated: the schedule blocks are the worst case — missing
**both** — but so are the dashboard, the league home, both stats tables, the game
row, the box score and the score board.

⚠️ **Missing `logoPath` is the bigger of the two defects**, and it is invisible
until a team uploads a logo: the chip falls back to a monogram, so a team with a
real crest shows initials on eleven screens. Fix both together — they are the same
`select` list and the same two props.

⛔ **`logo_text_color` has NO effect once `logo_path` is set** (stated in `0041`'s
own column comment — that branch renders the image and draws no letters). So
passing `textColor` without `logoPath` is not a partial fix; on a team with a logo
it changes nothing at all. **Always plumb both.**

## 3. Where the columns have to come from

Three shapes, and they are not equally cheap:

1. **Direct `teams` reads** — add `logo_path, logo_text_color` to the `select`.
   Cheap. This covers the schedule builder, the dashboard, the season page.
2. **Joined `teams` reads** — the embedded selector already names columns, e.g.
   ``home:teams!games_home_team_id_fkey(name, color)`` in
   `schedule-builder-panel.tsx`. Add the two columns inside the parentheses.
3. **Database VIEWS** — `src/lib/queries/standings.ts` and
   `src/lib/queries/players.ts` read views that expose team columns under prefixed
   names (`team_logo_text_color`, `team_logo_path`). ⛔ **A view that does not
   already carry a column cannot be fixed in TypeScript.** If one is missing,
   that is the one migration this work needs: a `create or replace view` adding
   the column, then `npm run gen-types`.

⚠️ **Check before writing a migration.** `grep -rn 'team_logo' supabase/migrations/`
and read what the views already expose. **A reading, not a measurement:** the
standings view is known to carry `team_logo_text_color` because the table uses it;
whether it also carries `team_logo_path`, and what the stats and player views
carry, has **not** been checked and is step 1's first job.

## 4. The chrome merge — what makes it safe, and what it must not become

**Today there are two headers and they are the same header wearing different
clothes.** `SiteHeader` (public pages) offers a "Manage" cross-link; `ManageNav`
(manage pages) offers "View site". Both draw the same `AccountCluster`. The user
is right that this is one site pretending to be two.

**The shape already exists.** `StaffLinks` in `manage-nav.tsx` is exactly the
target design — a staff row beneath the public header — and its own comment
explains why it is a row and not a replacement: *"A shared page is a public page
with more on it, and this is the more."* This work generalises that from three
shared pages to every page.

### What moves

- Chrome moves up to `[league]/layout.tsx`, which already resolves the league for
  everything beneath it: render `SiteHeader`, and beneath it `StaffLinks` when the
  viewer is a member.
- `(public)/layout.tsx` keeps its `is_public` check. `(manage)/layout.tsx` keeps
  its `if (!user) redirect("/login")`. **Only the chrome moves; both guards stay.**
- `ManageNav`'s header shell is deleted. Its `LINKS` map, `staffLinks()` and
  `StaffLinks` survive — they are the content.
- The `crossLink` prop on `AccountCluster` loses both its callers and goes with
  them.

### ⛔ Hazards that look like tidying

- **The header overflow numbers are load-bearing and were measured, not guessed.**
  `site-header.tsx` carries a re-measurement from 2026-09-05 (signed-in cluster
  325px vs anonymous 110px; the inline nav starts at `lg` signed-in, `md`
  anonymous), and `manage-nav.tsx` carries `MAX_INLINE_LINKS = 5` with the
  arithmetic behind it. ⚠️ **A staff row beneath the bar does not change the bar**,
  so these should survive untouched — but if you move an element into or out of the
  bar, **re-measure**; do not adjust a number by eye.
- ⛔ **`AccountCluster`'s element ORDER is load-bearing.** With no session it must
  render `children` and the theme toggle and nothing else — byte-for-byte what an
  anonymous visitor saw before it existed. Removing `crossLink` is safe because it
  is already inside the `user` branch. **Adding anything unconditional is not.**
- ⚠️ **`aria-label` on each nav is load-bearing.** `NavLinks` is labelled
  "League" and `StaffLinks` "Staff tools" precisely because two unnamed
  `navigation` landmarks are indistinguishable to a screen reader. Two navs on
  every page is now the normal case, not the exception.
- ⚠️ **A manager of league A viewing league B must not get a staff row.** The
  existing rule is membership, not role — `SiteHeader` already resolves
  `isLeagueMember` and passes `null` for a non-member's role, with a comment
  saying why. **Gate `StaffLinks` on the same `member` boolean**, never on
  `user.role`.
- ⚠️ **`(manage)` and `(public)` are route groups, so they do not appear in URLs.**
  Nothing here changes a URL. If a step wants to move a page between groups, that
  is the URL-space work (item 8, shipped as #31) and is **not** this change.

## 5. Sign-out

`signOut` (`src/lib/actions/auth.ts:248`) ends the session and `redirect("/login")`.
Landing a person on the email-entry screen after they deliberately left reads as
a failed sign-out.

- Target: **`/<league>`** — the public home of the league they were in.
- ⛔ **The action does not receive a league today.** Plumb it as a hidden field on
  the sign-out form in `AccountCluster`, whose callers all know the slug.
  ⚠️ **Validate it server-side** — it arrives from the client and becomes a
  redirect target. Resolve it with `resolveLeagueBySlug` and fall back to `/` if it
  does not resolve, rather than redirecting to whatever was posted.
- ⚠️ **Fall back to `/` when there is no league in context** — the league picker
  and `/set-password` render the cluster too.

## 6. Steps

TDD throughout: write the failing test, **watch it fail for the right reason**,
then the minimal code. Commit per step. ⛔ Steps 1 and 3 are independent of step 2;
do them first so the risky one lands on a green tree.

### Step 1 — team-logo ink and images, everywhere
1. **First**, read what the views expose (§3) and write down what you find.
2. Unit-test the rendering contract: `textColor="dark"` gives dark letters,
   `logoPath` set renders the image branch. **Watch it pass** — this is the
   control proving `TeamLogo` is not the bug.
3. Fix the call sites in the table in §2, adding the columns to each `select`.
   ⛔ In `schedule-builder-panel.tsx`, touch **only** the `select` list and the two
   `<TeamLogo>` calls — a parallel session owns that file.
4. If a view is missing a column: `create or replace view` migration, `db push`,
   `npm run gen-types`.
5. One e2e that sets a team to dark ink with a logo and asserts it renders
   correctly on the schedule and on the league home.

### Step 2 — one chrome
1. e2e first: signed in as a manager, visit a **public** page and assert the staff
   row is present; assert no "Manage" and no "View site" link exists anywhere.
   Assert an anonymous visitor sees no staff row. **Watch all of it fail.**
2. Move the chrome to `[league]/layout.tsx`; gate `StaffLinks` on `member`.
3. Delete `ManageNav`'s header shell and `AccountCluster`'s `crossLink`.
4. ⛔ Re-run the whole e2e suite, not just your specs. This changes every page's
   chrome, and the suite is full of header selectors.

### Step 3 — sign-out
1. e2e: sign in, sign out from a league page, assert the URL is `/<league>` and
   the page shows a signed-out header. **Watch it fail.**
2. Hidden field, server-side validation with `resolveLeagueBySlug`, `/` fallback.
3. Test the fallback explicitly — sign out from `/set-password`, which has no
   league.

## 7. Out of scope — raised, deliberately excluded

- A toggle for the staff row. **The user chose always-visible**; do not add one.
- Inline per-page staff controls (Edit on a team page, Reschedule on a game row).
  It was offered as an option and not chosen. The row is the whole change.
- Moving any page between `(public)` and `(manage)`, or changing any URL.
- Removing or weakening any guard. See the hazard in the protocol.
- The team-branding form's own preview, which is correct.

## 8. Acceptance

- `npm run typecheck && npm test` clean; **the full** `npm run test:e2e` green.
- A team with dark ink shows dark letters on every screen in §2's table; a team
  with an uploaded logo shows the image on every one of them.
- A signed-in manager sees the same URL, the same page and one header everywhere,
  with a staff row beneath it. No "Manage" link and no "View site" link exist.
- An anonymous visitor's header is unchanged, byte for byte.
- A manager of another league browsing this one gets **no** staff row.
- Sign out from a league page lands on `/<league>`; sign out from `/set-password`
  lands on `/`; a posted slug that does not resolve lands on `/` rather than
  wherever it pointed.
