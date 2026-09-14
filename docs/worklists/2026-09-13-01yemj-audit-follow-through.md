# 01yemj — audit follow-through: security fixes, removals, then the finished-app test rebuild

**Protocol — read this and nothing else to resume.**

1. This file is the brief. Also read the plan for the part in flight:
   - part 1: `docs/superpowers/plans/2026-09-13-audit-security-and-removals.md` (1,009 lines);
   - part 2: `docs/superpowers/plans/2026-09-13-part2-test-rebuild.md`.

   ⛔ Do NOT read `LAUNCH_READINESS_HANDOFF.md` (1,229), `SCHEDULE_HANDOFF.md` (590),
   `ACCESS_CONTROL_HANDOFF.md` (420) or `EXPORTS_HANDOFF.md` (391) to find this work —
   none of them mention it. Open one only when a task edits its area. Do not re-run
   the audit: its findings are resolved below.
2. ⛔ **Hazards:**
   - **A security hole that is probably live in production.** Any signed-in account,
     the shared scorekeeper login included, can run
     `update profiles set role='league_manager' where id=auth.uid()` — policy
     `"own profile update"` in `0009_rls_roles.sql` names no columns. Reproduced on
     the local stack. **Production NOT confirmed**: the owner checks with
     `! npx supabase db query --linked "select has_column_privilege('authenticated','public.profiles','role','UPDATE')"`
     (`true` = exposed). Part 1 Task 1 fixes it.
   - **Commit only with the owner's explicit OK.** Given once, for part 1's seven
     commits; ask again for any new work. Push/PR only when asked — declined so far.
   - The work lives in worktree
     `/Users/richardkarp/dev/obhl/.claude/worktrees/audit-security-and-removals`,
     branch `worktree-audit-security-and-removals`, cut from `95c7699`. **Part 1, both
     plans and this file are committed there but NOT pushed.** ⛔ Do not remove the
     worktree until the branch is pushed: it is the only copy.
   - e2e resets the ONE local database all worktrees share: run only
     `PORT=3101 scripts/e2e-locked.sh <specs>`. Nothing `--linked` or `db push` from
     an agent; the owner pushes `0050` and `0051`.
3. Every number was **watched appear** unless marked _(reading)_. Line numbers drift:
   find code by the symbol or test name given, not the line.
4. Verify with `npm test`. Baseline in the worktree, 2026-09-13: **51 files, 643
   passed + 1 todo, 250.7 s**.

**Status: part 1 is implemented, verified, reviewed and committed on this branch
(`3a7d198`..`ce7c62d`, on `95c7699`) — NOT pushed; no PR yet.** The final review added `0051` (logo bucket types + name check) and
hardened `0050`; the owner's push is now `0050` AND `0051`. Before pushing, run
`npx supabase db query --linked "select name, metadata->>'mimetype' from storage.objects where bucket_id = 'logos' and name !~ '\.(png|jpe?g|webp)$'"`
— `0051` blocks new non-image logos but does not remove existing ones. Progress and every ruling live in the SDD ledger,
`.superpowers/sdd/2026-09-13-audit-security-and-removals/progress.md` (git-ignored;
its BASE/HEAD shas are unreferenced snapshot objects, not commits). Part 2's plan is
written and not started — the owner should review its keep/delete tables before it
runs. Part 3 is designed; its executable plan is written after part 2 merges.

**How the owner wants it run (2026-09-13):**
- subagent-driven execution;
- no commits until the owner has reviewed;
- once commits are OK'd, this brief and both plans go into a docs commit on part
  1's PR;
- this worktree stays until that commit exists.

**Part 1, resuming:**
- Task 1 review needed fixes, 1 Important finding. e2e/16's "a session cannot mint
  a manager of another league through the API" wrote `role` in step 2, which 0050
  refuses anyway. It is retargeted to `display_name`, read back via `db`. It still
  has to be shown red with `may_write_profile` loosened.
- Deferred minors: no positive `display_name` control; the INSERT branch is
  untested; no explicit `security invoker`; the report missed the `seasons.ts` write.
- On exit: ledger this, then fix round 1 on the Task 1 implementer, re-review, then
  Tasks 2–7.

## Owner decisions, 2026-09-13

- **Option B:** rebuild tests and docs for a finished app. Tests protect the *next
  change*, not an idle app. Keep a smoke test per weekly flow, the access/security
  checks, and score/standings logic; drop regression pins and schedule-quality bounds.
