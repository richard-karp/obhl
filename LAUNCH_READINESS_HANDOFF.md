# Launch readiness — what stands between this and two live leagues

**Protocol — read this and nothing else to resume.**

1. This file is self-contained. `ACCESS_CONTROL_HANDOFF.md` (~225 lines) holds
   the membership model and its traps — open it only when auditing another action.
   Do **not** read `docs/superpowers/specs/2026-08-31-per-league-routing-design.md`
   (383 lines); nothing outstanding depends on it.
2. ⛔ **Hazards, before any instruction:**
   - `supabase db reset --linked` **wipes production**. Use `db push`.
   - ✅ **The lockout risk is closed as of 2026-09-05.** All three legs are
     accounted for: the JWT hook degrades to a `profiles.role` lookup (#24,
     workstream D1), and SMTP and the redirect allow-list were both exercised
     end to end by a real magic-link sign-in that day. What that sign-in
     exposed instead is the failure BELOW those legs — a session with no
     `profiles` row signs in fine and is offered nothing. Recovery is still
     SQL. See *Getting locked out*.
   - ⛔ **A SCHEDULE PUBLISHED WITH A PAST DATE LOCKS THE SEASON INSTANTLY AND
     FOR GOOD.** `season_is_started` (`0026`) counts only `not is_draft`, so a
     past-dated DRAFT is invisible to the gate and looks completely fine — until
     it is published, at which point generate, replace and remove all refuse
     permanently. The builder's "First game night" pre-fills from the season's
     `starts_on`, is `required`, and has **no `min`**; `generateSchedule` never
     checks it either. *Verified in the code 2026-09-05, not reproduced against
     production.* **Read that date before publishing.** ⚠️ A ~20-minute guard
     closes it without waiting for PR #23 — see *Item 9* below.
   - **Mutating** `gh` (`pr create`, `pr merge`) and `vercel env` are denied to
     an agent under the auto-mode classifier — ask a human, do not work around
     it. **Read-only `gh` works**: `run list`, `run view`, `run download`. On a
     red CI run, pull the artifact and read `error-context.md` yourself; its
     page snapshot has twice settled in seconds what guessing got wrong.
3. ⛔ **The hot tier — everything above *The items* — is capped at 130 lines.**
   Adding to it means evicting something to a section below, in the same edit.
   Count first (`awk '/^## The rule item 6/{print NR; exit}'`), decide what
   leaves, then write to the space you freed. Raise the number deliberately and
   say why, or it drifts two lines at a time and the file stops being cheap.
4. Every number here was **watched appear**. Where a claim is a reading of the
   code rather than a measurement, it says so in those words.
   ⚠️ Production was read again on **2026-09-05**, after #31 merged:
   `migration list --linked` shows `0001`-`0043` on Local, Remote **and**
   Applied — no drift. `0005` and `0017` are absent from every column and always
   have been: those numbers were never used, 41 files span `0001`-`0043`, and
   the sides agree. Not a gap; do not try to repair it.
   `vercel env ls` (2026-09-04) shows `ENABLE_DEV_LOGIN` absent from every
   environment. The auth user list is still **unread from here**; item 2 was
   closed by a human and is taken on report, not measured.
   ⛔ **`migration list --linked` needs the link, and worktrees do not have
   it.** `supabase/.temp/` is gitignored, so only the checkout that ran
   `supabase link` carries `project-ref` and `linked-project.json`. ⚠️ Do NOT
   reach for `--workdir <main checkout>` to borrow it: that also switches which
   `supabase/migrations` directory is read, so a `db push` aimed at the main
   checkout pushes whatever is on `main` and silently skips the migrations that
   exist only on your branch. Copy those two files into the worktree's
   `supabase/.temp/` instead, or re-run `supabase link` there.
