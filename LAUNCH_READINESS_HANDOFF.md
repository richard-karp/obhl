# Launch readiness — what stands between this and two live leagues

**Protocol — read this and nothing else to resume.**

1. This file is self-contained. `ACCESS_CONTROL_HANDOFF.md` (~203 lines) holds
   the membership model and its traps — open it only when auditing another action.
   Do **not** read `docs/superpowers/specs/2026-08-31-per-league-routing-design.md`
   (383 lines); nothing outstanding depends on it.
2. ⛔ **Hazards, before any instruction:**
   - `supabase db reset --linked` **wipes production**. Use `db push`.
   - **Items 1 and 2 are live exposure, not backlog.** Anyone with the URL may
     currently hold a manager session. Do them before any code work.
   - **Mutating** `gh` (`pr create`, `pr merge`) and `vercel env` are denied to
     an agent under the auto-mode classifier — ask a human, do not work around
     it. **Read-only `gh` works**: `run list`, `run view`, `run download`. On a
     red CI run, pull the artifact and read `error-context.md` yourself; its
     page snapshot has twice settled in seconds what guessing got wrong.
3. Every number here was **watched appear** on 2026-09-02. Where a claim is a
   reading of the code rather than a measurement, it says so in those words.
   ⚠️ Of production, **only the schema has been read** — `0029`-`0032` are on
   Remote (2026-09-02). `0033` is **not**, and pushing it is item 3: that is the
   one `db push` this file asks for, and it is a human's to run. Env vars and
   the auth user list are unread: items 0-2 are expectations to confirm, never
   findings.
4. Verify code changes with `npm test && npm run test:e2e`. Measured on
   `fix/staff-list-paging-and-guard`, one full local run, 2026-09-02: **250
   unit; 127 e2e passed / 1 skipped / 0 failed.** The skip is the AI-summary
   test, gated on an API key — not a regression. ⚠️ The e2e count moves with
   every merge; re-measure rather than quoting it.

**Status: the code is closed; the doors are not.** #13, #14, #17 and #18 are in
`main`, and `fix/staff-list-paging-and-guard` closes what reviewing #18 turned
up: the cross-league escalation in the app AND in RLS, the audit gaps, and the
staff-list truncation. What is left needs a human with production access —
**two open doors, one migration to push, and five unverified `LAUNCH.md`
phases.** Nothing below can be done from a checkout.

## Next action

⛔ **Item 0 gates item 1.** The dev-login panel is the only *verified* way into
production's manage tools, and removing it without a working real sign-in locks
everyone out **silently** — recovery is SQL against production. Why it fails
quietly is under *Getting locked out* below.

So first, on `obhl.vercel.app`, as a **real** (non-`@obhl.test`) manager:
request a magic link, sign in, confirm `/manage/dashboard` shows the Manager
badge. If it fails, `LAUNCH.md` Phase 2; if no such account exists, Phase 4.

**Then item 1, then item 2. Both need a human.** Item 1 is one command:

    vercel env rm ENABLE_DEV_LOGIN production && vercel --prod

Confirm at https://obhl.vercel.app/login that the "Quick sign-in (test mode)"
panel is gone. **That does not finish the job** — go straight to item 2, which
is a separate door the same person is best placed to close.

## Open, in priority order

| # | Item | Where | Cost |
|---|---|---|---|
| 1 | `ENABLE_DEV_LOGIN` still set on production | Vercel env | one command |
| 2 | Seeded test accounts live on production, password in git | Supabase dashboard | ~10 min |
| 3 | **`0033` not pushed** — the RLS half of the escalation | `supabase db push` | one command |
| 4 | `LAUNCH.md` Phases 2-6 never verified | production | below |
| 5 | Smaller deferred items | below | — |

Item 3 is new and it is a real gap, not a tidy-up. 0032 gated
`manager write profiles` on *sharing* a league, which a manager can arrange:
grant someone a league you manage (permitted, and the flow the model exists
for), then rewrite the role that grant now lets you reach. Both steps were
watched succeeding through an ordinary session on the anon key — no admin
client, no app page. `0033_profile_write_containment.sql` swaps that policy for
containment; until it is pushed, the app guard is the only one holding on
production. It holds for every path through the site, so this is a second layer
missing, not an open door.

---

## 1 & 2 — Two doors, and closing one leaves the other open

`ENABLE_DEV_LOGIN=true` on a production build turns on the one-click role
buttons (`devLoginEnabled()`, `src/lib/auth/dev-login.ts`). Removing it hides
that panel.

**It does not lock out the seeded accounts.** `scripts/seed-users.mjs` sets a
password constant that is committed to this repo, and Supabase's password grant
is reachable with the anon key — so those accounts are a way in regardless of
any application setting, and regardless of what is deployed. `LAUNCH.md` Phase 1
has said so since it was written; the box is still unticked.

Five accounts are seeded (measured — `grep` over `scripts/seed-users.mjs`):

    manager@obhl.test          scorekeeper@obhl.test      captain@obhl.test
    single-league-lead@obhl.test    single-league-scorer@obhl.test

⚠️ **`LAUNCH.md:33` names only the first three.** The last two arrived with
#13's membership tests. Following that checklist literally leaves a **manager**
account (`single-league-lead@`) live with a known password.

*Reading, not a measurement:* which of the five exist on production is unknown
from here. The previous handoff observed `/manage/people` listing "all three
staff profiles", which suggests only the original three — but that was written
before the other two were seeded. **Check the Supabase auth user list directly.**
Deleting them is dashboard work: Authentication → Users. A `db reset --linked`
does *not* remove `auth.users`, so there is no shortcut.

## Reference — the audit log is closed; the trap under it is not

Every exported action now writes an entry. The one exception is
`previewEsportsdeskImport`, which fetches and parses and changes nothing.

⛔ **The trap stays, for whoever adds the next one.** `leagueOfEntity` in
`src/lib/audit.ts` returns `null` for any `entity_type` it does not handle, and
a null league is filtered out of every league-scoped view *and* hidden by RLS —
so a `logAudit` call added alone writes an entry that is **correct and never
appears**. Add the type to that switch in the same change, and prove it by
knocking the case out and watching a test go red. Both new cases —
`announcement` and `league` — were watched failing that way.

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
accounts deleted, leaves no way in but SQL. That is why item 0 exists.

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
- Supabase CLI 2.104 → 2.116, Vercel CLI 55 → 59.11.

## Provenance

Items 1, 2 and 4 come from `LAUNCH.md`, which remains the operational runbook —
this file records only what is still outstanding in it. Item 3 came out of the
PR #13 review on 2026-09-02.

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