- **Remove** the esportsdesk full migration, and the AI game recap + league summary.
- **Keep** the one-off planner and repair (the season started 2026-09-10; mid-season
  is when they get used). Schedule requests: offered as a cut, not chosen, so keep.
- Security fix first, in a worktree.
- Their first reaction was that the audit cut too little — see memory
  `audit-cut-against-absolute-standard`.

**Decided later the same day (planning session for parts 2 and 3):**
- **Docs:** one ~300-line `RUNBOOK.md` replaces the 4 handoffs, `LAUNCH.md`,
  `docs/superpowers/**` and `docs/worklists/**`. `AGENTS.md` shrinks to a pointer
  plus the standing gates.
- **verify-transfers:** port its checks into e2e, then delete it.
- **rankStandings:** points → wins → head-to-head → GD → GF is the league rule, so
  the test pins it.
- **Part 3** adds a "games still open" card on the manage dashboard.
- **Refinements accepted:**
  - part 3's detailed plan is written after part 2 merges;
  - roster changes get their own file, `10-roster-changes`;
  - the split-source deletion rule;
  - `09-access` splits into two tasks;
  - scoped per-task e2e runs, with two full-suite checkpoints.
- **Refinement declined:** counting ⛔/⚠️ markers during the comment trims.
- **Kept by the brief's default:** legacy redirects `/:league/score*` and
  `/:league/import`; un-refactored `schedule-builder-panel.tsx`; the anon grants on
  `office_tier_of` and `may_write_profile`; the `LeagueRef` thunk.

## Index

| Part | State | Where |
|---|---|---|
| 1 — security fixes + the two removals | done, committed locally — not pushed | `docs/superpowers/plans/2026-09-13-audit-security-and-removals.md` |
| 2 — test rebuild (B) | plan written, not started | `docs/superpowers/plans/2026-09-13-part2-test-rebuild.md` |
| 3 — code, comment and doc trims | design written; executable plan after part 2 merges | _Part 3_ below |
| Ops — owner only | not started | _Ops_ below |

**Order:** 1 → merge → owner pushes `0050` + `0051` → 2 → merge → write part 3's plan → 3.
Part 2 must follow part 1 so the removals land while the full e2e suite still exists.

## Part 2 — test rebuild

**The plan is `docs/superpowers/plans/2026-09-13-part2-test-rebuild.md`.** It carries
the survival rule, every keep/delete title and the rulings below. Targets, reported
and not gated: e2e 34 specs / ~12.4k lines → ≈10–12 specs and 3–4k lines; unit
10,790 lines / 250 s → ≈5k lines; verify scripts 7 → 0.

**Rulings the plan applies:**
- 06's revert test survives: it is the only e2e coverage of `revertAuditEntries`.
- The legacy-redirect tests become one table-driven test in `09-access`.
- Spec 15 cuts: page title, "nav links… mark current section" and "a section stays
  marked on detail pages" go. The anonymous-switcher test folds into 27's anonymous
  test. Of the two "posted in one league does not appear in the other" tests, the
  announcement one stays. "manage switcher moves between leagues" moves to `07-staff`.
- No shared-helper spike: Playwright 1.61.0, Node 22.18 and the CommonJS e2e tsconfig
  are unchanged since the 2026-09-06 failure. Each merged file keeps one local
  `admin()` and `signInAs()`.

**Corrections to the audit's findings (measured 2026-09-13):**
- **e2e order.** Spec 22 transfers a goalie and never restores it, and 13's Path 20
  counts goalie suggestions, so 22 must stay after 13. 21's teardown ignores errors,
  and a leftover imported league would become 16's `LEAD_OUT`, so the merge asserts
  the delete. 17 creates no league.
- **Spec 15 is not a pure duplicate.** Its export test is the only one asserting
  `${league.name} Schedule` / `harbor-schedule.*`, so it merges into 01's export test.
  Its "not scoreable" test (URL mismatch → 404) differs from 16's (membership →
  redirect).
- **`applyOneOffGame`.** `writeGames` logs only `schedule_one_off_failed`, so logging
  `schedule_one_off` on success cannot double-log. `logAudit` resolves the league
  from `entity_type: "season"`.
- **Seed.** The leagues are `obhl` (Oceanview, 6 teams, Tue+Thu) and `harbor`
  (4 teams), so the test calendars are named by shape.
- **The brief was wrong on:**
  - spec 30 leaking 2028: it doesn't;
  - "not scoreable" ×2 in 16: it appears once;
  - the calendar copy counts: the 6-team Tuesday calendar appears ×7, the 8-team ×3.