5. Verify code changes with `npm test && npm run test:e2e`. Measured on CI at
   `f131d6c` (`main`, the #31 merge), 2026-09-05: **28 unit files / 365 tests;
   183 e2e passed / 1 skipped / 0 failed** in 7.5m, across 23 spec files. The
   skip is the AI-summary test, gated on an API key — not a regression.
   ⚠️ The counts move with every merge; re-measure rather than quoting them.
   ⛔ **Run e2e against a dev server belonging to YOUR worktree.** Playwright's
   `reuseExistingServer` takes whichever server is already up, so a suite can
   silently drive another branch's code and report it as yours — nine phantom
   failures on 2026-09-04. **Since #24 the port is a variable**: export a
   distinct `PORT` per worktree and `playwright.config.ts` derives both
   `baseURL` and `npm run dev -p` from it, so the two can never disagree. It
   still defaults to 3000, so two worktrees that both forget still collide.
   `lsof -ti:$PORT` before believing a red run.

**Status: both doors are shut and every migration is pushed.** As of
2026-09-05 `ENABLE_DEV_LOGIN` is gone from every Vercel environment, the seeded
accounts are deleted, and production carries `0001`-`0043` — including `0037`,
which fixed GAA being inflated by empty-net goals on live pages; `0039`-`0041`,
which #24's manage tools read; and `0042`/`0043`, which let a league's own
scorekeepers and captains read it before it is public (*Member reads*, below).

⚠️ **THIS FILE IS NOT ON `main` YET.** It lives on `docs/readiness-and-url-space`
(PR #33, CI green). `main`'s copy still says migrations are unpushed and a
sign-in is unverified — both false. Merging #33 is what stops the next reader
being misled. PR #34 (export 404s, CI green) and PR #23 (future-only scheduling
docs, unmerged and far behind) are the other two open.

**What remains is item 4: the `LAUNCH.md` phases — and it now has a date on
it.** The published season's first game night is **2026-09-10**, after which its
schedule is locked for good. Item 5 is deferred odds and ends, item 7 is the
half of the auth work that a checkout cannot do.

## Next action

⛔ **THE MANAGER IS REBUILDING THE SCHEDULE, AND THE WINDOW SHUTS
THURSDAY 2026-09-10 23:00 UTC.** Stated intent (2026-09-05): discard the current
draft and generate a new one. 144 games are published, first one that Thursday,
all still in the future — so nothing is locked yet.

**The safe sequence, and it is not the obvious one.** Publishing IS the replace:
`publishSchedule` calls `replace_published_schedule`, which deletes the live
games and promotes the draft in ONE transaction. So generate and review while the
old schedule stays up, then publish.

1. `/lcc-old-boys-hockey-league/schedule-builder` → **Discard** (drafts only —
   `discardSchedule` filters `is_draft = true`, has no lock gate, and cannot
   touch a published game). Repeatable, costs nothing.
2. **Generate**, review, regenerate as often as wanted.
3. **Publish** — the one-way door. ⛔ Check the date field first; see the lock
   hazard in the protocol above.

⛔ **Do not press Remove first.** `0027`'s own comment says why the delete and
the promotion are one transaction: run as two, "a failure between them leaves the
season with ZERO games" — schedule page, both feeds and the CSV all empty. Remove
is for abandoning a season's schedule, not for rebuilding one.

⚠️ The lock also trips on `status <> 'scheduled'` or any goals, so a scorekeeper
touching a game closes the window early. And every regenerated game gets a new
id, so all 144 calendar UIDs change and subscribers see their events replaced.

**Then the rest of `LAUNCH.md` Phases 2-6** — steps 4, 5 and 6 of its
*Verification* list, which need a session. Nothing else outstanding can be done
from a checkout.

✅ **Sign-in, the app guard and RLS were all verified on production 2026-09-05**
— see *Verified on production* under item 4. ⛔ **Test `/<slug>/dashboard`, never
`/`**: a completed sign-in lands on `/`, which shows no badge to anybody, and
that cost a round of misdiagnosis here. ⚠️ That URL was `/<slug>/manage/dashboard`
when it was verified; #31 removed the `/manage/` prefix the day after, and
`next.config.ts` redirects the old one.


## The rule item 6 leaves behind — push migrations BEFORE merging their code

⛔ **A merge deploys. If the code reads a table production does not have yet,
the deploy is the outage.** Vercel builds `main` on merge, so the window between
"merged" and "migration applied" is served to real users. `0039`-`0041` went to
Remote first on 2026-09-05 and #24 merged after, which is the order to keep.

⚠️ **The reason to care is that the failures are not uniform, and the quiet ones
are worse than the loud one.** Had it gone the other way, #24 would have shown:

- **Public standings degrading by design** — `getStandings` logs and carries on
  and `inkOf` falls back to null, which `TeamLogo` renders as the white letters
  it drew before `0041`. Nobody sees anything wrong.
- **`archivedPlayerIdsIn` returning an empty set**, so nobody looks archived and
  every removed player is back in every picker — a correct-looking page showing
  the wrong league.
- **The manage roster page 404ing** — `teams` is read with an explicit
  `logo_text_color` in the select list and `if (!team) notFound()` follows, so
  the whole page goes rather than the colour.

*A reading of the code, not a probe — the order held, so none of it happened.*

    npx supabase migration list --linked      # what is Local-only?
    npx supabase db push
    npx supabase migration list --linked      # confirm both columns

⚠️ **`--include-all` when, and only when, a number sorts BELOW the latest
applied one.** `db push` silently skips those. `0039`-`0041` all sorted above
`0038`, so plain `db push` was enough — but `0034` needed the flag, and parallel
workstreams that pre-assign migration numbers land out of numeric order by
design, so assume the gap and check the list rather than the flag.

⛔ Never `db reset --linked`; it wipes production.

## The items, and where they stand

| # | Item | Where | Status |
|---|---|---|---|
| 1 | `ENABLE_DEV_LOGIN` set on production | Vercel env | ✅ **closed 2026-09-04** — absent from every environment (`vercel env ls`) |
| 2 | Seeded test accounts live, password in git | Supabase dashboard | ✅ **closed 2026-09-04** — done by a human; not verifiable from a checkout |
| 3 | `0033` not pushed — the RLS half of the escalation | `supabase db push` | ✅ **closed** — and `0034`-`0038` with it |
| 4 | **`LAUNCH.md` Phases 2-6 never verified** | production | ⛔ **OPEN, AND ON A CLOCK** — Phase 6's first game night is 2026-09-10; sign-in, access control and the anonymous half of *Verification* are done; steps 4-6 of that list need a session |
| 5 | Smaller deferred items | below | open |
| 6 | `0039`-`0043` not pushed | `supabase db push` | ✅ **closed 2026-09-05** — `0039`-`0041` before #24 merged, `0042`/`0043` after #31; `migration list --linked` shows all five on both sides |
| 7 | Staff can set a password, but only a commissioner can give them one | Supabase dashboard + `vercel env` | **OPEN** — needs a human; *The other half of auth* |
| 8 | **Unified URL space** — drop the `/manage/` prefix, merge the duplicated pages | code | ✅ **closed 2026-09-05** — steps 1-6 shipped as #31 (which collapsed #25-#29); step 7, the prose, is this commit. Spec: `docs/superpowers/specs/2026-09-05-unified-url-space-design.md` |
| 9 | **A past first-game-night locks the season on publish** | code | ⛔ **OPEN** — no `min` on the input, no check in `generateSchedule`; the one irreversible mistake available in the builder. a ~20-minute guard is specced in *Item 9 — the cheap guard*; PR #23 is the larger answer and is NOT needed for this |

⛔ **Do not re-file 1-3.** They are kept as rows, rather than deleted, because a
reader who knows this file by its old shape will otherwise assume they were
forgotten. The reasoning behind each is under *Closed doors* below.

⛔ **Do not re-file 6 either.** It is kept for the same reason as 1-3, and
because the ORDER it was closed in is the reusable part — see *The rule item 6
leaves behind* above.

⚠️ **6 and 7 both arrived with #24** (`feat/manager-tools`: schedule
constraints, roster editing, team branding, staff auth, season gating), merged
2026-09-05 as `b244f65`. Item 7 is the one still open: a standing limitation
that needs an account created outside this repo.

