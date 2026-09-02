# 085d26f3 — close the cross-league escalation, then the audit gaps

> ## ✅ CLOSED 2026-09-02. Nothing here is outstanding.
>
> Items 1-6 are done and in `main`'s history or on
> `fix/staff-list-paging-and-guard`; item 7's review is done and turned up one
> more escalation, closed in the same branch. What survives is production work
> that needs a human, and it is recorded in `LAUNCH_READINESS_HANDOFF.md` —
> **read that, not this.** This file is kept only so the reasoning below stays
> attached to the measurements it came from.
>
> | # | Outcome |
> |---|---|
> | 1 | Closed by #18 for the promotion, and by `93e3b53` for every OTHER role write — a lateral change crossed leagues by the same two submissions. |
> | 2 | Closed by #18 (`16-league-membership.spec.ts`), rewritten by `93e3b53` to drive both directions. |
> | 3 | Closed by `93e3b53`: the dead guard's test now runs in `updateStaffRole`, where the reachable instance-wide write is. |
> | 4 | Closed by `1e60908`, and `8f5d73a` for the second call site it turned out to have. |
> | 5 | Closed by `06e62d5` — ten actions, two new `leagueOfEntity` cases, three tests. |
> | 6 | Closed by `06e62d5`. |
> | 7 | Review done; it found the RLS half of item 1, closed by `0a48873` (0033). ⚠️ **That migration still needs `supabase db push`.** `LAUNCH.md` Phases 2-6 remain unverified and need a human. |
>
> ⚠️ **The baselines below are stale.** Measured at the end of this work:
> **250 unit; 127 e2e passed / 1 skipped / 0 failed.**

**Protocol — read this and nothing else to resume.**

1. This file is self-contained. Its parent is `LAUNCH_READINESS_HANDOFF.md`
   (242 lines) — open it only for items 5-7 below, which live there and are
   **not** restated here. Do **not** read
   `docs/superpowers/specs/2026-08-31-per-league-routing-design.md` (383 lines);
   nothing here depends on it.
2. ⛔ **Hazards, before any instruction:**
   - `supabase db reset --linked` **wipes production**. Use `db push`.
   - Production items 0-2 in the parent (`ENABLE_DEV_LOGIN`, seeded accounts)
     are **live exposure** and outrank everything here. They need a human.
   - **Mutating `gh`** (`pr create`, `pr merge`) and `vercel env` are denied to
     an agent — ask. **Read-only `gh` works**: `run list`, `run view`,
     `run download`. On a red run, pull the artifact and read
     `error-context.md`; its page snapshot has twice settled in seconds what
     guessing got wrong.
3. Every number here was **watched appear** on 2026-09-02. Where a claim is a
   reading of the code rather than a measurement, it says so in those words.
4. Verify with `npm test && npm run test:e2e`.
   **Measured baselines** (predicate: one full local run each)
   ⚠️ **Regenerate these; do not quote them.** They moved while this file was
   being written (see *What changed under this file*).
   - `main` before #18 (`48bfd78`): 250 unit, **119 passed / 1 skipped / 0 failed**.
   - #18's branch at `acc1178`: 250 unit ×3, **120 passed / 1 skipped / 1 failed**
     — #18 adds two tests, one being item 2. An uncommitted fix then landed that
     makes that test pass, so `main` after the merge is most likely
     **121 passed / 1 skipped / 0 failed**. *Inferred, not watched.*
   - target when items 1 and 3 land: 121 plus whatever item 1's test adds.

## What changed under this file

Written while #18 was being merged, so two things moved mid-write. Both are
recorded because the reasoning matters more than the state:

**#18 is being merged** (the user's call, 2026-09-02) — its four commits:

    98f9924 fix: refuse cross-league staff writes, and page the account lookup
    7d85f15 fix: file remove_player audit entries under their league
    a79d4f3 refactor: check dashboard membership before loading the season
    acc1178 refactor: drop an unnecessary any from People & Roles

**Item 2's assertion was fixed in the working tree** — the regex now reads
`/already has an account as scorekeeper/`, matching what the page actually
renders, with a comment explaining that the role-mismatch branch answers first
and `mayWriteProfileOf` is the narrower second layer. That reading is correct
**for that fixture**, and the escalation *is* refused on the path that test
drives. CI should go green.

⚠️ **Green there does not mean closed.** Item 1 below is a *different* path
through the same form — same role, so no mismatch to refuse — and it was
measured succeeding. So the branch now carries a passing test named "adding an
existing account cannot rewrite the role it holds elsewhere" over a form that
still can. Item 1 is what makes that name true; item 2 is now a **coverage**
item, not a failure.

## Items