- **`vitest.config.ts`.** `OBHL_SLOT_BUDGET_MS=5000` equals production's default. No
  verify script runs in CI, and no plan touches `.github/workflows/`.
- **The `next` check** duplicates `season-context.ts`'s, so it becomes a shared lib
  module.

**Found while writing the plan (code read 2026-09-13):**
- The two `next` checks do NOT share a fallback (`/auth/confirm` → `/`, `selectSeason`
  → `/<slug>/dashboard`). `safeNextPath` takes the fallback as a parameter.
- `verify-transfers` #2 is NOT covered by 22. The seed names a goalie of record on
  every final game, and `v_goalie_stats`' explicit-pick branch joins no roster row, so
  22's goalie test passes even against a move that deletes the old row. The plan
  rebuilds that test on a dressed goalie with no pick, and shows it red with the move
  turned into a delete.
- `apply_game_writes`' stale-edit refusal cannot be reached through the UI without a
  race: every caller reads and writes in one request. The plan calls the function
  directly with a stale expectation; `gameWrites.test.ts` already pins the manager's
  message.

**Resolved:** ~~Ask the owner: `rankStandings` applies wins before head-to-head — is
that the league's rule?~~ Yes — points → wins → head-to-head → GD → GF.

**Carried from part 1's final review — NOT yet in the part 2 plan; add before it runs:**
- `runRosterOnlyImport` failure branches are untested (`season_teams` failure, roster
  shortfall, no teams, reserved slug, fetch failure, season rollback). `AGENTS.md`
  points here for them.
- A manager-session upload of an `.svg` (and of a `.png` name sent as `image/svg+xml`)
  is refused by `0051`. Control-verify outside the e2e harness first (the `0046` trap).
- `uploadTeamLogo` refuses a disallowed name before `storage.upload`; edge names
  (`crest.PNG.svg`, trailing dot) in `logo-type.test.ts`.
- `0050`: a positive control that a session can still write its own `display_name`, and
  the INSERT branch (a manager-session insert with a non-null `role`).
- Four verify-script checks the part 2 plan leaves untested: anon `setStaffPassword`
  POST; scorekeeper and captain editing a final game; the fallback-game shutout.

## Part 3 — design only (the executable plan follows part 2's merge)

Its tasks name files part 2 creates or deletes (`05-scoring-night`,
`calendars.test-support.ts`, the `roundRobin` callers), which is why its plan waits.

**Constraints to carry:**
- Start from a fresh branch off `main` after part 2 merges. No `.github/workflows/` edits.
- **Comment-only proof.** A scratchpad `comment-only.cjs` (below) parses each changed
  `.ts/.tsx/.mjs` file at base and head with TypeScript's printer
  (`removeComments: true`), collapses whitespace, and compares the two. It must exit
  0. Also grep the diff for removed `eslint-disable`, `@ts-expect-error`,
  `@ts-ignore`, `@ts-nocheck` and `/// <reference`; that grep must print nothing.
- A kept warning is at most 2 lines and names a `RUNBOOK.md` section. Delete history,
  docblocks that restate the signature, and narrative.
- Keep: the `shadcn` and `@tiptap/pm` deps, `planByWeeks`, the multi-attempt search,
  the legacy redirects, and the `supabase/migrations/**` comments.

**Tasks:**
1. **Delete dead code.** Remove `src/components/ui/{avatar,dropdown-menu,separator,sheet,tooltip}.tsx`
   and `src/utils/supabase/client.ts`. Keep `radix-ui`.
2. **Small cleanups.**
   - Collapse the 4 remaining duplicate `revalidatePath` pairs: `players.ts` ×1, `rosters.ts` ×3.
   - Delete the unused `/manage/tonight` redirect.
   - Remove the test-only `roundRobin()` and rewrite its remaining test callers.
3. **One `mulberry32`.** Capture a baseline of `assignNights` output for a fixed seed.
   Create `src/lib/schedule/rng.ts` and make the 6 identical copies import it. The
   re-captured output must `cmp` identical.
4. **"Games still open" card.**
   - Extract `isPast` into `src/lib/games/open-past.ts` as `openPastGames(games, today)`:
     `scheduled` or `in_progress`, with `leagueDateKey(scheduled_at) < today`.
   - Add a manager-only card on the dashboard, using `getSchedule` for
     `getManageContext`'s season. Rows link to the score page; the card is hidden
     when empty.
   - Unit-test the filter.
   - Add one e2e in `05-scoring-night`: set a non-Sharks round-4 game `in_progress`,
     assert its href on the card, and restore everything in `finally`.
