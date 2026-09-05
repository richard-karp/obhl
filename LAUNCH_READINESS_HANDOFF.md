# Launch readiness — what stands between this and two live leagues

**Protocol — read this and nothing else to resume.**

1. This file is self-contained. `ACCESS_CONTROL_HANDOFF.md` (~203 lines) holds
   the membership model and its traps — open it only when auditing another action.
   Do **not** read `docs/superpowers/specs/2026-08-31-per-league-routing-design.md`
   (383 lines); nothing outstanding depends on it.
2. ⛔ **Hazards, before any instruction:**
   - `supabase db reset --linked` **wipes production**. Use `db push`.
   - ⚠️ **The lockout risk is still real, but it lost a leg on 2026-09-05.**
     Items 1 and 2 are closed, so dev-login and the seeded accounts are both
     gone — and with them every verified way into production's manage tools.
     Of the three ways in that could break, **the JWT hook is no longer one**:
     `getSessionUser` now falls back to `profiles.role` (#24, workstream D1).
     SMTP and the redirect allow-list are untouched and still break sign-in one
     step earlier, at the link itself. Recovery is still SQL. See
     *Getting locked out*.
   - **Mutating** `gh` (`pr create`, `pr merge`) and `vercel env` are denied to
     an agent under the auto-mode classifier — ask a human, do not work around
     it. **Read-only `gh` works**: `run list`, `run view`, `run download`. On a
     red CI run, pull the artifact and read `error-context.md` yourself; its
     page snapshot has twice settled in seconds what guessing got wrong.
3. Every number here was **watched appear**. Where a claim is a reading of the
   code rather than a measurement, it says so in those words.
   ⚠️ Production was read on **2026-09-04**: `migration list --linked` shows
   `0001`-`0038` on both Local and Remote — no gaps, no drift — and
   `vercel env ls` shows `ENABLE_DEV_LOGIN` absent from every environment. The
   auth user list is still **unread from here**; item 2 was closed by a human and
   is taken on report, not measured.
   ⚠️ **That reading is now stale on the Local side and unrepeated on the
   Remote one.** `0039`-`0041` exist in the repo as of #24 and have never been
   pushed; Remote has not been read since 2026-09-04, and `migration list
   --linked` **cannot run from a worktree** — the link lives in the main
   checkout. Run it there. This is item 6.
4. Verify code changes with `npm test && npm run test:e2e`. Measured on CI at
   `244e95b` (`feat/manager-tools`), 2026-09-05: **27 unit files / 357 tests;
   168 e2e passed / 1 skipped / 0 failed** in 9.2m, across 23 spec files. The
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

**Status: both doors are shut; three migrations are now waiting.** As of
2026-09-04 `ENABLE_DEV_LOGIN` is gone from every Vercel environment, the seeded
accounts are deleted, and production carries `0001`-`0038` — including `0037`,
which fixed GAA being inflated by empty-net goals on live pages. Since then #24
has added `0039`-`0041`, **unpushed**.

**What remains is item 4 (the `LAUNCH.md` phases, never verified) and item 6
(the three migrations).** Both need a human on production. Item 5 is deferred
odds and ends, item 7 is the half of the auth work that a checkout cannot do.

## Next action

**Push `0039`-`0041` before #24 merges — in that order, not the other one.**

⛔ **The merge deploys code that reads tables production does not have.** Vercel
builds `main` on merge, and #24's pages select `season_schedule_constraints`,
`player_league_archive` and `teams.logo_text_color`. The failures are not
uniform, and the quiet ones are worse than the loud one:

- **Public standings degrade by design.** `getStandings` logs and carries on,
  and `inkOf` falls back to null, which `TeamLogo` already renders as the white
  letters it drew before `0041`. Nobody sees anything wrong.
- **`archivedPlayerIdsIn` returns an empty set** on a failed read, so no one
  looks archived and every removed player is back in the pickers — a correct
  page showing the wrong league.
- **The manage roster page 404s.** `teams` is read with an explicit
  `logo_text_color` in the select list and `if (!team) notFound()` follows, so
  the whole page goes rather than the colour.

*A reading of the code, not a probe.* Push first, then merge.

    # from the MAIN checkout, not a worktree — the link lives there
    npx supabase migration list --linked      # expect 0039-0041 Local-only
    npx supabase db push --include-all
    npx supabase migration list --linked      # confirm they landed

⚠️ `--include-all` is not decoration. `0039`-`0041` sort below nothing applied,
but they will not be the only gap for long, and `db push` **silently skips** any
migration sorting under the latest applied one. This exact case needed it for
`0034`. ⛔ Never `db reset --linked`; it wipes production.

**Then walk `LAUNCH.md` Phases 2-6 on production.** Nothing else outstanding can
be done from a checkout.

## The items, and where they stand

| # | Item | Where | Status |
|---|---|---|---|
| 1 | `ENABLE_DEV_LOGIN` set on production | Vercel env | ✅ **closed 2026-09-04** — absent from every environment (`vercel env ls`) |
| 2 | Seeded test accounts live, password in git | Supabase dashboard | ✅ **closed 2026-09-04** — done by a human; not verifiable from a checkout |
| 3 | `0033` not pushed — the RLS half of the escalation | `supabase db push` | ✅ **closed** — and `0034`-`0038` with it |
| 4 | **`LAUNCH.md` Phases 2-6 never verified** | production | **OPEN** — below |
| 5 | Smaller deferred items | below | open |
| 6 | **`0039`-`0041` not pushed** — #24's three tables | `supabase db push` | **OPEN, and it gates the merge** — *Next action* |
| 7 | Staff can set a password, but only a commissioner can give them one | Supabase dashboard + `vercel env` | **OPEN** — needs a human; *The other half of auth* |

⛔ **Do not re-file 1-3.** They are kept as rows, rather than deleted, because a
reader who knows this file by its old shape will otherwise assume they were
forgotten. The reasoning behind each is under *Closed doors* below.

⚠️ **6 and 7 both arrived with #24** (`feat/manager-tools`: schedule
constraints, roster editing, team branding, staff auth, season gating). Item 6
is a blocker with a two-line fix; item 7 is a standing limitation that needs an
account created outside this repo.

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