---

## Closed doors — 1, 2 and 3, and why they mattered

**1. `ENABLE_DEV_LOGIN`** turned on the one-click role buttons
(`devLoginEnabled()`, `src/lib/auth/dev-login.ts`) on a production build.
Removed 2026-09-04; measured absent from Production, Preview and Development.

**2. The seeded accounts** were a separate door, and removing item 1 did not
close it: `scripts/seed-users.mjs` sets a password constant committed to this
repo, and Supabase's password grant is reachable with the anon key — so those
accounts were a way in regardless of any application setting. Seven exist now
(`commissioner@` and `deputy@` joined with the League Office). Deleted on
production 2026-09-04.

⚠️ **The mechanism is still live for anyone who re-seeds.** The password is still
in git and always will be; a fresh `npm run seed:users` against a production
database re-opens this door in one command. It is safe only because nobody runs
it there.

**3. `0033`** swapped `manager write profiles` from *sharing* a league — which a
manager can arrange — to containment. Both steps of that escalation were once
watched succeeding on the anon key. Pushed, along with `0034`-`0038`.

## The League Office (`0034`) — live but dormant

`0034` is applied to production (2026-09-04, `--include-all`, because it sorts
below `0035`-`0038` which shipped first). **It changes no behaviour until someone
is appointed:** `league_office` starts empty, so `my_office_tier()` is null for
every account and `may_write_profile` reduces to exactly `0033`'s containment
test. Appointing the first commissioner is *The first commissioner* below, and
until that is done nobody holds the tier.

## Member reads (`0042`/`0043`) — a staged league is no longer invisible to itself

Pushed 2026-09-05, after #31. Before them, RLS let a league be read only where
`leagues.is_public`, so a league staged for launch was invisible to the very
people preparing it: its own scorekeepers and captains got a 404 at the league
itself and — with `0042` alone — a page that then resolved and showed nothing,
because every child table was still public-only. `0043` is the other half, and
the two are one decision split across two files.

