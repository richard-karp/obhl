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
   Remote (2026-09-02), so **do not run `db push`**. Env vars and the auth user
   list are unread: items 0-2 are expectations to confirm, never findings.
4. Verify code changes with `npm test && npm run test:e2e`.
   Baseline: **250 unit passed; 118 e2e passed, 1 skipped, 0 failed.** The skip
   is the AI-summary test, gated on an API key — not a regression.

**Status: all the code has shipped; the doors are still open.** Per-league
access control (#13) and CI + the `saveRules` audit entry (#14, `ace8e0c`) are
both in `main`, and CI is green there. What remains is two production exposures
nobody has closed. `people.ts` now audits; the other unaudited actions are
below.

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

Everything else comes after. Those are improvements; 1 and 2 are an open door —
and while the bypass is live, #13's access control is moot on production anyway,
since anyone can hold a manager session regardless of what it enforces.

## Open, in priority order

| # | Item | Where | Cost |
|---|---|---|---|
| 1 | `ENABLE_DEV_LOGIN` still set on production | Vercel env | one command |
| 2 | Seeded test accounts live on production, password in git | Supabase dashboard | ~10 min |
| 3 | Smaller deferred items | below | — |

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

## The audit log still misses several actions

`people.ts` is done — `add_staff`, `grant_league`, `update_staff_role` and
`remove_staff`, all under `entity_type: "league_staff"` with the **league** id
as `entity_id`, since a person spans leagues and a profile id names no single
one. `leagueOfEntity` resolves it through `leagueIdIfExists`, the same path
`league_rules` uses.

⚠️ **`grant_league` is untested.** It is the branch of `createStaffAccount` that
hands an *existing manager* another league. Exercising it means adding a manager
to a second league, which changes how many managers that league has — and
`e2e/16-league-membership.spec.ts` reasons about exactly that. Worth covering,
but not by bolting it onto an existing test.

Still unaudited, measured 2026-09-02 by counting `logAudit({` call sites per
action file — exported actions vs audited:

| File | Actions | Audited |
|---|---|---|
| `seasons.ts` | 6 | **0** |
| `announcements.ts` | 2 | **0** |
| `import.ts` | 2 | **0** |
| `logos.ts` | 1 | **0** |

The destructive ones first: `unenrollTeam` (`seasons.ts:209`), `setActiveSeason`
(`seasons.ts:186`), `deleteAnnouncement` (`announcements.ts:43`),
`runEsportsdeskImport` (`import.ts:84`).

⛔ **The trap, every time.** `leagueOfEntity` in `src/lib/audit.ts` returns
`null` for any `entity_type` it does not handle, and a null league is filtered
out of every league-scoped view *and* hidden by RLS — so a `logAudit` call added
alone writes an entry that is **correct and never appears**. Add the type to
that switch in the same change. `seasons.ts` is cheapest (`leagueOfSeason`
exists, `"season"` is already in the switch); `announcements.ts` needs one line,
since `leagueOfAnnouncement` exists in `of-entity.ts` but was only ever wired up
as a *guard* resolver.

Prove each by knocking the switch case out and watching a test go red. And
count rows per action afterwards — the suite was green while `update_staff_role`
had written zero, because nothing exercised it:

    select action, count(*), count(*) filter (where league_id is null) orphaned
    from audit_log group by action;

## Not covered by the items above

Two things this file does not track, recorded so nobody assumes it is exhaustive.

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

**PR #13 was never code-reviewed** (50 files, +2545/-327, merged as `7c7c4a7`).
It has strong test evidence — `e2e/16-league-membership.spec.ts` drives ~30
cross-league refusal cases, each watched fail against a deliberately broken
guard — and CI is green. But no one has read it as a reviewer, and it is the
change that decides who can reach what. Two of its tests turned out to be
unreliable under slower hardware (see the tamper section below), which is the
kind of thing a review might have caught earlier. Worth a pass before the league
grows past one manager.

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

## 3 — Smaller, deliberately deferred

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

Items 1 and 2 come from `LAUNCH.md`, which remains the operational runbook —
this file records only what is still outstanding in it. Item 3 was found on
2026-09-02 by counting `logAudit` call sites per action file, while closing the
`saveRules` gap in `feat/ci-and-rules-audit`. The per-league work itself is
`ACCESS_CONTROL_HANDOFF.md`.

**Closed 2026-09-02 — do not re-file.** `LAUNCH.md`'s "Known limits at launch"
said staff roles were not league-scoped, that a scorekeeper could score either
league, that a second manager had access to both, and that People & Roles was
global with `removeStaff` deleting accounts outright. Every one of those was
true before per-league access control and is now rewritten against the code,
together with Phase 1's account list, which named three of the five seeded
accounts.
