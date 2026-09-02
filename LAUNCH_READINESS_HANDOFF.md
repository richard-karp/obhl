# Launch readiness — what stands between this and two live leagues

**Protocol — read this and nothing else to resume.**

1. This file is self-contained. `ACCESS_CONTROL_HANDOFF.md` (~190 lines) holds
   the membership model and its traps — open it only when starting item 3.
   Do **not** read `docs/superpowers/specs/2026-08-31-per-league-routing-design.md`
   (383 lines); nothing outstanding depends on it.
2. ⛔ **Hazards, before any instruction:**
   - `supabase db reset --linked` **wipes production**. Use `db push`.
   - **Items 1 and 2 are live exposure, not backlog.** Anyone with the URL may
     currently hold a manager session. Do them before any code work.
   - `gh` and `vercel env` are denied to an agent under the auto-mode
     classifier. **Ask a human to run them; do not work around it.**
3. Every number here was **watched appear** on 2026-09-02. Where a claim is a
   reading of the code rather than a measurement, it says so in those words.
   ⚠️ Of the hosted environment, **only the schema has been read**: `0029`-`0032`
   are in the **Remote** column of `npx supabase migration list --linked`
   (2026-09-02), so **the database is already ahead of the code — do not run
   `db push`.** Production env vars and the auth user list are *unread*, so
   items 1 and 2 below are expectations to confirm, never findings.
4. Verify code changes with `npm test && npm run test:e2e`.
   Baseline: **250 unit passed; 118 e2e passed, 1 skipped, 0 failed.** The skip
   is the AI-summary test, gated on an API key — not a regression.

**Status: the code is written; the doors are still open.** What remains is two
production exposures nobody has closed and the audit-log gaps in item 3 —
neither of which any pending merge addresses.

⚠️ This file describes `main` with **both** per-league access control (#13,
merged 2026-09-02) and `feat/ci-and-rules-audit` in it. If the second is not
there yet, point 4's baseline will not match. Confirm with:

    git log --oneline origin/main | head -5

## Next action

**Item 1, then item 2. Both need a human.** Item 1 is one command:

    vercel env rm ENABLE_DEV_LOGIN production && vercel --prod

Confirm at https://obhl.vercel.app/login that the "Quick sign-in (test mode)"
panel is gone. **That does not finish the job** — go straight to item 2, which
is a separate door the same person is best placed to close.

## Open, in priority order

| # | Item | Where | Cost |
|---|---|---|---|
| 1 | `ENABLE_DEV_LOGIN` still set on production | Vercel env | one command |
| 2 | Seeded test accounts live on production, password in git | Supabase dashboard | ~10 min |
| 3 | Audit log does not cover the access-control actions | `src/lib/actions/people.ts` | ~half a day |
| 4 | Smaller deferred items | below | — |

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

## 3 — The audit log misses the actions that grant and revoke access

The previous handoff said `saveRules` was "the only manage action that records
nothing". **That was wrong.** Measured 2026-09-02 — for each file, exported
actions vs `logAudit({` call sites:

| File | Actions | Audited |
|---|---|---|
| `people.ts` | 3 | **0** |
| `seasons.ts` | 6 | **0** |
| `announcements.ts` | 2 | **0** |
| `import.ts` | 2 | **0** |
| `logos.ts` | 1 | **0** |
| `rosters.ts` | 6 | 6 |
| `rules.ts` | 1 | 1 |

**Start with `people.ts`** — `createStaffAccount:73`, `updateStaffRole:148`,
`removeStaff:188`. In a codebase whose whole recent effort is per-league access
control, granting and revoking access leaves no trace. That is higher-stakes
than the `saveRules` gap that was prioritised over it.

Then the destructive ones: `deleteAnnouncement` (`announcements.ts:43`),
`unenrollTeam` (`seasons.ts:209`), `setActiveSeason` (`seasons.ts:186`),
`runEsportsdeskImport` (`import.ts:84`).

⛔ **The trap — read `ACCESS_CONTROL_HANDOFF.md` before writing any of these.**
`leagueOfEntity` in `src/lib/audit.ts` switches on `entity_type` and returns
`null` for anything it does not handle. A null league is filtered out of every
league-scoped view *and* hidden by RLS, so a `logAudit` call added alone writes
an entry that is **correct and never appears**. Add the type to that switch in
the same change. Cost differs per file (*reading of the code*):

- **`seasons.ts`** — cheapest. `leagueOfSeason` exists; `"season"` is already
  in the switch.
- **`announcements.ts`** — one line. `leagueOfAnnouncement` exists in
  `src/lib/league/of-entity.ts` but was only ever wired up as a *guard*
  resolver, never added to the `leagueOfEntity` switch.
- **`people.ts`** — needs a new resolver. A profile is not league-scoped on its
  own, so audit against the league id directly, the shape `league_rules` uses.

Prove each one the way this area is tested: knock the switch case out and watch
the test go red. A test that only asserts the entry was *written* proves nothing.

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

## 4 — Smaller, deliberately deferred

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
- **The unit suite is proven on CI hardware** — first run green in 1m41s with
  the default `OBHL_SLOT_BUDGET_MS`. The env override in `vitest.config.ts`
  stays as an unused lever; nothing needs it today.
- **The e2e balance assertion is still unproven there.** The first CI run never
  reached it: `11-schedule-builder.spec.ts` waits for the draft preview, and
  Playwright's default 5s assertion timeout was *exactly* the generator's own
  5s budget (`OBHL_SLOT_BUDGET_MS`, `src/lib/schedule/assignNights.ts`), so the
  wait had no headroom and passed only where the search converged early.
  `playwright.config.ts` now sets `expect: { timeout: 30_000 }`. **Do not tidy
  that back to the default** — it must stay above the generator's budget.
  With the wait fixed, CI now actually reaches the assertion that every team's
  GP is 4. If a 2-core runner cannot converge in 5s it will fail *there*, on a
  real quality bound. The lever then is `OBHL_SLOT_BUDGET_MS` in the **e2e
  job's** env, which flows to `npm run dev` and so to the generator — no code
  change, `envInt` already reads it. **Raise the budget; never loosen the
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
