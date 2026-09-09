# c1a35e — the deferred code work, reviewed and merged

**Protocol — read this and nothing else to resume.**

1. ⛔ **This is a RECORD, not a queue. There is no work in it.** It exists so the
   two odd states below are not re-derived, and so three findings that cost a
   session each are not re-learned. Its parent brief is
   `LAUNCH_READINESS_HANDOFF.md` §_Where the rest of the work is written down_.
   ⛔ Do NOT read `docs/worklists/2026-09-07-9466c507-deferred-code-work.md`
   (276 lines) to find outstanding work — it is CLOSED and its own header says so.
2. ⛔ **Standing hazards, unchanged and still true:**
   - `supabase db reset --linked` **wipes production**. `npm run db:reset` is the
     local one and is safe. `supabase db push` is the user's, never an agent's.
   - **Publishing a schedule is a one-way door** (`season_is_started`, `0026`).
   - Export a distinct `PORT` and run e2e only via `scripts/e2e-locked.sh` —
     worktrees share ONE Supabase, and several sessions run concurrently.
   - A fresh worktree has no `.env.local`: `cp /Users/richardkarp/dev/obhl/.env.local .env.local`.
3. Every number here was **watched appear**. Nothing below is a reading of the code.
4. Verify with `npm run typecheck && npx vitest run && npx eslint src e2e`.
   **491 tests / 39 files** on `main`, measured 2026-09-09. eslint floor: two
   `no-unused-vars` warnings in `src/lib/schedule/writeGames.test.ts`.
   ⚠️ **Regenerate that count; do not quote it.** It moved three times in two days,
   and every wrong version came from measuring a BRANCH instead of the MERGE.

**Status: closed. Nine PRs merged 2026-09-09 (#44, #45, #46, #48, #49, #50, #52,
#53, #54), branches deleted. Two states are odd and neither is visible from the PR.**

---

## The two odd states

**#51 (clock-shifted CI) is open and CANNOT be merged by an agent.** Not a CI
failure and not a conflict — GitHub itself refuses:
`refusing to allow an OAuth App to create or update workflow .github/workflows/ci.yml
without workflow scope`. It is green, CLEAN, retargeted to `main`, and verified
against the post-#48 gate. **It needs a human in the web UI**, or
`gh auth refresh -s workflow`. See the standing gate now in `AGENTS.md`.

**#47 (league creation at the root) was retargeted by GitHub, not by a person.**
It targeted `docs/deferred-code-work`; that branch was deleted when #45 merged, so
GitHub moved its base to `main` automatically. Confirm the base is right before
merging it. It belongs to another session.

## Three findings, so nobody pays for them twice

- ⛔ **A green run on a branch says nothing about the merge.** The unit baseline
  was recorded wrong three times — "480 is fabricated", then "480 becomes the
  baseline", then "480 minus 8" — and all three came from measuring a branch.
  `test/clock-relative-fixture` really did report 480/37 while `main` reported
  472/38, because `main` had gained `writeGames.test.ts` (+8) *and* shrunk
  `gameWrites.test.ts` from 29 to 13 (−16). Merging is what settles it. Related:
  refreshing seven stale PRs against the new `main` turned one red.
- ⛔ **A new test here passes against a completely broken guard by default.**
  Measured twice on the same file. Count assertions cannot see a scoping bug (a
  night swap preserves counts however the guard read), and with the wrong scope
  the touched rows fall out of `rows` so the guards degrade to no-ops that permit
  anything. Only a REFUSAL assertion catches it — and a row-level assertion, not a
  night-level one, catches a write that lands the right night at the wrong time.
  **Break the code and watch the test go red before believing it.**
- ⚠️ **Do not run prettier over a file that was not already prettier-clean.**
  Doing so repadded every table in `README.md` and `LAUNCH_READINESS_HANDOFF.md` —
  33 and 57 lines of churn for a one-line and a seven-line edit. Check first:
  `npx prettier --check <file>` on the pristine version.

## Provenance

Nine PRs, four independent review agents, three review rounds on #49 alone. The
per-item outcomes are in the closed dossier
(`docs/worklists/2026-09-07-9466c507-deferred-code-work.md`); the review findings
are in the PR descriptions. Neither is needed to resume anything.
