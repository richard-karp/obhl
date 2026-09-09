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
     SQL. See _Getting locked out_.
   - ⛔ **A SCHEDULE PUBLISHED WITH A PAST DATE LOCKS THE SEASON INSTANTLY AND
     FOR GOOD.** `season_is_started` (`0026`) counts only `not is_draft`, so a
     past-dated DRAFT is invisible to the gate until it is published, at which
     point generate, replace and remove all refuse permanently. ✅ Guarded at
     both ends now — refused at GENERATE (item 9, PR #35) and warned at PUBLISH
     with a one-click move forward (PR #46, merged 2026-09-09). ⚠️ That warning CONFIRMS
     rather than refuses: "Publish anyway" is still one click from the lock.
   - ✅ **`gh pr create` WORKS from an agent** — measured 2026-09-06, PR #40, no
     prompt. The line here calling mutating `gh` classifier-denied was wrong and
     cost a handoff; only `vercel env` is untested. On a red CI run,
     `gh run download` the artifact and read `error-context.md` yourself; its
     page snapshot has twice settled in seconds what guessing got wrong.
3. ⛔ **The hot tier — everything above _The items_ — is capped at 130 lines.**
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
5. Verify code changes with `npm test && npm run test:e2e`. Watched 2026-09-06
   at `dcd10b1` (what #38 merged as `c87764e`): **32 unit files / 444 tests;
   213 e2e passed / 1 skipped / 0 failed** in 4.8m local, 29 spec files. The
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
2026-09-06 `ENABLE_DEV_LOGIN` is gone from every Vercel environment, the seeded
accounts are deleted, and production carries `0001`-`0044`. What the member-read
migrations changed, and why, is under _Member reads_ below.

✅ **THIS FILE IS ON `main`.** Open PRs as of 2026-09-09: **#56**
(`docs/post-merge-status`) and **#51** (`test/clock-shifted-ci`). Earlier:
2026-09-06 #38 and #39 merged, before them #36 and #33-#35; #23 and issue #30
closed; #57 (the team-scoped export) merged 2026-09-09. ⚠️ **Check anyway** —
this line goes stale the moment someone branches, and a stale copy in a worktree
misled a reader once. It also said "there are NO open PRs" while this same file
recorded #51 as still open, four hundred lines down. Everything waiting on a person rather than on work is listed
under _Open — waiting on a person_ below, and nothing outstanding is elsewhere.

**Only one lane is left; the code lane is finished.**

- ✅ **CODE — the 4 harness items are FIXED** (2026-09-06, PR #40, CI green).
  §5 _The final pre-launch pass_ carries each one and how it was verified. ✅ The
  fifth, §5 _The fixture dates_, merged 2026-09-09 as PR #44 — so all five are on
  `main`. It shipped with eight review fixes, including the seed naming
  `America/Toronto` where the app uses `America/New_York`.
- **A PERSON — the user, and no agent can do any of them: 5 items**, under
  _Open — waiting on a person_. ⛔ Exactly one is dated: **rebuild the schedule
  before 2026-09-10 23:00 UTC**, the published season's first game night, after
  which its schedule locks for good. Two others — custom SMTP (item 7) and
  `NEXT_PUBLIC_SITE_URL` on Preview — are blocked behind buying
  `lccalumnihockey.ca` first, so that purchase is the unblocking move.

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
_Verification_ list, which need a session. Nothing else outstanding can be done
from a checkout.

✅ **Sign-in, the app guard and RLS were all verified on production 2026-09-05**
— see _Verified on production_ under item 4. ⛔ **Test `/<slug>/dashboard`, never
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

_A reading of the code, not a probe — the order held, so none of it happened._

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

| #   | Item                                                                           | Where                             | Status                                                                                                                                                                                                                                                                                                                                                              |
| --- | ------------------------------------------------------------------------------ | --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `ENABLE_DEV_LOGIN` set on production                                           | Vercel env                        | ✅ **closed 2026-09-04** — absent from every environment (`vercel env ls`)                                                                                                                                                                                                                                                                                          |
| 2   | Seeded test accounts live, password in git                                     | Supabase dashboard                | ✅ **closed 2026-09-04** — done by a human; not verifiable from a checkout                                                                                                                                                                                                                                                                                          |
| 3   | `0033` not pushed — the RLS half of the escalation                             | `supabase db push`                | ✅ **closed** — and `0034`-`0038` with it                                                                                                                                                                                                                                                                                                                           |
| 4   | **`LAUNCH.md` Phases 2-6 never verified**                                      | production                        | ⛔ **OPEN, AND ON A CLOCK** — Phase 6's first game night is 2026-09-10; sign-in, access control and the anonymous half of _Verification_ are done; steps 4-6 of that list need a session                                                                                                                                                                            |
| 5   | Smaller deferred items                                                         | below                             | open                                                                                                                                                                                                                                                                                                                                                                |
| 6   | `0039`-`0043` not pushed                                                       | `supabase db push`                | ✅ **closed 2026-09-05** — `0039`-`0041` before #24 merged, `0042`/`0043` after #31; `migration list --linked` shows all five on both sides                                                                                                                                                                                                                         |
| 7   | Staff can set a password, but only a commissioner can give them one            | a domain, then Supabase dashboard | **OPEN — only phase 1 is left, and it needs a DOMAIN BOUGHT FIRST** — ✅ phases 2-3 merged 2026-09-06 (#36, `32262b5`): reset trigger, `/set-password`, password field on `/login`. ⛔ No production email has ever been sent, so the reset half is unproven and nobody should be told it works. Runbook in _The other half of auth_. ⚠️ No app env key is involved |
| 8   | **Unified URL space** — drop the `/manage/` prefix, merge the duplicated pages | code                              | ✅ **closed 2026-09-05** — steps 1-6 shipped as #31 (which collapsed #25-#29); step 7, the prose, is this commit. Spec: `docs/superpowers/specs/2026-09-05-unified-url-space-design.md`                                                                                                                                                                             |
| 9   | **A past first-game-night locks the season on publish**                        | code                              | ✅ **closed 2026-09-05 — PR #35, on `main` as `72b4148`** — reproduced, then guarded at generate. ✅ The publish half followed 2026-09-08 (PR #46) — warned, not refused, with a one-click move forward; see _Item 9 — the guard, built_                                                                                                                                                                                           |

⛔ **Do not re-file 1-3.** They are kept as rows, rather than deleted, because a
reader who knows this file by its old shape will otherwise assume they were
forgotten. The reasoning behind each is under _Closed doors_ below.

⛔ **Do not re-file 6 either.** It is kept for the same reason as 1-3, and
because the ORDER it was closed in is the reusable part — see _The rule item 6
leaves behind_ above.

⚠️ **6 and 7 both arrived with #24** (`feat/manager-tools`: schedule
constraints, roster editing, team branding, staff auth, season gating), merged
2026-09-05 as `b244f65`. Item 7 is the one still open: a standing limitation
that needs an account created outside this repo.

## Open — waiting on a person, not on work

⚠️ **This is the completeness list.** Everything left outstanding as of
2026-09-05 appears here or in the items table above; if something is in neither,
it was finished, and the commit that finished it says so.

⚠️ **No CI verdict is recorded here on purpose.** It goes stale on the next push
and a stale green is worse than none — `gh run list --branch <branch> --limit 1`
is one command and is always right.

| What                                                                 | State                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | Who                                                                                                                                                        |
| -------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ⛔ **Rebuild the schedule** — discard the draft, regenerate, publish | Stated intent 2026-09-05; 144 games published, none played                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | **the only dated row: the window shuts Thursday 2026-09-10 23:00 UTC.** Full sequence and both traps in _Next action_                                      |
| **`LAUNCH.md` Verification steps 4, 5, 6**                           | The manager badge, the league switcher, an announcement in one league only                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | needs a signed-in session; steps 1-3 and 7 are done and 1-2 cannot pass as written                                                                         |
| ⛔ **Buy `lccalumnihockey.ca` and move the site onto it**            | **Decided 2026-09-06: `lccalumnihockey.ca`, for the site AND the mail sender** — not only the mail — which widens §7, whose runbook assumes the site stays on `obhl.vercel.app`. No code change: `grep vercel.app src/ e2e/` is empty and the host reaches the app through `NEXT_PUBLIC_SITE_URL` alone, in three places. The work is purchase → DNS → env var on Production AND Preview → Supabase Site URL → the whole redirect allow-list → Resend. ⚠️ Finish by REDIRECTING `obhl.vercel.app` to the new host — sessions are origin-scoped, so two live origins mean a sign-in on one and the emailed link on the other | the user; `vercel env` and the Supabase dashboard are not an agent's to run. See _Custom domain_                                                           |
| **Item 7** — custom SMTP                                             | ✅ **UNBLOCKED 2026-09-07** — `lccalumnihockey.ca` is registered, the site is on it, and all four Resend records are published and verified from a public resolver: DKIM `resend._domainkey` intact to `IDAQAB`, SPF as two CNAMEs (`rsend`/`send` → `*.forge.rmta.net`, both resolving to real `v=spf1` policies), and `_dmarc` at `v=DMARC1; p=none;` (no `rua=`, so it reports nowhere — harmless). All three values to READ AND RECORD are now recorded: the allow-list entries, the password length (was `6`, set to `8`), and `secure_password_change` (OFF). ✅ **CLOSED 2026-09-07: a real magic link was watched to arrive through Resend and sign in a manager.** Supabase's emails-per-hour reads `30`. ⛔ **The RESET leg is still unproven** — that path carries `?next=/set-password`, and its allow-list entry has never been exercised; see item 7                                                                                                                                                                                                           | Supabase dashboard; ⛔ not doable from a checkout. ⚠️ It needs NO app env key — the API key goes in Supabase, not Vercel |
| **`NEXT_PUBLIC_SITE_URL` is missing on Preview**                     | `vercel env ls` 2026-09-05: Production only                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | a magic link requested from a PREVIEW deploy mails a `localhost:3000` link. Production is unaffected. One `vercel env add`, which an agent may not run     |
| ✅ **`supabase db push` for migration `0044`**                       | **DONE 2026-09-06, watched.** `--dry-run` first showed exactly one pending file; the push applied it and `supabase migration list --linked` now shows `0044` in the remote history. ⚠️ The columns themselves were NOT read back — this checkout's `.env.local` points at the LOCAL stack, so there is no production key here to query with. A `create or replace view` has no partial state, and a failure would have aborted before the history row, so the reading is that all four views are widened                                                                                                                    | done; #39 is now free to merge in either order                                                                                                             |
| ✅ **The schedule write path has no transaction**                     | **DONE — `0045_apply_game_writes.sql` is on `main` (`d28595a`).** The batch is one statement in one transaction under `pg_advisory_xact_lock` on the season, so the compensation machinery and its `stuck`/`indeterminate` outcomes are gone. Was: compensation only, a runtime dying mid-batch leaving writes applied and uncompensated                                                                                                                                                                                                                                                                                     | done; this row said SHIP NOW / build it after launch, and it was built. §5's section below is retained as history, not as work                              |

⚠️ **One class is missing from that table on purpose, because nothing in it
waits on a person:** test-harness defects. None affects the app; each costs a
session's time when it fires. The four found on 2026-09-06 while merging #38 and
#39 are ✅ **fixed** (PR #40) — §5, _The final pre-launch pass_. ✅ **The fifth,
which WAS dated (`11-` and `23-` would have broken from 2026-09-16), merged
2026-09-09 as PR #44** — §5, _The fixture dates_. No code item in this file is
outstanding.

---

## Closed doors — 1, 2 and 3, and why they mattered

**1. `ENABLE_DEV_LOGIN`** turned on the one-click role buttons
(`devLoginEnabled()`, `src/lib/auth/dev-login.ts`) on a production build.
Removed 2026-09-04; measured absent from Production, Preview and Development.

**2. The seeded accounts** were a separate door, and removing item 1 did not
close it: `scripts/seed-users.mjs` sets a password constant committed to this
repo, and Supabase's password grant is reachable with the anon key — so those
accounts were a way in regardless of any application setting. **Eight** exist
now (`commissioner@` and `deputy@` joined with the League Office; `no-league-mgr@`
with the no-role explainer). Deleted on production 2026-09-04. ⛔ Count
`grep -n "email:" scripts/seed-users.mjs` rather than trusting any number written
down — this one has been wrong twice, and `LAUNCH.md`'s copy of the list was
still saying five on 2026-09-09.

⚠️ **The mechanism is still live for anyone who re-seeds.** The password is still
in git and always will be; a fresh `npm run seed:users` against a production
database re-opens this door in one command. It is safe only because nobody runs
it there.

**3. `0033`** swapped `manager write profiles` from _sharing_ a league — which a
manager can arrange — to containment. Both steps of that escalation were once
watched succeeding on the anon key. Pushed, along with `0034`-`0038`.

## The League Office (`0034`) — live but dormant

`0034` is applied to production (2026-09-04, `--include-all`, because it sorts
below `0035`-`0038` which shipped first). **It changes no behaviour until someone
is appointed:** `league_office` starts empty, so `my_office_tier()` is null for
every account and `may_write_profile` reduces to exactly `0033`'s containment
test. Appointing the first commissioner is _The first commissioner_ below, and
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
a null league is filtered out of every league-scoped view _and_ hidden by RLS —
so a `logAudit` call added alone writes an entry that is **correct and never
appears**. Add the type to that switch in the same change, and prove it by
knocking the case out and watching a test go red. `announcement` and `league`
were watched failing that way; `office` and `player` were added later and are
listed explicitly for the same reason — ⚠️ note that deleting either changes
NOTHING, since `default` also returns null, so the regression to simulate is a
case that starts _resolving_ a league. That was watched too.

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
offers them nothing. Restoring the row is _The first manager_ in `LAUNCH.md`
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

✅ **Nothing was broken. It was the URL** — _as of 2026-09-05_.
`src/app/page.tsx` says so in its own docstring: `/` is "what a bare domain, a
role-denied redirect, and a completed sign-in all land on", and back then `/`
rendered no `ManageNav`, because the nav and its badge lived in
`src/app/[league]/(manage)/layout.tsx`. A successful sign-in therefore landed on
a page that showed no badge to anybody, and
`/lcc-old-boys-hockey-league/dashboard` was the URL that proved otherwise. That
cost a full round of misdiagnosis, because "signed in, no badge, no tools" is
the same symptom as a real lockout.

⚠️ **THE FIX FOR THAT SHIPPED — do not re-diagnose it, and do not follow the old
advice.** PR #39 (merged `9d57fbe`, 2026-09-06) deleted `ManageNav` entirely;
there is one header for the whole site and staff get a row of links beneath it.
`/` now renders `AccountCluster` (`page.tsx:93`), **so the badge IS there for a
signed-in visitor**, and the picker also lists the leagues that account belongs
to — badged "Not yet public" for one that is still staged. The old ⛔ "test the
dashboard URL, never `/`" is therefore stale: `/` is now a _valid_ place to
check a sign-in, and a missing badge there means something is genuinely wrong
rather than that you picked the wrong page. Kept rather than deleted because the
misdiagnosis is the lesson — the symptom is still identical to a real lockout.

**`LAUNCH.md` Phase 2 is now verified; Phases 3-6 are not.** SMTP, the redirect
allow-list, the role resolution and the manage tools were all exercised end to
end on 2026-09-05 (see _Next action_), which is the whole of Phase 2's
Supabase-dashboard column bar the hook itself. This file otherwise speaks only to
Phase 1 (the test doors). ⚠️ **Production has ONE league, not two** — measured
2026-09-05: `lcc-old-boys-hockey-league` ("LCC Old Boys Hockey League"),
`is_public = true`, and it is the only row in `leagues`. Two is the goal this
file is named for, not the current state, and `LAUNCH.md`'s verification step 1
("`/` lists both leagues") cannot pass until a second one exists. The site being
live means some of the rest presumably happened — but _presumably_ is the operative word: nobody has checked
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
policy on `profiles` tested _overlap_ where it needed containment, so the
escalation the app had just closed still worked through PostgREST. That is item
3 above, closed by 0033 and still to be pushed.

Everything else read as sound, and is recorded here so nobody re-derives it:
every exported server action carries a league-scoped guard (the six in
`schedule.ts` all route through `targetSeasonForManager`, the twelve in
`games.ts` through `requireGameRole`); `requireLeagueManagerOf` requires the ids
to _agree_, which per-id checks cannot; every guard fails closed on a null
league, because `= null` is never true in SQL and `isLeagueMember` refuses an
empty id; and the public feed routes read through RLS, so a staged league's
schedule is empty rather than exposed — `publicLeagueOfSeason` decides only the
calendar's name.

Two deliberate looks-wrong-reads-right spots, left alone: `manager write
memberships` checks only `league_id`, so a manager may grant their own league to
any profile — that is the flow the membership model exists for, and closing
step two is what makes keeping it safe. And the manage dashboard checks
membership only for a _roled_ account, because the page that explains "you have
no role yet" would otherwise be unreachable; it renders no league data.

### Verified anonymously against production, 2026-09-05

The half of `LAUNCH.md`'s _Verification_ list that needs no session. Measured
with curl against `https://obhl.vercel.app`:

| Check                                           | Result                                                             |
| ----------------------------------------------- | ------------------------------------------------------------------ |
| `/` lists the leagues                           | ✅ 200 — but **one** league, `lcc-old-boys-hockey-league`, not two |
| `/<league>/standings`                           | ✅ 200                                                             |
| An unknown slug 404s                            | ✅ `/nosuchleague-zzz` → 404                                       |
| `/api/schedule/team/<id>/feed.ics` resolves     | ✅ 200, 36 events, calendar named for the league                   |
| `/api/schedule/<season>` and `.../schedule.csv` | ✅ 200                                                             |

⚠️ **Verification steps 1 and 2 cannot pass as written.** They assume two
leagues; production has one. Steps 4, 5 and 6 (the badge, the league switcher,
an announcement) need a session and remain for a human — step 4 was separately
confirmed on 2026-09-05, below.

### The deadline reading, and what it could not see

⚠️ The Phase 6 date in _Next action_ was derived from the public ICS feed, which by definition shows only
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
nothing about either. `ACCESS_CONTROL_HANDOFF.md`'s _Traps_ section carries the
rule — `canManageLeague`/`canScoreLeague` are questions, not guards — and the
server actions behind those sections are what actually refuse.

**RLS, which is the half that matters.** Probed directly against PostgREST with
the publishable key, bypassing the app entirely:

| Probe                                                                   | Result                                                    |
| ----------------------------------------------------------------------- | --------------------------------------------------------- |
| `select` on `profiles`, `profile_leagues`, `audit_log`, `league_office` | `[]` each                                                 |
| `select` on `leagues`, `seasons`, `team_players`                        | rows — public, as designed                                |
| `insert` into `announcements`                                           | `401`, `42501 new row violates row-level security policy` |
| `update` on `leagues`, `profiles`, `team_players`                       | `200` with `[]` — zero rows matched                       |

⛔ **The public reads are the load-bearing part of that table, not filler.** Had
everything returned `[]`, a wrong key or a wrong URL would look exactly like
working RLS. Public data coming back is what proves the probe reached the
database as an anonymous caller and _then_ got refused. Every write was a
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
  passes _with the attack never having happened_ (`a manager can be removed from
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

## Custom domain — `lccalumnihockey.ca`, DECIDED 2026-09-06

⛔ **THE DOMAIN IS CHOSEN: `lccalumnihockey.ca`.** Not yet purchased as of
2026-09-06. This is the site's address AND the mail sender's
(`noreply@lccalumnihockey.ca`), so it is the one value item 7 and everything below
share. ⚠️ `.ca` has CIRA's Canadian Presence Requirements — a registrar will ask;
it is a formality for a Canadian registrant and a hard stop for anyone else.

✅ **`obhl.vercel.app` REDIRECTS to the new host.** Decided 2026-09-06, revising
the same day's earlier "leave it as is" — only two or three people know that host,
so nothing is being migrated either way, and redirecting is both easier and safer.

⛔ **THE REASON IS AUTH, NOT TIDINESS. A SESSION IS SCOPED TO AN ORIGIN.** Two
hosts serving the app are two origins with two separate sessions. Sign in on
`obhl.vercel.app`, and every emailed magic link and reset link points at
`lccalumnihockey.ca` — because that is what `NEXT_PUBLIC_SITE_URL` and Supabase's
Site URL say — so the viewer lands on the new host **signed out**, with a working
session sitting on an origin they cannot see. ⚠️ That is indistinguishable from a
broken login, and it is the SAME symptom this file already records as costing a
full round of misdiagnosis on 2026-09-05: "signed in, no badge, no tools". One
origin makes it unreachable.

**How:** Vercel → project → Domains: add `lccalumnihockey.ca`, make it the
production domain, then set `obhl.vercel.app` to **Redirect to** it. No code, no
deploy. ⚠️ **A reading, not a measurement** — that the redirect option is offered
for the `.vercel.app` domain itself has not been checked on this project. If it is
not, the fallback is a host-based redirect in middleware, which is a few lines and
does need a deploy.

⛔ **ORDER: verify the new domain SERVES THE SITE first, then set the redirect.**
Redirecting before DNS resolves points the only working host at one that is not
answering yet.

⚠️ Per-deployment URLs (`obhl-<hash>-….vercel.app`) always resolve and cannot be
redirected — that is how preview deploys work, and it is fine.

⚠️ **The user wants the SITE on a custom domain, not only the mail.** Everything
below §7 was written on the assumption that a domain was needed _only_ so Resend
had something to verify, and it says explicitly that "the domain does not have to
be the site's address" and that mail can come from `noreply@<domain>` while every
link still points at `obhl.vercel.app`. **That is no longer the plan.** The
site moves too. §7's runbook is still correct about the mail half; this section is
the part it does not cover.

**Measured 2026-09-06, and it is better news than it sounds:** `grep -rn
"vercel\.app" src/ e2e/ supabase/config.toml` returns **nothing**. No host is
hardcoded anywhere in the app. The site's address reaches the code through exactly
one variable, `NEXT_PUBLIC_SITE_URL`, in exactly three places:

| Where                                    | What it does if it is wrong                                                                          |
| ---------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `src/app/layout.tsx:19` (`metadataBase`) | Open Graph and canonical URLs point at the old host. Cosmetic, invisible until someone shares a link |
| `src/lib/actions/auth.ts:50`             | the magic-link `emailRedirectTo`                                                                     |
| `src/lib/actions/auth.ts:95`             | the password-reset `redirectTo`                                                                      |

So the code change is **none**. The work is a purchase, DNS, one env var per
environment, and the Supabase settings that must agree with it.

**The order matters, and the last two steps are the ones that bite:**

1. **Buy the domain.** ⛔ Still the only thing with a lead time; nothing else here
   can start. `vercel domains ls` was **0 Domains**, re-measured 2026-09-06 with a
   control (`vercel teams ls` shows exactly one scope, so it is not hiding under
   another team).
2. `vercel domains add` and point the DNS. The `vercel.app` host keeps working as
   an alias afterwards — see the trap below.
3. **`vercel env` — set `NEXT_PUBLIC_SITE_URL` on Production AND Preview.** Preview
   is already an open item in the table above for a different reason; the domain
   makes it the same job. ⚠️ An agent may not run `vercel env`.
4. **Supabase → Authentication → URL Configuration → Site URL.** This is the value
   Supabase substitutes when a redirect is not on the allow-list.
5. **The redirect allow-list — every entry, including the query-string one.** ⛔
   The trap already documented for `/auth/confirm?next=/set-password` applies
   again here in full: a redirect that is not on the list does **not** error. The
   mail still sends, `redirect_to` is silently rewritten to the Site URL, and
   under PKCE the route receives `?code=…` with no `type`, so there is no code fix
   for it. Re-add every entry against the new host.
6. **Resend** (item 7 phase 1) now verifies this same domain. That is the one part
   §7 already covers end to end.

⛔ **THE TRAP, AND WHAT THE REDIRECT DOES TO IT: UNTIL THE REDIRECT IS IN PLACE,
`obhl.vercel.app` KEEPS SERVING THE APP.** In that window a stale allow-list
entry, a missed env var, or an old bookmark all keep working, and the flow looks
healthy right up until somebody arrives on the new host. ✅ Setting the redirect
closes it and **turns it into a positive test**: visit the old host, land on the
new one, and the move is proven. Until then nothing can prove it — so treat the
redirect as part of the move, not as tidying up afterwards. ⚠️ **Verify from the NEW host in a fresh private window**, not from a tab you
already had open, and check that the emailed link's `redirect_to` names the new
domain rather than assuming it does.

⚠️ **The e2e note in `.env.local` gains a second meaning.** It pins
`NEXT_PUBLIC_SITE_URL=http://localhost:3000`, which is why `24-password-auth.spec.ts`
fails with `ERR_CONNECTION_REFUSED` in any worktree on another port. That stays
true and unrelated to production — do not "fix" it by putting the new domain in
`.env.local`.

## 7 — The other half of auth: only the email is left

✅ **THE CODE IS ON `main`** — PR #36, merged 2026-09-06 as `32262b5`. A staff
member can set their own password (`/set-password`), sign in with it (`/login`,
under the magic link), and reach that page from the `Password` link in any
signed-in header. The floor is 8, enforced by every writer before Supabase is
called, so the dashboard's own number cannot make two doors disagree.

✅ **DELIVERY WORKS — WATCHED 2026-09-07.** Custom SMTP through Resend is live
on `lccalumnihockey.ca`, and a real magic link was sent, received, and used to
sign in as a manager. That is the first production email this project has ever
sent, and it closes phase 1.

⛔ **BUT THE RESET LEG IS STILL UNPROVEN, AND IT IS NOT THE SAME PATH.** What
was watched is the MAGIC LINK, which returns to `/auth/confirm` with no query
string. `sendPasswordReset` returns to `/auth/confirm?next=/set-password` — the
query-string case the allow-list entry `https://lccalumnihockey.ca/auth/confirm?**`
was added for, and **nothing has exercised that entry.** ⚠️ Its failure mode is
silent by design: an unlisted redirect does not error, the mail still arrives,
and `redirect_to` is rewritten to the Site URL, landing the person signed-in on
`/` with the token spent. So a working magic link is NOT evidence the reset
works. **Send one real password reset and follow it to `/set-password` before
telling anyone that flow works.** Until then, `setStaffPassword` in the League
Office remains the way to give someone a first password.

⚠️ **The build narrative, the measured absences, the oracle measurements and
every decision behind the code are archived** in
`docs/worklists/2026-09-06-22b5bab5-item-7-password-auth.md` (262 lines).
Do **not** read it to do the work below — nothing outstanding depends on it.

| Step in a password flow                        | State                                                                                                             |
| ---------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| A commissioner **sets** a password for someone | ✅ `setStaffPassword` (`office.ts`, `requireCommissioner`) — the no-email path, and the only one that works today |
| A user **sets their own** password             | ✅ `/set-password` → `auth.ts:updateOwnPassword`, reached by `sendPasswordReset`. ⛔ The email leg is unproven    |
| A user **signs in** with it                    | ✅ `auth.ts:signInWithPassword`, second form on `/login`. Only useful to an account that already has a password   |

**What closes this — one phase, and it is not code:**

1. **Custom SMTP (Resend).** ⛔ Dashboard work — cannot be done from a checkout.
   ⚠️ **The app needs no new env key.** Nothing in `src/` reads a Resend
   variable and nothing should: Supabase Auth sends these emails, so the API key
   belongs in the SUPABASE dashboard, not Vercel's.
   `vercel integration add resend/resend-email` is optional — it buys unified
   billing and puts `RESEND_API_KEY` somewhere the app will never read it.

   ⛔ **THERE IS NO DOMAIN TO VERIFY. THIS IS THE REAL BLOCKER, AND IT HAS A
   LEAD TIME NOTHING ELSE HERE HAS.** `vercel domains ls` returned **0 Domains**
   — measured 2026-09-05 and **re-measured 2026-09-06**, still 0. That second
   reading carries a control the first did not: `vercel teams ls` shows exactly
   ONE scope (`richard-karp-s-projects`), so there is no other team a domain
   could be hiding under, and every entry in `vercel alias ls` is a
   `*.vercel.app` host. Production is `https://obhl.vercel.app`. `vercel.app`
   **cannot** be verified in Resend — it is not ours, and verification needs DNS
   records at the domain's authoritative nameservers. Someone has to **acquire a
   domain** before step (a) below is reachable at all.

   ⚠️ **SUPERSEDED IN PART, 2026-09-06 — read _Custom domain_ above first.** The
   paragraph below is still TRUE of what item 7 alone requires, and it stays
   because it is the fallback if the move is ever deferred: mail can be sent from
   a domain that does not serve the app. But the user has since decided the site
   moves onto the custom URL too, so in practice the same domain does both jobs
   and the extra steps (env var, Supabase Site URL, the whole redirect
   allow-list) are in that section, not here.

   ✅ Two things make that smaller than it sounds. **The domain does not have to
   serve the app** — Resend needs records at the registrar, nothing _in item 7_
   requires moving off `obhl.vercel.app`, and mail can come from
   `noreply@<domain>` while every link still points at the vercel.app host; item
   7 on its own is not a domain migration. And Resend's shared `onboarding@resend.dev` sender needs no DNS at
   all: it delivers **ONLY** to the address that owns the Resend account, which
   is enough to prove the (b) and (c) wiring and ⛔ **not** enough to unblock
   staff sign-in. Do not mark phase 1 done on it.

   a. **Verify a sending domain** in Resend, then create an API key. Unverified
   domains fail at send time, not at setup time.
   b. **Authentication → Emails → SMTP Settings**: host `smtp.resend.com`, port
   `465`, username **the literal string `resend`**, password the API key,
   sender an address at the domain from (a).
   c. **Authentication → Rate Limits**: raise "emails per hour" off its default
   of `2`. ⛔ Skipping this is the failure that looks like a bug in the app —
   links stop arriving for everyone at once, with nothing in the app's logs.
   d. Confirm Site URL and the redirect allow-list still name production, then
   send one real magic link and watch it arrive.
   ⛔ **THE ALLOW-LIST NEEDS A NEW ENTRY, AND ITS ABSENCE IS SILENT.** The reset
   link asks Supabase to return to `/auth/confirm?next=/set-password` — a
   QUERY STRING the magic link never had, and the allow-list is a list of
   exact URLs with wildcards. **Measured 2026-09-05** against the local
   stack: a `redirectTo` that is not listed returns **no error at all**, the
   mail still arrives, and its `redirect_to` is silently rewritten to the
   Site URL. So the person lands signed-in on `/` with the token spent, no
   way to finish, and nothing in the app's logs — while the action reports
   success. Locally this passes only because `config.toml` allows
   `http://localhost:3000/**`; production's list is unread from here. **Add a
   pattern covering `https://<prod host>/auth/confirm?**` (or the equivalent
   wildcard) before sending the first reset**, and add the preview pattern in
   the same visit — see the `NEXT_PUBLIC_SITE_URL` note below.
   ⚠️ There is no code fix for this: under PKCE `/auth/confirm` receives
   `?code=…` with **no `type`**, so it cannot recognise a recovery link and
   reuse the bare URL that is already listed. Measured the same day, by
   watching the navigation chain.
   e. ✅ **DONE 2026-09-07, and it was WRONG: production's minimum password
   length was `6`, not 8.** Read and changed to `8` in the same visit. The app's
   own writers enforce 8 before Supabase is called, so the forms were never the
   hole — but anything reaching Supabase's API directly could have set a
   six-character password. The two doors now agree. See the layering note under
   phase 2.
   ⚠️ **(c) turned out to be a non-issue:** the emails-per-hour limit read `30`
   once custom SMTP was saved, so it never had to be raised by hand. The earlier
   note that it would still say `2` was a reading of Supabase's documented
   behaviour, and the measurement did not match it.
   f. ✅ **READ 2026-09-07: `secure_password_change` is OFF in production, and
   the password-changed template EXISTS but is DISABLED.** That second half is
   the useful part — the notification is available on this project and simply
   switched off, so enabling it is a toggle rather than a build. Recorded, not
   changed — see the decision note below. Both govern what a stolen session can
   do: with `secure_password_change` off, a session cookie alone — 7 days — is
   enough to set a password and keep access that outlives the session, and with
   the notification template off nobody is told. `config.toml` has
   `secure_password_change = false` and the `password_changed` template
   commented out, so ⛔ **local and production now agree, and both are off.**

   ⚠️ **TURNING IT ON IS UNTESTED AND COULD BREAK `/set-password`.** The header's
   `Password` link reaches that page from any signed-in session, however old.
   With secure password change on, GoTrue wants a recent authentication, so a
   week-old session may be refused where it works today — while a session created
   by a reset link is fresh and should be fine. **That is a reading of the
   mechanism, not a measurement; nobody has tried it.** So the safe order is:
   turn it on, then immediately exercise BOTH paths — a fresh reset-link session
   and a days-old one — before anyone depends on it. Post-launch work.
   ⚠️ **Password sign-in has no throttle the app can see.** `signInWithPassword`
   counts nothing itself, and GoTrue's per-IP limit on `/token` sees the
   Next.js server's address rather than the caller's — every sign-in in the
   instance arrives from one IP. So the limit neither slows a guess-the-
   password run against one account nor keeps one attacker from spending the
   whole budget and locking everybody out of the password door. The magic link
   is unaffected and remains the way back in, which is why this is recorded
   rather than built: if it ever needs fixing, the fix is a per-email attempt
   count in a table, not a dashboard setting.

   ⚠️ **`NEXT_PUBLIC_SITE_URL` is set on Production ONLY** (`vercel env ls`,
   2026-09-05). `sendMagicLink` falls back to `http://localhost:3000` when it is
   absent, so a magic link requested from a PREVIEW deployment mails a localhost
   link. Production is unaffected. `vercel env add NEXT_PUBLIC_SITE_URL preview`
   is the whole fix, and an agent may not run it. ⛔ **That key alone is NOT
   sufficient** — Supabase's redirect allow-list must carry the preview pattern
   too, or the app builds a correct preview link that Supabase then refuses as
   unlisted. Both halves, or neither.

⚠️ An unverified sign-in path is worse than a missing one: it looks like a way
back in, right up to the moment someone needs it. Step 1 is not done until one
real message has been **watched to arrive**.

**Runbook with the dashboard steps as a tickable checklist:**
<https://claude.ai/code/artifact/b92f802a-1a8f-4e0a-8599-3d601b9bc482>

## Item 9 — the guard, built

✅ **Built and merged 2026-09-05 — PR #35, on `main` as `72b4148`.** Kept as a
section because the residual risk is real even after it merged, and because the
reproduction is the useful part.

**What it does.** A first game night before _today_ is refused at GENERATE, so
no new draft can carry a past date:

- `src/lib/schedule/startDate.ts` — `isPastGameNight({ startDate, today })`,
  pure, 5 unit tests in `startDate.test.ts`. ⚠️ **Named arguments on purpose**:
  both are date strings, and swapping them positionally would INVERT the guard —
  every future date refused, every past one let through — with nothing at the
  call site looking wrong.
- `src/lib/actions/schedule.ts` — the refusal, immediately after the existing
  `!startDate` check. The half that cannot be bypassed.
- `schedule-generate-form.tsx` — `min` on the `start_date` input. Browser-side,
  so it stops the typing, not the request.
- `e2e/11-schedule-builder.spec.ts` — two tests: the `min` bound, and a
  server-side refusal that strips `min` first so it proves the trustworthy half.
- `e2e/31-stale-draft.spec.ts` — the publish half (PR #46): the warning, the
  move, the acknowledged publish, and a server refusal that strips the hidden
  acknowledgement for the same reason the generate test strips `min`.

⚠️ **Today itself passes**, and the bound is computed in the LEAGUE's zone via
`leagueDateKey`, not server-UTC — UTC runs up to five hours ahead of Eastern and
would refuse a legitimate same-day generate every evening after 7pm.

✅ **The residual risk this section carried is CLOSED — PR #46, merged 2026-09-09.**
`publishSchedule` now reads the draft's dates, and the builder warns with a
one-click move forward by whole weeks (`src/lib/schedule/staleDraft.ts`,
`redateDraftSchedule`, `StaleDraftNotice`). It CONFIRMS rather than refuses,
because the argument above is right about where the _message_ goes and wrong
only about whether one is owed: a manager whose games really were played on
Tuesday and who is publishing on Thursday needs it to go through, so "Publish
anyway" still exists — behind a dialog that names what it costs, and behind an
acknowledgement the server re-derives so a stale tab cannot supply it.

⛔ **Staleness is measured against the FACE-OFF, not the calendar day**, and that
distinction is the whole of the fix. `season_is_started` fires on
`scheduled_at < now()`, so a first night that is still _today_ but whose ice
time has gone is exactly as dangerous as one from last week. Two independent
reviews caught a day-granular first version — and caught its one-click move
landing a draft on a game that had already started, which would have created the
state the button exists to escape. If you touch that predicate, read
`staleDraft.test.ts` first: both directions are pinned there.

**The reproduction, which is why this stopped being a code reading.** With the
guard temporarily removed, a first game night of `2020-01-06` generated a
12-game draft and offered a live "Publish 12 games" button. The hazard note in
the protocol used to say _verified in the code, not reproduced_; it has now been
reproduced against the fixture.

⚠️ **PR #23 was CLOSED on 2026-09-05, and its branch
`feat/scheduling-future-only` is kept deliberately — do not delete it.** It held
a 1,708-line plan for future-only scheduling as a whole: the right long answer,
never funded, and stale (its diff still names 7 `/manage/` paths that #31
removed). It was closed rather than merged because an unbuilt plan in
`docs/superpowers/plans/` reads as scheduled work. None of the guard above ever
depended on it. If future-only scheduling is picked up, start from the brief and
design on that branch — not from the plan, which needs rewriting against the
current URL space.

## 5 — Smaller, deliberately deferred

- **The deferred code gaps and IA approach C** — ✅ **ALL RESOLVED 2026-09-09**, and that worklist is now a record rather than a queue → `docs/worklists/2026-09-07-9466c507-deferred-code-work.md`. Item 1 shipped as PR #46; items 2, 5 and 6 as PRs #49, #53/#54 and #48; item 4 was CLOSED as no-change (the divergence is deliberate and documented); item 7's spec is PR #50 and its blocker shipped as #52. ⛔ **Item 3 (a clock-shifted CI run) is the single exception — PR #51, still open**, because GitHub refuses a workflow-file change from an OAuth app without `workflow` scope. ⚠️ That file supersedes _From the sixth review of #24_ below for items 4-6.
  📄 **The merge itself, and why #51 and #47 are in odd states →**
  `docs/worklists/2026-09-09-c1a35e-deferred-work-merged.md` (70 lines). It is a
  record, not a queue — read it only if you are wondering why #51 will not merge,
  or before trusting a unit-test count from any branch.

### ✅ DONE — the schedule-write RPC (decided 2026-09-06, shipped by 2026-09-09)

⛔ **THIS IS NO LONGER THE FIRST POST-LAUNCH JOB. IT IS SHIPPED.**
`supabase/migrations/0045_apply_game_writes.sql` is on `main` (`d28595a`), and
`src/lib/schedule/writeGames.ts:74` calls it. Everything below describes the
world before it and is kept because the reasoning — why a transaction was the
only fix, and why shipping without one was an acceptable risk for a few days —
is worth reading; it is NOT a description of outstanding work.

What it replaced: `src/lib/schedule/gameWrites.ts` was damage control for a
missing transaction. It pre-flighted, wrote each row conditionally so it could
not clobber a concurrent edit, and compensated on failure — but a runtime dying
mid-batch left the written rows written, and the public schedule, both iCal
feeds and the CSV all read `games` live.

**The decision, made deliberately rather than by default:** ship without it, because
new SQL against production days before a permanent season lock is the larger risk;
then build it as the first job after both leagues are running. Adding it later needs
no redesign — the repair path already works on a locked season.

**⛔ THE SPEC AND THE PLAN ARE BOTH WRITTEN — do not re-derive either.**
`docs/superpowers/plans/2026-09-06-schedule-write-rpc.md` is where the work starts:
its §0 pre-flight is a GATE — re-measure, state the season's live status, rehearse
the rollback, and get the user's dated go-ahead BEFORE any code. The design is
`docs/superpowers/specs/2026-09-06-schedule-write-rpc-design.md`, which is self-contained
and carries the four hazards, the signature, what gets deleted, and the two-psql
test that is the only thing which actually exercises the lock. Its §2.1 is the one
to read first: `0026` is the precedent you will have open, and copying its
`season_is_started` gate along with its lock pattern would silently disable repair
the moment the first game is played — with every test still passing.

**What it is:** a `plpgsql` function taking `pg_advisory_xact_lock(hashtext(p_season::text))`
and doing the whole batch in one transaction, following `bfe0400`'s precedent — that
commit fixed a two-session race which left a season with **zero games** while
reporting success. It closes two things at once: multi-row atomicity, and the
season-level serialisation that lets two managers' repairs interleave and drift pair
balance with no drift report.

⚠️ **The evidence for doing it is the review history, not a hunch.** Round 1 found the
write paths raced; round 2 found the compensator was itself a lost-update writer;
round 3 (mutation testing) found only the first failure in each 25-way chunk was kept,
so an ordinary multi-request network fault left games half-changed while reporting
"Nothing was written". Each fix was correct. The next layer is where the next bug was.

### The final pre-launch pass — found 2026-09-06, ✅ ALL FOUR FIXED

✅ **Done 2026-09-06, in this order: 1 first (it is the root cause under 2),
then 2, 3, 4.** Verified by the full suite behind the config change, not a spec:
`npm test` **32 unit files / 444 tests**; `PORT=3013 scripts/e2e-locked.sh`
**213 passed / 1 skipped / 0 failed in 4.8m across 29 spec files** — the same
numbers as the 2026-09-06 baseline, so `actionTimeout` cost the suite nothing.
The skip is still the API-key-gated AI-summary test in `03-seasons`.
Each item below now records what was done; the diagnosis is kept because it is
the reason the fix looks the way it does.

- **1** — `actionTimeout: 20_000` added to `use:` in `playwright.config.ts`,
  with the reasoning inline.
- **2** — `expectGenerateFormUsable` copied into `11-schedule-builder`,
  `23-schedule-constraints` and `14-one-off-game`. ⚠️ In the two specs whose
  seed sits behind a gate — `14-`'s `count("No draft schedule") > 0` and `11-`'s
  `removeButton.count() === 0` — the guard went **before** the gate, not inside
  the branch: the read-failed card makes both conditions pick the wrong branch,
  so guarding inside would still have misreported.
- **3** — `03-seasons` now asserts the destination heading
  `Season setup — <name>`; `PageHeader` renders it as an `h1`.
- **4** — renamed to `28-schedule-form-state` and `29-schedule-repair` via
  `git mv`, order relative to each other kept. `28-`'s one cross-reference to
  "`27`'s seeding" was repointed at `29-schedule-repair`. The `Path 26`/`Path 27`
  labels inside them are QA-path names, not filenames, and were left alone —
  file numbers and path numbers have never matched in this suite.

⛔ **All four are in the test harness, not the app.** Nothing here can reach a
manager or a player. What they cost is a session's time, and two of them spend it
as a multi-minute hang with a message that names the locator and not the cause.
⚠️ Each says whether it was **watched** or is **a reading**.

**1 — `playwright.config.ts` sets no `actionTimeout`.** (Watched.) Its `use:`
block sets `baseURL`, `trace` and `screenshot` only, so `fill`, `click` and
`check` fall back to the whole test budget. An action that can never resolve
therefore burns the test's entire timeout and reports `waiting for <locator>`
with no clue why. This is the root cause under defect 2, not a separate item:

```ts
use: {
  baseURL: `http://localhost:${PORT}`,
  actionTimeout: 20_000, // above expect's 15 s, below the 60 s test budget
  trace: "on-first-retry",
  screenshot: "only-on-failure",
},
```

⚠️ **A reading, not a measurement, on its blast radius.** One line, but it changes
the budget of every action in the suite. Run the full suite behind it, not a spec.

**2 — three specs seed the schedule builder with no read-failed guard.**
(Watched, CI run `34055032836`.) `getPublishState` fails closed: any of its seven
parallel reads erroring locks the panel and renders "This season's games couldn't
be read", with **no generate form on the page at all**. #38 added
`expectGenerateFormUsable` to what are now `28-schedule-form-state` and
`29-schedule-repair` (item 4 renumbered them);
these three still seed it bare:

| Spec | Seeding shape | What a read failure costs |
|---|---|---|
| `11-schedule-builder` | bare `fill` | waits out its 150 s budget |
| `23-schedule-constraints` | bare `fill` | the same, 150 s |
| `14-one-off-game` | `if (count("No draft schedule") > 0)` | does **not** hang — skips the seed, then fails later on an unrelated assertion |

⛔ **The polarity of the seeding gate decides whether a read failure hangs or
misleads, and neither is legible.** `27-` gated on
`count("Published: N games") === 0`, which is *true* while the error card is
showing — so it entered the seeding branch and waited out its whole budget.
`14-`'s condition is *false* while that card shows, so it skips the seed and
misreports the failure an assertion later. A guarded seed is not optional just
because a spec happens to have the safer polarity.

Copy `expectGenerateFormUsable` out of
`e2e/29-schedule-repair.spec.ts` (`27-` before item 4 renumbered it): there is no shared helper module in `e2e/` and
no spec imports another, so duplicating it is the house style here.

**3 — `03-seasons.spec.ts` races a redirect.** (Watched — this is the failure
that failed PR #38's CI, and the artifact settles it.) The test asserts
`Season "<name>" created.` is visible after clicking **Create season**. But
`CreateSeasonForm` renders that message and, in a `useEffect` on the same state,
calls `router.push` to the new season's page — so the assertion is racing the
navigation. The failure snapshot from run `34057995109` shows the browser already
on `Season setup — Audit Probe Season …`: the action succeeded, the season was
created, and the message was simply gone.

Fix — assert the destination rather than the vanishing message:

```ts
await expect(
  page.getByRole("heading", { name: `Season setup — ${seasonName}` }),
).toBeVisible();
```

⚠️ **Pre-existing, and rare.** `create-season-form.tsx` last changed three commits
before the schedule work started, and the test passed on the very next full local
run. Rare is what makes it worth fixing rather than watching: it will fire again,
on someone else's branch, and look like their bug.

**4 — two specs each answer to `26-` and `27-`.** (Watched.) #38 and #39 were
built in parallel worktrees and both numbered new specs from the same free slot:
`26-schedule-form-state` / `26-sign-out-destination`, and `27-one-chrome` /
`27-schedule-repair`. Nothing is broken — Playwright orders by filename, so the
run is still deterministic — but the number no longer identifies a spec, and #38's
own ordering note ("the spec that ran before it") is now ambiguous. Renumber #38's
pair to `28-` and `29-`, which keeps their order relative to each other.

### The fixture dates — ✅ FIXED AND MERGED (PR #44, 2026-09-09)

✅ **Merged 2026-09-09 as PR #44; nothing in this file is outstanding.** Found
2026-09-06 during the review of PR #40; not fixed there, because fixing it means
changing how those specs seed rather than editing a line.

**What happens.** `11-schedule-builder` and `23-schedule-constraints` both drive
Fall 2026 and both hardcode a first game night of **`2026-09-15`** — `11-` at
seven call sites, `23-` in its `FIRST_NIGHT` constant. Item 9's guard refuses a
first night in the past at GENERATE, with "That first game night has already
passed — pick tonight or a later date." `11-` has a test asserting exactly that
refusal, so the mechanism is not in doubt. From **2026-09-16** every generate in
both specs is refused and both files fail. Nothing about the app is wrong.

⚠️ **A reading of the dates and the guard, not a measurement** — the clock has
not reached it. Everything else about the two specs is measured; this is
arithmetic on today's date.

**Why it was left.** The fix is to compute a date instead of pinning one, which
touches the seeding of every test in both files, and it lands six days after the
schedule window shuts on 2026-09-10 — so it is genuinely not launch-blocking.
⛔ **But it will fire on someone else's branch and look like their bug**, which
is the same failure mode the four items above existed to prevent.

**When it fires, the guard now says so.** `expectGenerateFormUsable` races a
third locator as of PR #40: a started season renders "The season is under way",
and the guard names it and says it is permanent, not transient, and to check the
dates the spec seeds. That is a legible failure, not a fix.

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
  something it did not overwrite. _A reading of the code; not reproduced._
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
  documents under `loading.tsx`'s _Status Codes_. Next emits
  `<meta name="robots" content="noindex">` on every such body, so the soft-404
  concern is handled; what is left is monitors reading the status line. The
  documented remedy is a check in `proxy`, i.e. a database round trip on every
  page view. Full evidence, including the two failed fixes, is on the issue —
  ⛔ do not re-run those experiments.
- ~~**CI does not run `npm run lint`**~~ — it does: `.github/workflows/ci.yml`
  runs it in the `Typecheck and unit tests` job, between `typecheck` and `test`.
- ~~**No `.nvmrc` or `engines`**~~ — both exist. `.nvmrc` holds `22`,
  `package.json` declares `"engines": { "node": ">=22.0.0 <23.0.0" }`, and the
  workflow now READS `.nvmrc` (`node-version-file`) rather than being the source
  of truth for it.
- **The generator has TWO bounds, and which one binds depends on where it
  runs.** Phase S ends at `OBHL_SLOT_RESTARTS` restarts _or_
  `OBHL_SLOT_BUDGET_MS`, whichever comes first (`assignNights.ts:130-131`).
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
  is exactly Playwright's _default_ assertion timeout — so the default left a
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
