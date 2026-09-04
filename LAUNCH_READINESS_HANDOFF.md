# Launch readiness — what stands between this and two live leagues

**Protocol — read this and nothing else to resume.**

1. This file is self-contained. `ACCESS_CONTROL_HANDOFF.md` (~203 lines) holds
   the membership model and its traps — open it only when auditing another action.
   Do **not** read `docs/superpowers/specs/2026-08-31-per-league-routing-design.md`
   (383 lines); nothing outstanding depends on it.
2. ⛔ **Hazards, before any instruction:**
   - `supabase db reset --linked` **wipes production**. Use `db push`.
   - ⚠️ **The lockout risk is now REAL, not hypothetical.** Items 1 and 2 are
     closed, so dev-login and the seeded accounts are both gone — and with them
     every verified way into production's manage tools. If the JWT hook, SMTP or
     the redirect allow-list is broken, recovery is SQL against production. See
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
4. Verify code changes with `npm test && npm run test:e2e`. Measured on
   `feat/league-office` after merging `main`, 2026-09-04: **290 unit; 144 e2e
   passed / 1 skipped / 0 failed.** The skip is the AI-summary test, gated on an
   API key — not a regression. ⚠️ The counts move with every merge; re-measure
   rather than quoting them.
   ⛔ **Run e2e against a dev server belonging to YOUR worktree.** Every worktree
   runs `npm run dev` on port 3000 and Playwright's `reuseExistingServer` takes
   whichever is already up — so a suite can silently drive another branch's code
   and report it as yours. That produced nine phantom failures on 2026-09-04.
   `lsof -ti:3000` before believing a red run; a spare port sidesteps it.

**Status: both doors are shut and every migration is pushed.** As of 2026-09-04
`ENABLE_DEV_LOGIN` is gone from every Vercel environment, the seeded accounts are
deleted, and production carries `0001`-`0038` — including `0037`, which fixed
GAA being inflated by empty-net goals on live pages.

**What remains is item 4: the five `LAUNCH.md` phases, never verified.** That is
the whole of the launch gap now, and it needs a human on production. Item 5 is
deferred odds and ends.

## Next action

**Walk `LAUNCH.md` Phases 2-6 on production.** Nothing else is outstanding that a
checkout can see, and nothing below can be done from one.

⛔ **Read *Getting locked out* first.** `getSessionUser` reads the role from the
JWT claim with no database fallback, so a real manager whose claim is missing
gets a signed-in session with no role and no way in — and with dev-login now
removed, recovery is SQL against production. That risk went UP when item 1
closed, not down.

## The five items, and where they stand

| # | Item | Where | Status |
|---|---|---|---|
| 1 | `ENABLE_DEV_LOGIN` set on production | Vercel env | ✅ **closed 2026-09-04** — absent from every environment (`vercel env ls`) |
| 2 | Seeded test accounts live, password in git | Supabase dashboard | ✅ **closed 2026-09-04** — done by a human; not verifiable from a checkout |
| 3 | `0033` not pushed — the RLS half of the escalation | `supabase db push` | ✅ **closed** — and `0034`-`0038` with it |
| 4 | **`LAUNCH.md` Phases 2-6 never verified** | production | **OPEN** — below |
| 5 | Smaller deferred items | below | open |

⛔ **Do not re-file 1-3.** They are kept as rows, rather than deleted, because a
reader who knows this file by its old shape will otherwise assume they were
forgotten. The reasoning behind each is under *Closed doors* below.

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

`getSessionUser` (`src/lib/auth/session.ts`) reads the role from the JWT claim
with **no database fallback** — `role: claims.app_metadata?.role ?? null`. So if
the Custom Access Token hook is disabled, sign-in still appears to succeed and
every user has `role: null`, reaching no manage tools at all. A missing SMTP
config or redirect-allow-list entry breaks it one step earlier, at the magic
link. Any of the three, with the dev-login panel already removed and the seeded
accounts deleted, leaves no way in but SQL.

⛔ **That is now the standing state, not a warning about a future one.** Both
doors closed on 2026-09-04, and whether a real magic-link sign-in works has still
never been confirmed. Doing that — on `obhl.vercel.app`, as a real
(non-`@obhl.test`) manager, checking `/manage/dashboard` shows the Manager badge
— is the single highest-value action left in this file.

**`LAUNCH.md` Phases 2-6 are unverified from here.** This file speaks only to
Phase 1 (the test doors). The site is live with two leagues, so most of the rest
presumably happened — but *presumably* is the operative word: nobody has checked
SMTP, the Supabase redirect allow-list, or that the Custom Access Token hook is
still enabled. The hook is the one that fails quietly: `getSessionUser` reads
the role only from the JWT claim with no database fallback, so with it off
sign-in still appears to work and nobody reaches the manage tools.
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
- **CI is proven on runner hardware** — green on both jobs, unit at ~1m40s
  across four runs, all with the default `OBHL_SLOT_BUDGET_MS`. The env
  overrides in `vitest.config.ts` stay as unused levers.
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
- **Every worktree runs `npm run dev` on port 3000.** Playwright's
  `reuseExistingServer` takes whichever server is already up, so a suite can
  drive another branch's code and report the result as yours. Nine phantom
  failures on 2026-09-04 before `ps` named the culprit. Check `lsof -ti:3000`.
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
