# One site, not two — merged chrome, team-logo ink, and where sign-out lands

**Protocol — read this and nothing else to resume.**

1. ⛔ **The steps are NOT in this file.** They are §6 of
   `docs/superpowers/specs/2026-09-06-one-site-chrome-and-logo-ink-design.md`
   (250 lines), which is self-contained and is the only file to read — it also
   carries the complete 19-row `TeamLogo` call-site audit, which is the part
   nobody should re-derive. This file is the index row and the record.
   ⚠️ Deliberately no second copy of the steps or the audit here.
2. ⛔ **The standing hazard, restated because nobody should have to open the spec
   to meet it: THE GUARDS ARE NOT THE CHROME.** This work moves headers. Every
   `requireLeagueManager` / `requireGameRole` stays where it is, and
   `(manage)/layout.tsx`'s `if (!user) redirect("/login")` stays. A page that
   leaves a nav is still reachable by URL, and the guard is the only thing
   between that URL and the data.
3. Claims are marked. **Watched** means a command was run and its output read.
   **A reading** means it follows from the code and has not been executed.
4. Verify with `npm run typecheck && npm test`, then `PORT=<yours> npm run test:e2e`.
   ⚠️ Step 2 changes every page's chrome and the suite is full of header
   selectors — run the FULL suite for it, not just its own specs.

**Status: IN FLIGHT as of 2026-09-06.** Built by a subagent in its own worktree on
`PORT=3102`, against spec `19adb22`. Not merged, no PR.

## The three steps, one line each

Ordered 1 → 3 → 2 deliberately, so the risky one lands on a green tree. Detail,
traps and acceptance are in spec §6.

- [ ] **1 — team-logo ink and images, everywhere.** 15 of 19 call sites pass
      neither `logoPath` nor `textColor`, or only one of them. ⚠️ Missing
      `logoPath` is the bigger half and is invisible until a team uploads a crest.
      First job is reading what the database VIEWS expose — that is the only part
      that could need a migration.
- [ ] **3 — sign-out lands on `/<league>`.** Slug plumbed as a hidden field,
      **validated server-side**, `/` fallback for pages with no league.
- [ ] **2 — one chrome.** Chrome moves up to `[league]/layout.tsx`; `StaffLinks`
      gated on membership, not role; `ManageNav`'s shell and `AccountCluster`'s
      `crossLink` deleted. ⚠️ The two header-overflow measurements are measured
      facts — re-measure, never adjust by eye.

## The two decisions the user made when asked, 2026-09-06

Recorded here because they are the kind of thing a later session re-opens:

- **The staff row is ALWAYS VISIBLE, with no toggle.** A toggle was offered and
  declined. No "Manage" link, no "View site" link, no mode to be in or out of.
- **Sign out lands on the league's public home**, not `/` and not `/login`.

## What was built

*Filled in when the work lands: branch, commit shas, measured test counts, whether
a view migration was needed and what it does, what the call-site audit turned out
to be wrong about, and anything deliberately not done.*

⚠️ **Also add the back-link then.** The spec does not yet point at this file — see
the note in the schedule plan for why.