⛔ **Two legs are still standing.** A missing SMTP config or redirect-allow-list
entry breaks sign-in one step earlier, at the magic link — before any of this
runs. With the dev-login panel removed and the seeded accounts deleted, either
one still leaves no way in but SQL. And whether a real magic-link sign-in works
has **still never been confirmed**. Doing that — on `obhl.vercel.app`, as a real
(non-`@obhl.test`) manager, checking `/manage/dashboard` shows the Manager badge
— remains the single highest-value action left in this file.

**`LAUNCH.md` Phases 2-6 are unverified from here.** This file speaks only to
Phase 1 (the test doors). The site is live with two leagues, so most of the rest
presumably happened — but *presumably* is the operative word: nobody has checked
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

## 5 — Smaller, deliberately deferred

- **`saveRules` read-then-upsert is not atomic** — two concurrent saves both
  read the same previous document, so one audit entry's `old_data` names
  something it did not overwrite. *A reading of the code; not reproduced.*
  Left alone: closing it means a plpgsql function and a migration, a bad trade
  for an unmeasured race on a page edited a few times a season.
- **`save_rules` entries are not revertible.** `old_data` holds what a revert
  needs, but `revertAuditEntries` (`src/lib/actions/audit.ts`) has no case and
  `isRevertible` in the audit page returns false.
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

Items 6 and 7 arrived with **PR #24** (`feat/manager-tools`) on 2026-09-05, the
five-workstream branch planned in
`docs/superpowers/specs/2026-09-04-manager-tools-and-auth-design.md`. Item 6 is
mechanical — three migrations the branch added. Item 7 is that branch's D
workstream stopping where it was always going to stop, at the SMTP account
nobody has created. ⚠️ Both were found by re-reading this file against the
branch rather than by anything failing, which is the only way either would have
surfaced before a merge: **the tests are green with item 6 open**, because CI
runs migrations from the repo and never sees production's.

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