| # | Item | Where | Verdict |
|---|---|---|---|
| 1 | Same-role add + promote still escalates across leagues | `people.ts:188`, `:252` | **measured open** |
| 2 | No test drives the same-role path; `:293` covers only the mismatch one | `16-league-membership.spec.ts:293` | **coverage gap** |
| 3 | `mayWriteProfileOf` guard is unreachable for any account with a role | `people.ts:215` | **read, open** |
| 4 | `listUsers({ perPage: 1000 })` truncates the staff list silently | `people/page.tsx:46` | **read, open** |
| 5 | Audit gaps: `seasons.ts` 6/0, `announcements.ts` 2/0, `import.ts` 2/0, `logos.ts` 1/0 | parent handoff | open |
| 6 | `grant_league` audit path untested | parent handoff | open |
| 7 | PR #13 never code-reviewed; `LAUNCH.md` Phases 2-6 unverified | parent handoff | open |

---

## 1 — The escalation, measured

Two ordinary form submissions on `/[league]/manage/people`, no tampering. Run as
a manager of `harbor` against `single-league-scorer@obhl.test`, a scorekeeper
whose only league is `obhl`:

1. **Add them with the role they already hold** (Scorekeeper). `existing.role !==
   role` is false, so the "a role is account-wide" refusal at `people.ts:181`
   never fires, and control reaches the `existing.role === role` branch, which
   calls `addLeagueMembership` (`people.ts:188`) with **no `mayWriteProfileOf`
   check**. They are now a member of `harbor`.
2. **Change their role to Manager from their new row.** `updateStaffRole` checks
   `isMemberOf` (`people.ts:252`) — now true — and refuses only *demotion*
   (`before?.role === "league_manager"`). It writes `profiles.role =
   'league_manager'`, which is **instance-wide**.

They are now a manager of `obhl`, which the actor cannot reach.

**This was watched, not reasoned.** A throwaway probe drove both steps through
the real UI and printed:

    STEP 2: role is account-wide, so this makes them a manager of obhl too
    Expected: "scorekeeper"
    Received: "league_manager"

The probe was deleted after the run; item 2 is where it should be rebuilt as a
keeper. Step 1's soft assertion did **not** fire, so the membership grant
succeeded silently — worth preserving as its own assertion.

The comment at `people.ts:209` already states the governing reason — "granting
the membership alone would leave the same rewrite one step away" — but applies
it only to the branch below it, not to the same-role grant above it.

*Recommendation, not a decision:* gate `updateStaffRole` on `mayWriteProfileOf`
as well. That closes step 2 wherever membership came from, rather than closing
one route into it; item 3 is then no longer dead code either.

## 2 — The test names more than it covers

`16-league-membership.spec.ts:293` is called "adding an existing account cannot
rewrite the role it holds elsewhere". It submits `league_manager` for a victim
holding `scorekeeper`, so the mismatch branch (`people.ts:181`) refuses and the
test passes. Nothing drives the same-role path, which is the one that works.

Add the item 1 scenario as its own test. Selector notes, all measured against
the running app:

- add-form Role control is a shadcn `Select`: `card.getByRole("combobox")
  .click()` then `page.getByRole("option", { name })`, labels `League manager` /
  `Scorekeeper` / `Captain` (`create-staff-form.tsx:55`).
- per-row control is a native `<select aria-label="Change role">` that
  **auto-submits on change** (`staff-row-actions.tsx:65`), so
  `row.getByLabel("Change role").selectOption("league_manager")` is the whole
  interaction. Wrap it in the file's `submitAndSettle` helper.
- no `tamper()` here — this path needs no hidden-field rewrite, which is the
  finding. Keep the helper for tests that do.
- assert step 1 separately (`profile_leagues` gained the actor's league) and
  soft, so a run reports the whole effect rather than the first half.
- restore `profiles.role` and `display_name`, and delete the granted
  `profile_leagues` row, in a `finally`.

## 3 — A guard that guards nothing

`people.ts:215` sits **after** `if (existing?.role) { … return }`
(`people.ts:177`). So `mayWriteProfileOf` runs only when the account has no
profile row or a null role. For any account that already holds a role — every
staff account — it is unreachable. *A reading of the code, corroborated by the
probe reaching neither of its messages.*

The function itself is sound and its league-less carve-out is deliberate
(`src/lib/auth/membership.ts`, `mayWriteProfileOf` doc comment) — the issue is
only where it is called from.

## 4 — The staff list truncates at 1000

`admin.auth.admin.listUsers({ perPage: 1000 })`
(`src/app/[league]/manage/people/page.tsx:46`) caps the auth-user lookup the
People table joins against. Past the 1000th auth user, staff **silently vanish
from the page** rather than erroring. `98f9924` paged `findUserIdByEmail`; this
call site was not part of that change. *A reading of the code; not reproduced —
the local instance has far fewer than 1000 users.*

## Parent pointers — do not restate here

Items 5-7 are held in `LAUNCH_READINESS_HANDOFF.md`, with their traps and
measured counts: the audit-gap table and the ⛔ `leagueOfEntity` switch trap
(add the `entity_type` to `src/lib/audit.ts` **in the same change**, or the entry
is written correctly and never appears), the `grant_league` testing note, the
PR #13 review, and `LAUNCH.md` Phase 6's hard deadline. Read that file when you
reach them.