`0042` adds a `member read` policy to `leagues`; `0043` adds one to ten child
tables, through `player_in_my_league` (`SECURITY DEFINER`, so it can see past
the caller's own RLS). Policies are OR'd, so both are **purely additive** —
nothing that was readable stopped being readable, which is why nothing broke in
the window where the code was deployed and the migrations were not. This is the
one case where the ordering rule above did not bite.

⛔ **The `_is_public` helpers were deliberately NOT widened**, which is the
tempting one-line version of this change. `player_is_public` and
`game_is_public_final` read them to decide what the PUBLIC sees, so teaching
them that a member's league is "public" propagates the lie out to anonymous
visitors. The member path is a separate policy for that reason; do not
consolidate them.

## Reference — the audit log is closed; the trap under it is not

Every exported action now writes an entry. The one exception is
`previewEsportsdeskImport`, which fetches and parses and changes nothing.

⛔ **The trap stays, for whoever adds the next one.** `leagueOfEntity` in
`src/lib/audit.ts` returns `null` for any `entity_type` it does not handle, and
a null league is filtered out of every league-scoped view *and* hidden by RLS —
so a `logAudit` call added alone writes an entry that is **correct and never
appears**. Add the type to that switch in the same change, and prove it by
knocking the case out and watching a test go red. `announcement` and `league`
were watched failing that way; `office` and `player` were added later and are
listed explicitly for the same reason — ⚠️ note that deleting either changes
NOTHING, since `default` also returns null, so the regression to simulate is a
case that starts *resolving* a league. That was watched too.

An action that DESTROYS what it logs cannot use the switch at all: pass
`league_id` on the entry instead, resolved before the delete.
`deleteAnnouncement` does. `unenrollTeam` does not need to, because it is filed
under the season, which outlives the enrollment row.

`import_league` is the one entry with no test — the import fetches esportsdesk
over the network, so nothing local can drive it. Its switch case is a reading of
the code.

Count rows per action after any change here. The suite was once green while
`update_staff_role` had written zero, because nothing exercised it:

    select action, count(*), count(*) filter (where league_id is null) orphaned
    from audit_log group by action;

## 4 — `LAUNCH.md` Phases 2-6, and how they fail

### Getting locked out

**The hook leg is closed.** `getSessionUser` (`src/lib/auth/session.ts`) used
to read the role from the JWT claim with no database fallback, so a disabled
Custom Access Token hook meant sign-in appeared to succeed while every user held
`role: null` and reached no manage tools at all. Since #24 the claim is only the
fast path: when it is absent, `roleFromProfile` reads `profiles.role` through
the **normal RLS client** (`own profile read` is `id = auth.uid()`, no
`auth_role()` call, so no recursion), memoized with `cache()` because several
segments call it per render. A working session still costs no extra query.

⚠️ **It repairs a missing CLAIM, not a missing ROW.** An account with no
`profiles` row, or a row whose `role` is null, is exactly as locked out as
before — the fallback has nothing to find. The hook and the `app_role` enum were
deliberately not touched.

⛔ **That is not a hypothetical, it is the live failure mode.** Nothing creates
a `profiles` row on sign-up — there is no trigger on `auth.users` in any
migration — and `profiles.id` is `references auth.users(id) on delete cascade`,
with `profile_leagues.profile_id` cascading off `profiles` in turn. So deleting
an auth user takes its role AND its league memberships with it, and the next
magic link for that same address mints a **new** user id with neither. The hook
then adds no claim at all (`0010` writes one only `if v_role is not null`), the
fallback finds no row, and the person signs in successfully to an app that
offers them nothing. Restoring the row is *The first manager* in `LAUNCH.md`
Phase 4, plus a `profile_leagues` row per league.

⚠️ **A claim that is PRESENT but stale is not repaired either.** The resolution
is `claimed ?? profileRole`, so the claim short-circuits the lookup whenever it
exists. Change someone's role while the hook is on and it does not take effect
until their next sign-in mints a new token.

✅ **Both of those legs are now confirmed good, 2026-09-05.** A real magic-link
sign-in on `obhl.vercel.app`, to a real (non-`@obhl.test`) address, was
requested, delivered and accepted — which exercises SMTP and the redirect
allow-list end to end, the two settings that had no fallback and had never been
tested. Reported by the human who ran it; not measured from here.

⚠️ **What that sign-in did NOT show was the Manager badge — and the row was
fine.** Measured the same day: `profiles` carries `role = 'league_manager'` and
`display_name`, created 2026-09-03, with one `profile_leagues` row. So this was
NOT the missing-row case above, and not any of the three legs.

✅ **Nothing was broken. It was the URL.** `src/app/page.tsx` says so in its own
docstring: `/` is "what a bare domain, a role-denied redirect, and a completed
sign-in all land on" — and `/` renders no `ManageNav`, because the nav and its
badge live in `src/app/[league]/(manage)/layout.tsx`. A successful sign-in
therefore lands on a page that shows no badge to anybody.
`/lcc-old-boys-hockey-league/dashboard` shows it. ⛔ **Test the dashboard URL,
never `/`** — this cost a full round of misdiagnosis on 2026-09-05, and the
symptom of "signed in, no badge, no tools" is identical to a real lockout.

**`LAUNCH.md` Phase 2 is now verified; Phases 3-6 are not.** SMTP, the redirect
allow-list, the role resolution and the manage tools were all exercised end to
end on 2026-09-05 (see *Next action*), which is the whole of Phase 2's
Supabase-dashboard column bar the hook itself. This file otherwise speaks only to
Phase 1 (the test doors). ⚠️ **Production has ONE league, not two** — measured
2026-09-05: `lcc-old-boys-hockey-league` ("LCC Old Boys Hockey League"),
`is_public = true`, and it is the only row in `leagues`. Two is the goal this
file is named for, not the current state, and `LAUNCH.md`'s verification step 1
("`/` lists both leagues") cannot pass until a second one exists. The site being
live means some of the rest presumably happened — but *presumably* is the operative word: nobody has checked
SMTP, the Supabase redirect allow-list, or that the Custom Access Token hook is
still enabled. ⚠️ **The hook used to be the one that failed quietly; since #24
it degrades instead** — sign-in falls back to `profiles.role` and the tools
still open. Check it anyway: the fallback is a round trip per render on every
session it saves, and a hook that silently stopped firing is worth knowing
about. SMTP and the allow-list have no such fallback.
⚠️ **Phase 6 carries the only hard deadline in the project.** A published
season locks the moment its first game night passes — `season_is_started`
(`0026_replace_published_schedule.sql`) then permanently blocks generate,
replace and remove, and no UI undoes it. If a real season is approaching, that
outranks every item above.

**PR #13 has now been reviewed** (50 files, +2545/-327, merged as `7c7c4a7`),
2026-09-02. It found one thing, and it was the important kind: the RLS write
policy on `profiles` tested *overlap* where it needed containment, so the
escalation the app had just closed still worked through PostgREST. That is item
3 above, closed by 0033 and still to be pushed.

Everything else read as sound, and is recorded here so nobody re-derives it:
every exported server action carries a league-scoped guard (the six in
`schedule.ts` all route through `targetSeasonForManager`, the twelve in
`games.ts` through `requireGameRole`); `requireLeagueManagerOf` requires the ids
to *agree*, which per-id checks cannot; every guard fails closed on a null
league, because `= null` is never true in SQL and `isLeagueMember` refuses an
empty id; and the public feed routes read through RLS, so a staged league's
schedule is empty rather than exposed — `publicLeagueOfSeason` decides only the
calendar's name.

Two deliberate looks-wrong-reads-right spots, left alone: `manager write
memberships` checks only `league_id`, so a manager may grant their own league to
any profile — that is the flow the membership model exists for, and closing
step two is what makes keeping it safe. And the manage dashboard checks
membership only for a *roled* account, because the page that explains "you have
no role yet" would otherwise be unreachable; it renders no league data.

### Verified anonymously against production, 2026-09-05

The half of `LAUNCH.md`'s *Verification* list that needs no session. Measured
with curl against `https://obhl.vercel.app`:

| Check | Result |
|---|---|
| `/` lists the leagues | ✅ 200 — but **one** league, `lcc-old-boys-hockey-league`, not two |
| `/<league>/standings` | ✅ 200 |
| An unknown slug 404s | ✅ `/nosuchleague-zzz` → 404 |
| `/api/schedule/team/<id>/feed.ics` resolves | ✅ 200, 36 events, calendar named for the league |
| `/api/schedule/<season>` and `.../schedule.csv` | ✅ 200 |

⚠️ **Verification steps 1 and 2 cannot pass as written.** They assume two
leagues; production has one. Steps 4, 5 and 6 (the badge, the league switcher,
an announcement) need a session and remain for a human — step 4 was separately
confirmed on 2026-09-05, below.

### The deadline reading, and what it could not see

⚠️ The Phase 6 date in *Next action* was derived from the public ICS feed, which by definition shows only
PUBLISHED games — it cannot see drafts. If a draft schedule is also sitting in
that season, this reading will not have found it. The authoritative version
needs the database:

    select l.slug, s.name as season, s.is_active,
           count(*) filter (where not g.is_draft) as published_games,
           count(*) filter (where g.is_draft)     as draft_games,
           min(g.scheduled_at) filter (where not g.is_draft) as first_night,
           public.season_is_started(s.id) as already_locked
    from seasons s
    join leagues l on l.id = s.league_id
    left join games g on g.season_id = s.id
    group by l.slug, s.id, s.name, s.is_active
    order by l.slug, s.starts_on desc nulls last;

### Verified on production — sign-in, the app guard, and RLS (2026-09-05)

⚠️ **A completed sign-in lands on `/`, which shows no badge to anybody.** That
is what `src/app/page.tsx` documents ("a bare domain, a role-denied redirect,
and a completed sign-in all land on" it), and it cost a round of misdiagnosis
here: the nav and its badge live only in `src/app/[league]/(manage)/layout.tsx`.
**The test is `/<slug>/dashboard`, never `/`.** Confirmed working at
`/lcc-old-boys-hockey-league/manage/dashboard`, Manager badge shown — that was
the URL on the day; #31 dropped the `/manage/` prefix and `next.config.ts`
redirects it, so the check to repeat is `/lcc-old-boys-hockey-league/dashboard`.

**The app guard.** Every manage route answers `307 -> /login` with no session
cookie — `dashboard`, `people`, `rosters`, `schedule-builder`, `audit`, and
`/manage/office` — while `/lcc-old-boys-hockey-league/standings` serves `200`.
Measured with curl, which carries no cookies, so that is the true anonymous
case.

⚠️ **That measurement predates #31 by a day, and #31 changed the SHAPE of what
it measured.** `rosters` is not a route any more, and roster editing did not move
to another manage route — it moved onto the **public** team page, which serves
`200` to an anonymous visitor by design. "Every manage route redirects" is
therefore no longer the whole guard: the surviving redirect list still holds
(the paths lost only their `/manage/` prefix), but the editor on
`/<league>/teams/<team>` is guarded by `canManageLeague` deciding whether to
RENDER it, not by the route refusing to serve. Scoring on `/<league>/schedule`
is the same shape. ⛔ Re-probing this list would report green while saying
nothing about either. `ACCESS_CONTROL_HANDOFF.md`'s *Traps* section carries the
rule — `canManageLeague`/`canScoreLeague` are questions, not guards — and the
server actions behind those sections are what actually refuse.

**RLS, which is the half that matters.** Probed directly against PostgREST with
the publishable key, bypassing the app entirely:

| Probe | Result |
|---|---|
| `select` on `profiles`, `profile_leagues`, `audit_log`, `league_office` | `[]` each |
| `select` on `leagues`, `seasons`, `team_players` | rows — public, as designed |
| `insert` into `announcements` | `401`, `42501 new row violates row-level security policy` |
| `update` on `leagues`, `profiles`, `team_players` | `200` with `[]` — zero rows matched |

⛔ **The public reads are the load-bearing part of that table, not filler.** Had
everything returned `[]`, a wrong key or a wrong URL would look exactly like
working RLS. Public data coming back is what proves the probe reached the
database as an anonymous caller and *then* got refused. Every write was a
deliberate no-op (setting a column to the value it already held) except the
`announcements` insert, which was refused; a follow-up read confirmed no probe
row landed.

⚠️ **Only the ANONYMOUS dimension is proven on production.** Signed-in-but-wrong-
role and signed-in-but-wrong-league are proven in the fixture only
(`e2e/09-access.spec.ts`, and the five API-level tests in
`16-league-membership.spec.ts` — four refusals plus the own-league positive
control that stops them passing vacuously). Production has one account and one
league, so there is nothing there to refuse yet. **Re-probe when a second staff
member exists**, especially a scorekeeper or captain, whose dashboard should be
visibly smaller.

## Tests: never submit an unverified form tamper

The cross-league attack tests reach a server action by rewriting a form's hidden
input and submitting. Setting `.value` on a React-rendered input **before
hydration lands** is undone when React takes over, and the form then posts its
ORIGINAL value. Laptops always win that race; a 2-core CI runner does not, and
it cost two red builds before the cause was found.

Both outcomes were seen on CI:

- the original value is forbidden too → no refusal happens, the test fails
  somewhere confusing (`a roster add cannot name another league's team`);
- the original value is **permitted** → the action quietly succeeds and the test
  passes *with the attack never having happened* (`a manager can be removed from
  a league, but never yourself`, whose "self is still a member" check held
  vacuously). This is the dangerous half: a green tick over an untested guard.

All six sites in `e2e/16-league-membership.spec.ts` now go through one
`tamper()` helper that settles, sets, then asserts `toHaveValue` before anything
is submitted. **Keep new attack tests on that helper** — a raw `.value` write in
this file is a bug, and there should be exactly one, inside the helper itself.

## The first commissioner (League Office, `0034`)

Read this whole section before running anything; the block at the bottom is
copy-paste and has no commentary after it.

The League Office tier is **peer-flat** — no commissioner outranks another — so
the first one cannot be created from the app, by anyone. That is deliberate: it
is the same shape as manager demotion, and it means no single compromised office
account can empty the tier. Locally `scripts/seed-users.mjs` appoints one; on
production it is this.

Three things the snippet depends on, all enforced by `0034`:

- **The account must already exist and hold `role = 'league_manager'`.** A
  trigger refuses a tier for any other role, and it is not a formality: the
  office multiplies REACH, not ROLE, so a captain in the office would gain
  cross-league visibility and no manager powers at all.
- **Nothing touches `profile_leagues`.** The tier is purely additive, so removing
  it later restores exactly the reach the person had before, with no repair step.
- **`league_office` is granted to nobody** — not even `select`. Run this as the
  service role / SQL editor, not through PostgREST.

⚠️ Changing that person's role afterwards is refused while the tier is held; a
second trigger enforces the documented order — remove the tier first, then the
role is changeable.

Replace the address, run it in the Supabase SQL editor, and expect exactly one
row back. If it returns none, the account does not exist or is not a manager.

COPY FROM HERE
```sql
insert into league_office (profile_id, tier)
select p.id, 'commissioner'
from profiles p
join auth.users u on u.id = p.id
where u.email = 'REPLACE@example.com'
  and p.role = 'league_manager'
returning profile_id, tier;
```
END COPY

## 7 — The other half of auth: a password can be SET but not USED

⛔ **The recovery path is half-built, and the half that exists is the half that
does nothing on its own.** #24 shipped `setStaffPassword`
(`src/lib/actions/office.ts`, guarded by `requireCommissioner`, writing through
`admin.auth.admin.updateUserById`) — so a commissioner can give a locked-out
staff member a password. **Nothing on production can then sign in with it.**
`/login` renders one field and one button, both `sendMagicLink`; the only
`signInWithPassword` call in `src/` is inside `devSignIn`, which is gated on
`ENABLE_DEV_LOGIN` and that is absent from every Vercel environment (item 1).
The other two callers are e2e specs going straight to the Supabase client,
which is not a route a person has.

*A reading of the code, checked against every `signInWithPassword` and every
`type="password"` in the repo on 2026-09-05 — not a probe against production.*

**So do not reach for it in a lockout expecting it to work.** Today the button
is a bootstrap for the flow that has not shipped. What closes it, in order:

1. **Custom SMTP (Resend).** ⛔ Cannot be done from a checkout: it is Supabase
   dashboard configuration plus `vercel env` writes, and mutating `vercel env`
   is denied to an agent. Deliverable from a checkout is the written steps and
   the exact env keys — a human runs them.
2. **A self-serve set/reset-password flow**, riding on that SMTP.
3. **Only then**, a password field on `/login`. ⚠️ Magic link stays as the
   secondary path; removing it would make step 1 the only way back in, and the
   whole point of this item is not having a single one of those.

Until 1 lands, 2 and 3 cannot be verified, so none of it should ship. That is
why the sequence is written down rather than left to whoever picks it up.

## Item 9 — the cheap guard, offered and unbuilt

⚠️ **PR #23 is not the only way to close this, and reaching for it first is the
mistake this section exists to prevent.** That PR is a 1,708-line plan for
future-only scheduling as a whole — the right long answer, and far more than is
needed to stop the irreversible case. Do **not** read it to fix this.

The mitigation is two edits and a test, offered on 2026-09-05 and not taken up:

1. `min` on the date input — `schedule-generate-form.tsx`, the `start_date`
   `<Input>` around line 510, which today carries only
   `defaultValue={seasonStart}` and `required`. Browser-side only, so it is the
   half that cannot be trusted.
2. The half that can: refuse a past `start_date` in `generateSchedule`
   (`src/lib/actions/schedule.ts`, near the existing
   `if (!startDate) return { ok: false, message: "Pick a first game night." }`
   around line 379). Same shape, one condition later.

⚠️ **Guard the GENERATE, not the publish.** Refusing at publish would be the
obvious place and is worse: by then the manager has a draft they have reviewed
and can do nothing with, and the useful message — "this date is in the past" —
arrives too late to act on cheaply.

*Line numbers read 2026-09-05; re-check the symbols before trusting them.*

## 5 — Smaller, deliberately deferred

### From the sixth review of #24 — open, never triaged

⚠️ **Recorded from that review, NOT re-verified since.** Treat each as a claim to
check, not a measurement. No `/fix-all` has been run over them; the user's standing
pattern is to invoke that skill separately, and it requires an outline plus an
explicit go-ahead before any code changes.

1. `SCHEDULE_HANDOFF.md` drifted on the `slot_bias` exemption — doc, not code.
2. `constraintCredits` / `teamMetrics` have **no production reader**. Dead until
   something renders them.
3. The constraints panel applies `forcedByeCredits` **unconditionally**, rather than
   only where a forced bye caused the breach.
4. `slot_on` resolves against **two different slot lists** depending on the path in.
   The likeliest of these to be a real bug.
   ⚠️ **Confirmed 2026-09-05, and the divergence is deliberate on one side.**
   `generateSchedule` matches pins against the FORM's `slot_times`;
   `planOneOff`'s caller builds its list from the season AS PUBLISHED
   (`leagueTimeKey(g.scheduledAt)`, with `--:--` standing in for a postponed
   game), and says so in a comment. So a pin honoured at generation can fail to
   match during a one-off repair. Real, documented, low severity — not the
   silent-corruption shape the review's wording suggests.
5. The `add_player` revert **deletes a row** that the "returning player" branch only
   un-departed — so reverting an add can destroy history the add did not create.
   ⚠️ Same shape as the `0036` goalie-stats class.
   ✅ **CHECKED 2026-09-05 AND NOT REPRODUCED.** `revertAuditEntries`
   (`src/lib/actions/audit.ts`, `case "add_player"`) reads the row rather than
   the entry, counts `game_rosters` scoped to this season through `games`, and
   marks the player departed instead of deleting when that count is non-zero —
   with a comment naming the `0036` destruction explicitly. A hard delete
   happens only where nothing was played. Left in the list with this note rather
   than removed, because the next reader will otherwise re-derive it.
6. `refuteConstraints` misses `bye_in_week` on an all-zero-quota week.
7. The unbounded `players` select — **pre-existing**, not introduced by #24.
   ⚠️ Re-read 2026-09-05: it survived #31 and now carries a docstring arguing it
   is correct — the picker must offer people from other leagues, and filtering
   globally would hide someone from every league that never archived them. That
   makes it a **scale** question (`src/components/manage/roster-editor.tsx`),
   not a correctness one, and it now runs only for a manager rather than on
   every view of the team page.


- **`saveRules` read-then-upsert is not atomic** — two concurrent saves both
  read the same previous document, so one audit entry's `old_data` names
  something it did not overwrite. *A reading of the code; not reproduced.*
  Left alone: closing it means a plpgsql function and a migration, a bad trade
  for an unmeasured race on a page edited a few times a season.
- **`save_rules` entries are not revertible.** `old_data` holds what a revert
  needs, but `revertAuditEntries` (`src/lib/actions/audit.ts`) has no case and
  `isRevertible` in the audit page returns false.
- **Public detail pages answer 200 for `notFound()`** — issue #30, investigated
  2026-09-05 and **deliberately not fixed**. Measured on a production build, with
  controls: it is not dev-only, `loading.tsx` is not the cause (removed it, still
  200), and a `(public)` page throwing before any `await` returns a clean 404 —
  so the cause is that awaiting suspends and starts the stream, which Next 16
  documents under `loading.tsx`'s *Status Codes*. Next emits
  `<meta name="robots" content="noindex">` on every such body, so the soft-404
  concern is handled; what is left is monitors reading the status line. The
  documented remedy is a check in `proxy`, i.e. a database round trip on every
  page view. Full evidence, including the two failed fixes, is on the issue —
  ⛔ do not re-run those experiments.
- **CI does not run `npm run lint`**, though the script exists.
- **No `.nvmrc` or `engines`** — `.github/workflows/ci.yml` is the de-facto
  source of truth for the Node version (22).
- **The generator has TWO bounds, and which one binds depends on where it
  runs.** Phase S ends at `OBHL_SLOT_RESTARTS` restarts *or*
  `OBHL_SLOT_BUDGET_MS`, whichever comes first (`assignNights.ts:140-141`).
  Production and the dev server take the defaults — 20,000 restarts against a
  5 s budget, so the **budget** is what ends it, which is why the e2e lever
  below is the right one. `vitest.config.ts` pins restarts to 2,000, so the unit
  suite is **restart**-bound instead: dropping it to 200 took the schedule suite
  from 3.66 s to 733 ms, while doubling the budget to 10,000 moved it not at all
  (3.67 s). ⚠️ Reaching for the budget to speed up unit tests does nothing, and
  the commit message on `4e82dae` says otherwise — it is wrong and left in
  history rather than rewritten. `vitest.config.ts` carries the correction.
- **Two Playwright timeouts are load-bearing; do not tidy them back.**
  `expect` is 15s and the per-test `timeout` is 60s
  (`playwright.config.ts`). The generator is wall-clock budgeted at
  `OBHL_SLOT_BUDGET_MS` (default 5s, `src/lib/schedule/assignNights.ts`), which
  is exactly Playwright's *default* assertion timeout — so the default left a
  wait with no headroom and it passed only where the search converged early.
  `expect` must stay above the generator's budget, and well below `timeout`, or
  a failed assertion eats the whole test budget and reports "Test timeout
  exceeded" instead of naming the locator.
  If the balance assertion (`every team's GP is 4`) ever fails on a runner,
  that is the real quality bound: the lever is `OBHL_SLOT_BUDGET_MS` in the
  **e2e job's** env, which flows through `npm run dev` to the generator — no
  code change, `envInt` already reads it. **Raise the budget; never loosen the
  assertion.**
- **Worktrees collide on the dev-server port unless each exports `PORT`.**
  Playwright's `reuseExistingServer` takes whichever server is already up, so a
  suite can drive another branch's code and report the result as yours — nine
  phantom failures on 2026-09-04 before `ps` named the culprit. #24 made
  `playwright.config.ts` derive `baseURL` AND the `npm run dev -p` flag from one
  `PORT`, so those two can no longer disagree; ⚠️ it still **defaults to 3000**,
  which means the collision is now avoidable rather than avoided. Export a
  distinct `PORT` per worktree and check `lsof -ti:$PORT`.
- **A migration can reach production without reaching the repo.** `0036` was
  `db push`ed from a worktree while its file was uncommitted, so for a day
  production carried a column no checkout described and `db push` refused from
  every branch. Closed by #21. If `migration list --linked` ever shows a Remote
  version with no Local one, look for an uncommitted file before running the
  `migration repair --status reverted` the CLI suggests — that command would have
  deleted production's record of a change it had really applied.
- Supabase CLI 2.104 → 2.116, Vercel CLI 55 → 59.11.

## Provenance

Items 1, 2 and 4 come from `LAUNCH.md`, which remains the operational runbook —
this file records only what is still outstanding in it. Item 3 came out of the
PR #13 review on 2026-09-02.

Items 6 and 7 arrived with **PR #24** (`feat/manager-tools`), merged 2026-09-05
as `b244f65` — the five-workstream branch planned in
`docs/superpowers/specs/2026-09-04-manager-tools-and-auth-design.md`. Item 6 was
mechanical, three migrations the branch added, and closed the same day. Item 7
is that branch's D workstream stopping where it was always going to stop, at the
SMTP account nobody has created.

⚠️ **Both were found by re-reading this file against the branch, not by anything
failing** — which is the only way either could have surfaced before the merge:
**CI was fully green with item 6 open**, because it runs migrations from the
repo and never looks at production's. A green build is not evidence that
production has the schema the build assumes. Nothing in the pipeline checks
that, so re-reading this file against the branch is the check.

Items 1, 2 and 3 were closed on 2026-09-04 alongside the League Office work
(`docs/worklists/2026-09-03-678b2916-league-office.md`, PR #22) and the roster
import and transfers work (PRs #20 and #21). The League Office worklist holds the
probe evidence behind `0034` — two silent traps and a trigger race, each watched
failing before being trusted. **Do not open it to resume**; everything still
outstanding is in this file.

The work that closed the cross-league escalation and the audit gaps was tracked
in `docs/worklists/2026-09-02-085d26f3-cross-league-and-audit.md`, now marked
closed. **Do not open it to resume** — everything still outstanding is in this
file. It is kept only because its measurements are the evidence behind the
commits. The per-league design itself is `ACCESS_CONTROL_HANDOFF.md`.

**Closed 2026-09-02 — do not re-file.** `LAUNCH.md`'s "Known limits at launch"
said staff roles were not league-scoped, that a scorekeeper could score either
league, that a second manager had access to both, and that People & Roles was
global with `removeStaff` deleting accounts outright. Every one of those was
true before per-league access control and is now rewritten against the code,
together with Phase 1's account list, which named three of the five seeded
accounts.