5. **`RUNBOOK.md` and the docs collapse** (most capable model).
   - Distill from PR #74's `LAUNCH_READINESS_HANDOFF.md`, the other 3 handoffs,
     `LAUNCH.md` and `AGENTS.md`.
   - Delete the rest of `docs/`, except the executing plan.
   - Rewrite the 20 source and e2e path pointers.
   - Trim `README.md`.
6. **Fix the stale clustering comments** in `schedule.ts` and `assignNights.ts`.
7. **Comment trim, by area.** Each area is proven comment-only and reports its counts
   against 12,871 comment / 35,732 code lines:
   - `src/lib/schedule/**`
   - `src/lib/actions/**`
   - `src/components/**` and `src/app/**`
   - the rest of `src/lib/**` and `next.config.ts`
8. **Whole-branch verification**, then the owner's steps: close PR #74 as superseded;
   close PR #51; prune the 21 remote branches.

**Corrections that apply to part 3 (measured 2026-09-13):**
- **`/manage/tonight` is reachable.** No `/manage/:rest*` rule exists, only
  `/:league/manage/:rest*`. It is deleted as unused and never released.
- **Dead UI components** import `radix-ui`, which 8 live components still use, so
  there is no uninstall.
- **The stale clustering claim** is not in `spacing.test.ts` but in `schedule.ts`
  (the `variation` docblock) and `assignNights.ts`.
- **No per-league timezone:** `LEAGUE_TZ`, `leagueDateKey` and `leagueToday` live in
  `src/lib/format.ts`. The schedule page already has `isPast`.
- **Comment-only proof.** `tsc --removeComments` + `diff -r` fails, because of
  `tsbuildinfo`, `.next/types`, and the blank lines deleted JSX comments leave. Part 3
  uses the TypeScript-printer script below, plus a grep for removed lint and
  type-check directives.

`comment-only.cjs`, verbatim:

```js
// Proves a diff changes only comments: parse each changed .ts/.tsx/.mts/.mjs file at BASE and in
// the working tree, print with comments removed, collapse whitespace, compare.
// Usage: node comment-only.cjs <base-ref>   (exit 0 = comment-only)
// Known gap: collapsing whitespace hides a whitespace-only edit inside a string literal.
// Pair with: git diff -U0 <base> -- '*.ts' '*.tsx' '*.mjs' | grep -E '^-.*(eslint-disable|@ts-(expect-error|ignore|nocheck)|/// <reference)'
// which must print nothing (removing a directive is comment-only to the AST but not to lint/tsc).
const ts=require("typescript"),fs=require("fs"),{execFileSync}=require("child_process");
const base=process.argv[2], git=(...a)=>execFileSync("git",a,{encoding:"utf8",maxBuffer:1<<28});
const kind=f=>f.endsWith(".tsx")?ts.ScriptKind.TSX:/\.m?js$/.test(f)?ts.ScriptKind.JS:ts.ScriptKind.TS;
const norm=(f,t)=>ts.createPrinter({removeComments:true})
  .printFile(ts.createSourceFile(f,t,ts.ScriptTarget.Latest,true,kind(f))).replace(/\s+/g," ");
const files=git("diff","--name-only",base,"--","*.ts","*.tsx","*.mts","*.mjs").split("\n").filter(Boolean);
let bad=0;
for(const f of files){let b=null;try{b=git("show",`${base}:${f}`)}catch{}
  const a=fs.existsSync(f)?fs.readFileSync(f,"utf8"):null;
  if(b===null||a===null){console.log("ADDED/DELETED:",f);bad=1;continue}
  if(norm(f,b)!==norm(f,a)){console.log("CODE CHANGED:",f);bad=1}}
console.log(files.length+" files checked");process.exit(bad);
```

## Ops — owner only

1. Domain `lccalumnihockey.ca`: auto-renew (registered 2026-09-07 _(per handoff)_).
   Give two managers passwords, so they can still get in if email fails.
2. `next` 16.2.7 → 16.3.5: `npm audit` shows critical/high advisories. Turn on the
   Dependabot security-updates setting.
3. A close-night failure is invisible. Decided: part 3 Task 4's "games still open"
   dashboard card covers it.
4. Supabase plan and backups: unknown.
5. Node 22 EOL 2027-04-30.
6. No playoff-creation UI; rosters don't carry forward; no confirm on announcement
   delete or player merge.
7. Close PR #51; prune about 20 stale branches.
8. Is `CRON_SECRET` set in Vercel production? Unverified.
9. Close PR #74 as superseded after part 3 (its handoff is distilled into `RUNBOOK.md`).
