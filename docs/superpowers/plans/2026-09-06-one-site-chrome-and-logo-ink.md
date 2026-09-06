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

**Status: BUILT 2026-09-06** on branch `worktree-agent-a9825f0d016f4749d`
(worktree `.claude/worktrees/agent-a9825f0d016f4749d`, `PORT=3102`), against spec
`19adb22`. **Not merged, no PR.** All three steps done, in the planned order.

| Step | SHA | Files | What |
|---|---|---|---|
| 1 — logo ink & crests | `553b42d` | 20 | the 15 bad call sites, plus migration `0044` |
| 3 — sign-out | `6ada257` | 6 | slug as a validated hidden field, `/` fallback |
| 2 — one chrome | `8455541` | 10 | `ManageNav`'s shell and `crossLink` deleted |

**Measured** (the agent ran these and read the output): unit **379 tests / 31
files** green; full e2e **205 passed, 1 skipped, 0 failed** in 4.3 min after step 2;
typecheck and `eslint src e2e` clean. 12 new e2e tests across
`e2e/25-team-logo-ink.spec.ts`, `e2e/26-sign-out-destination.spec.ts`,
`e2e/27-one-chrome.spec.ts`, plus a 5-test `src/components/shared/team-logo.test.ts`
**that passed on its first run** — the control confirming `TeamLogo` itself was
never the bug.

### The migration — one was needed

`supabase/migrations/0044_team_logo_in_stats_views.sql` re-issues `v_skater_stats`,
`v_goalie_stats`, `v_skater_season_totals` and `v_goalie_season_totals` with
`team_logo_path` and `team_logo_text_color` **appended** — `create or replace view`
can only add columns at the end, and the totals views select the per-team ones by
name, so widening those first is safe. Every other line is verbatim from 0024/0037.
⚠️ **Applied `--local` only.** Never `db push`ed. `npm run gen-types` was re-run and
its output prettier-formatted, which also picked up one pre-existing drift:
`player_in_my_league` was missing from the committed types.

### What the audit got wrong

The 19-row call-site table was **exactly right** — no missing rows, no spurious
ones. Four things around it were not:

1. **§3's claim that the standings view carries `team_logo_text_color` is false.**
   It does not. `getStandings` side-reads it from `teams` via `season_teams`, a
   decision documented in `src/lib/queries/standings.ts` and left standing;
   `logo_path` was added to that same read. The migration was for the four *stats*
   views only.
2. **`crossLink` had three callers, not two** — `src/app/page.tsx` (the league
   picker) passed one too. Removed.
3. **`/set-password` renders no `AccountCluster`**, so it has no sign-out control
   and cannot test the `/` fallback. The league picker is the page that draws the
   cluster with no league; `26-sign-out-destination.spec.ts` uses that instead.
4. **§4 omits the league switcher**, which lived inside the deleted `ManageNav`
   shell and had three e2e tests across specs 15/16/20. It moved into the staff
   row, member-gated and **below** the measured overflow bar. It cannot go in
   `AccountCluster`'s `children` slot — that slot sits outside the `user` branch
   and would render for anonymous visitors.

### The measurements (hard stop 3, honoured)

`site-header.tsx`'s numbers and its overflow bar are untouched. `MAX_INLINE_LINKS`
was deleted **together with the bar it measured**, its rationale preserved as a
`⛔ do not reintroduce without measuring` note. Because that bar now draws on staff
pages for the first time, the existing overflow test re-runs `fits()` at 768px on
`/obhl/dashboard` and `/obhl/seasons` with the staff row and switcher present —
true on both.

### ⚠️ One thing left for the user to decide

Removing the picker's "Manage" link means **a staged league is no longer listed for
the manager staging it** — the public list is public-only. Adding member leagues to
that list is a visible design change the spec did not authorise, so it was not done.
Flagged in the code and here.

### Deliberately not done

- In `schedule-builder-panel.tsx`, only the `select` column list and the two
  `<TeamLogo>` calls. Nothing in `actions/schedule.ts`, `lib/schedule/*`, the
  generate/publish/remove/one-off forms, or `actions/games.ts`.
- No toggle for the staff row; no page moved between route groups; no guard
  touched. No `db push`, no PR, no merge, no mutating `gh`.

### Two environment facts worth keeping

- `.env.local` pins `NEXT_PUBLIC_SITE_URL=http://localhost:3000`. In any worktree
  **not** on port 3000, `24-password-auth.spec.ts` fails with
  `ERR_CONNECTION_REFUSED` — the emailed recovery link redirects to :3000. Not a
  code failure: export `NEXT_PUBLIC_SITE_URL=http://localhost:<your port>` beside
  `PORT`. That is how the green full run above was produced.
- Three transient `global-setup` failures (`relation "public.leagues" does not
  exist`, PostgREST schema-cache misses, `profile_leagues` FK violations) came from
  the parallel session resetting the **shared** database. Retried, not "fixed".
  ⚠️ The parallel worktree has no `0044`, so a `db reset` from there drops the new
  view columns until this branch's migrations are re-applied.
