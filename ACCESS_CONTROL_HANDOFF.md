# Per-league access control — shipped, with CI and the audit gap closed

**Protocol — read this and nothing else to resume.**

1. This file is self-contained. Do **not** read
   `docs/superpowers/specs/2026-08-31-per-league-routing-design.md` (383 lines)
   or PR #13's description — what still binds is inlined below.
2. ⛔ **Hazards, before any instruction:**
   - `npx supabase db reset --linked` **wipes production**. Use `db push`.
     `npm run db:reset` is the _local_ one and is safe.
   - Do not change the `app_role` enum or the JWT hook (`0010_auth_hook.sql`).
     The model is membership-only _so that_ both stay untouched; changing the
     hook also means re-enabling it by hand in the Supabase dashboard.
   - `ENABLE_DEV_LOGIN=true` on a production deploy hands anyone with the URL
     a manager session — `devLoginEnabled()` in `src/lib/auth/dev-login.ts`.
     It is on by default outside a production build, which is what the e2e
     suite rides. Status of the hosted value lives in
     `LAUNCH_READINESS_HANDOFF.md`, not here.
3. Numbers here were **watched appear**. Where a claim is a reading of the code
   rather than a measurement, it says so in those words.
4. Verify with `npm test && npm run test:e2e`. Baseline:
   **250 unit passed; 118 e2e passed, 1 skipped, 0 failed** (measured
   2026-09-01). The unit count is unchanged and was watched three times over,
   because the schedule tests are wall-clock bounded and one green run proves
   nothing. e2e went 117 → **118**: the added test is the audit-visibility one
   in `e2e/10-rules.spec.ts` described below. The skip is the AI-summary test,
   gated on an API key — not a regression.

**Status: nothing is parked.** Staff access scoped to league membership
(`32edd7a`) and per-league naming for the calendar and CSV exports (`8100662`)
shipped in PR #13. The three items that sat open under it — no CI, no
`typecheck` script, no audit entry for `saveRules` — shipped in
`feat/ci-and-rules-audit`. Migrations 0029–0032 are applied to
`bipxqfszjwncjquymhon` and verified: all four in the **Remote** column of `npx
supabase migration list --linked`, and `0032`'s backfill confirmed by
`/<league>/people` listing all three staff profiles for a manager on
`obhl.vercel.app`, which resolves only through `shares_league_with()`.

## Next action

Nothing in this file's scope is outstanding. The per-league work shipped, and
so did CI, the `typecheck` script and the `saveRules` audit entry.

**Outstanding work now lives in `LAUNCH_READINESS_HANDOFF.md`.** That file is
the one to read first; this one is background for its item 3.

⚠️ **This paragraph used to describe what was open there, and every one of those
had closed by 2026-09-06** — the two production doors (items 1 and 2), the false
claims in `LAUNCH.md`, and the audit-log gaps in `people.ts` / `seasons.ts` /
`announcements.ts`. A pointer that names its target's contents goes stale on
someone else's commit, so this one no longer tries: **read the items table and
_Open — waiting on a person_ there for the current list.**

## What CI runs

`.github/workflows/ci.yml`, on every PR and every push to `main`, in two jobs:

- **check** — `npm run typecheck`, then `npm test`. No database, no browser.
- **e2e** — `npx supabase start`, an `.env.local` written from `supabase status
-o env`, then `npm run test:e2e`. Playwright's `globalSetup` resets and seeds
  the database and `playwright.config.ts` starts the dev server, so the job
  only has to supply Supabase and the env file.

Two things about that job are load-bearing and easy to undo:

- **`.env.local`, not job-level `env:`.** Three separate things read it —
  `playwright.config.ts` through dotenv, `next dev`, and
  `scripts/seed-users.mjs` through `--env-file-if-exists`. Exporting the
  variables into the job environment feeds the first two and not the third.
- **`ENABLE_DEV_LOGIN` is deliberately unset.** The suite signs in through the
  dev panel, which `devLoginEnabled()` turns on for any non-production build.
  Setting it in CI would work and would add one more place to forget it.

Two settings exist because CI runs cold and on slower hardware than a laptop:

- **`playwright.config.ts` waits 120s for the dev server**, not 30s. A cold
  boot with no `.next` cache measured ~9s locally; a 2-core runner is several
  times that, which was near the old limit. It costs nothing when the server is
  quick.
- **`vitest.config.ts` reads `OBHL_SLOT_BUDGET_MS` / `OBHL_SLOT_RESTARTS` from
  the environment**, defaulting to the values that have always run locally. The
  schedule tests bound _quality_ (`slotWeekdaySpread <= 8` and friends), and
  those bounds are only reachable if enough restarts fit in the budget — so on
  slower hardware the lever is to **raise the budget, never to loosen an
  assertion**. Nothing sets these in CI today; the first runs decide whether
  anything needs to.

`npm run typecheck` is `tsc --noEmit && tsc --noEmit -p e2e/tsconfig.json`. The
second half is the point: `next build` does not typecheck test files, and
`e2e/tsconfig.json` is the CommonJS resolution Playwright actually runs them
under, which the root config does not reproduce.

## `saveRules` writes an audit entry — and the trap under it

`saveRules` (`src/lib/actions/rules.ts`) now logs `save_rules` against
`entity_type: "league_rules"`, carrying the replaced document in `old_data`.
`league_rules` still keeps no history of its own, so that entry is the only
copy of the previous rules after an overwrite; it is `await`ed rather than
`void`ed for that reason, matching `remove_schedule` in
`src/lib/actions/schedule.ts`.

Two conditions gate the write, both on purpose. The upsert `.select("id")`s and
the entry is written only if a **row comes back**, not merely if `error` is
unset. ⚠️ **Measured, this one is defence in depth and not an observed bug.**
This paragraph used to say a policy-level refusal here need not set `error`;
issuing exactly this upsert from a session that fails the policy raises `new row
violates row-level security policy for table "league_rules"` — on both the
insert and the `ON CONFLICT DO UPDATE` path — so `saved === null && error ===
null` is not a state this call reaches. The _Traps_ entry it pointed at is about
a refused `UPDATE`, which filters rows rather than raising; an upsert is not
that case. The branch is worth keeping; the claim under it was wrong.
And the write is skipped when the document is **unchanged**, compared with a
key-sorted serialisation: `previous.content` arrives from a `jsonb` column,
which normalises key order, so a plain `JSON.stringify` comparison would call
every save a change and quietly do nothing.

**Known limitation — the read and the write are not atomic.** `saveRules` reads
the previous document, then upserts. Two managers saving the same league's
rules concurrently both read the same `previous`, so one entry's `old_data`
names a document it did not actually overwrite. _This is a reading of the code;
it has not been reproduced._ Left alone deliberately: closing it means making
read-and-replace atomic, which realistically means a plpgsql function and a
migration, and this area is not worth a migration for an unmeasured race on a
page edited a few times a season. Revisit if rules editing ever becomes
concurrent.

**The trap it sat behind, which is still armed for the next entity type:**
`leagueOfEntity` in `src/lib/audit.ts` switches on `entity_type`. A type it
does not handle returns `null`, and a null league is filtered out of every
league-scoped view _and_ hidden by RLS (`manages_league(null)` is false). So
adding a `logAudit` call alone writes an entry that is **correct and never
appears**. Add the type to that switch in the same change; the per-entity
resolvers are in `src/lib/league/of-entity.ts`.

`e2e/10-rules.spec.ts` guards exactly this: it saves rules and then asserts the
entry is visible on `/obhl/audit`, which reads with `.eq("league_id",
…)`. Watched fail with the `"league_rules"` case removed from the switch —
the save still succeeded and the entry still landed; it was simply invisible.

Both `old_data` and `new_data` carry the **whole Tiptap document**, not a
summary — a summary would not make an overwrite recoverable, which is the
entire point. That is a bigger audit payload than any other action writes, and
the audit page selects `old_data, new_data` for up to 500 rows. Accepted
because rules are saved a handful of times a season, not per game; if
`save_rules` ever becomes frequent, drop `new_data` first — the current
document is always readable from `league_rules` itself.

Not done, and a reasonable next step: `save_rules` is not revertible.
`old_data` holds what a revert would need, but `revertAuditEntries`
(`src/lib/actions/audit.ts`) has no case for it, and `isRevertible` in the
audit page returns false, so the UI does not offer it.

## Already decided — do not re-file

**The password actions have no league, and that is not a hole** (added
2026-09-06, #36). `auth.ts` now exports `sendPasswordReset`, `updateOwnPassword`
and `signInWithPassword`, all three listed in `league-guards.test.ts`'s
`NO_LEAGUE_ACTIONS`. Sign-in happens before any league is known, and
`updateOwnPassword` writes through the CALLER's own session via
`auth.updateUser` — not the admin client — so the session IS the authorisation
and there is no league or role to check. ⚠️ The same reasoning does NOT extend to
`office.ts:setStaffPassword`, which writes somebody else's credential on the
admin client and is guarded by `requireCommissioner`; the office test in that
file still forces it. **`/set-password` is deliberately not a manage page**: it
lives at the app root, outside `[league]/(manage)`, so the manage-page guard
sweep does not cover it and should not — a session with no `profiles` row and no
role must be able to set a password.

**#38's five schedule actions needed no entry here, and the reason is the
sweep** (verified 2026-09-06 at `c87764e`). `rescheduleNight`,
`previewOneOffGame`, `applyOneOffGame`, `previewScheduleRepair` and
`applyScheduleRepair` all resolve their season through
`targetSeasonForManager` (`src/lib/actions/schedule.ts:93`), which guards with
`requireLeagueManager(() => leagueOfSeason(seasonId, admin))` — the league comes
from the SEASON, never from caller input, so a hand-made request naming another
league's season is refused rather than obeyed. ⚠️ **`league-guards.test.ts` is a
`readdirSync` sweep over `src/lib/actions`, not a list**, so a newly exported
action is covered the moment it exists and an author who adds one has nothing to
remember. That is the design: `NO_LEAGUE_ACTIONS` is an *exemption* list, and the
only way to fall out of coverage is to be added to it deliberately.
⛔ **The null-league audit trap is NOT triggered by these** — each files
`entity_type: "season"`, and `leagueOfEntity` (`src/lib/audit.ts:56`) has a
`case "season"`, so `league_id` resolves and the entries appear in the league's
own audit view. Checked, not assumed; the trap in _Traps_ is about the types that
have no case.

**`previewEsportsdeskImport` is not an SSRF** (closed 2026-09-01). It never
fetches the pasted string; it regexes two numeric ids out of it and fetches a
hardcoded esportsdesk host with one of four literal paths. It reads like SSRF
at a glance, which is presumably how it was filed originally — the reasoning is
in `src/lib/import/esportsdesk.ts`.

## Traps this area sets

Each of these cost a review round or a wrong fix in the session that built it.

- **A ROLE-ONLY GUARD ON A PAGE IS NORMALLY A BUG — `/manage/leagues/new` IS THE
  EXCEPTION, AND IT IS THE ONLY ONE.** Added 2026-09-08. Creating a league is the
  single act with no league to be a member of yet, so that page guards with
  `requireManager()` while every page under `[league]/(manage)` must not.
  ⛔ **The route is what makes it legal, not a judgement call.**
  `src/lib/actions/league-guards.test.ts` asserts that no page in that tree uses
  a role-only guard, so moving this file back under `[league]` turns the unit
  suite red — which is the intended outcome, not an obstacle to route around.
  There are now three pages outside the manage-page sweep, each for a different
  reason: `/set-password` (below — no role yet), `/manage/office` (instance-wide
  tier, guarded by `requireOfficeMember`), and this one. ⚠️ Do not "restore
  coverage" by pointing `MANAGE_DIR` at `src/app/manage/` — both of its rules
  ("must call a league guard", "must not use a role-only guard") are wrong for a
  page belonging to no league, and it would fail all three.

- **THE CHROME IS NOT A GUARD, and since 2026-09-06 it is not even a hint.**
  PR #39 (`9d57fbe`) deleted the separate manager chrome: there is one header for
  the whole site, and staff get a row of links beneath it
  (`src/components/shared/staff-links.tsx`, formerly `components/manage/manage-nav.tsx`).
  Which links a viewer sees is decided by MEMBERSHIP, in a component — it says
  nothing about what the server will allow. Every page under `[league]/(manage)`
  still calls its own `requireLeagueManager` / `requireLeagueRole`, and the route
  group's layout still has `if (!user) redirect("/login")`. ⚠️ Removing a link
  removes nothing: the URL still resolves and the guard is the only thing between
  it and the data. When #39 landed, all 11 manage pages were audited individually
  to confirm exactly that, and `e2e/27-one-chrome.spec.ts` asserts a page which
  left the nav is still refused by its own guard.

- **⛔ RLS CANNOT RESTRICT COLUMNS. CLOSED BY `0046`, AND THE SHAPE IS WORTH
  KNOWING BEFORE YOU WRITE ANOTHER POLICY.** `0032`'s `"scorekeeper update games"` is `for update` over the
  whole `games` row. It was written when a scorekeeper legitimately cancelled
  and postponed games, so "may update this row" and "may do the things we mean"
  were the same sentence. They stopped being the same on 2026-09-07, when the
  user's rule became scorekeepers "can only score games" and
  `feat/manual-schedule-edits` moved `cancelGame`, `postponeGame`,
  `restoreGame` and `rescheduleGame` to manager-only. **The action guards are now
  the only thing standing there.** A scorekeeper's own session, with the
  publishable key, still writes `status`, `scheduled_at`, `home_team_id` and
  `away_team_id` directly — measured, not reasoned: `e2e/30-schedule-edits.spec.ts`
  carries a `test.fixme` that cancels a published game and gets no error back.
  ⚠️ **A tighter `with check` CANNOT fix this**, which is why the fix is a
  trigger: a policy sees only NEW, and telling "a scorekeeper edited the goals"
  from "a scorekeeper moved the game" needs OLD as well.

  **`0046_schedule_columns_are_managers_only.sql` closes it.** A `before update`
  row trigger refuses a non-manager who changes `scheduled_at`, either team id,
  `is_draft`, `season_id`, `postponed_from`, or who moves `status` into or out of
  the scoring lifecycle (`scheduled` / `in_progress` / `final`). Scoring is
  untouched: finalize and reopen stay inside that set. `service_role` and
  `postgres` pass through — the admin client's authorisation is the guards in
  `src/lib/auth`, not this trigger.

  ✅ It also closed a second door nobody had looked at: `postpone_game` and
  `restore_game` (`0025`) are `security invoker` and granted to `authenticated`,
  so a scorekeeper could call them directly for the same result. Because they run
  as the caller, their UPDATE lands in the trigger like any other.

  ⚠️ **The test that proves it is control-verified, and the first attempt at that
  control was WRONG.** Dropping the trigger and re-running the e2e showed the
  test still passing — because `global-setup` resets the database on every run
  and re-applied the migration first. The valid control talks to PostgREST
  directly with no reset in the loop: with the trigger the update is refused,
  without it the game is cancelled. If you ever need to re-verify this, do not
  do it through the e2e harness.

- **Every export of a `"use server"` file is a callable endpoint.** "Internal
  helper" in a doc comment is not a boundary. `finalizeGameById` /
  `reopenGameById` were two unguarded ones taking the audit actor as a
  parameter; they now live in `src/lib/games/finalize.ts`, a plain module.
- **`logAudit` writes on the admin client, past RLS, with whatever entity id it
  is handed.** Guarding an action's _table_ writes is therefore not enough — an
  unguarded id reaching `logAudit` files a real-looking entry into another
  league's audit log. This bit twice, most recently in `setDefaultGoalie`,
  where guarding the id only on the branch that wrote it left the audit write
  uncovered. Guard every id an action names.
- **An RLS-refused `UPDATE` is not an error** — it matches no rows and returns
  `error: null`, so `check()` does not catch it.
- **Every id an action writes with must resolve to the SAME league**
  (`requireLeagueManagerOf`). Separate per-id membership checks both pass for
  someone who manages both leagues while binding one league's team into the
  other's season.
- **`canManageLeague` and `canScoreLeague` are QUESTIONS, NOT GUARDS**, and they
  read exactly like guards at a call site. They return a boolean and refuse
  nobody. They exist because the manage pages merged into the public ones: a
  page that everybody may open has to _ask_ whether this viewer gets the editing
  surface, where the old `/manage/…` page could simply refuse at the top. The
  refusal still has to happen somewhere, and that somewhere is the server action
  — `src/lib/actions/*` guards itself, as it always did, plus RLS beneath. ⛔ Do
  not read "the page checks `canManageLeague`" as "this write is guarded"; the
  page check decides what is _drawn_. A control that is not drawn is not a
  control that cannot be submitted.
- **A page shared between the public and the staff has two audiences and one
  render.** Radix unmounts inactive tab content on the client, but the server
  renders every branch it is handed — so a staff-only panel behind a tab still
  runs its queries and ships its data to whoever opened the page. Gate on the
  entitlement, not on a tab.

## Testing this area

The suite signs in as `manager@obhl.test`, who belongs to every league — so a
membership check and no check behave identically. Two seeded accounts break
that symmetry: `single-league-lead@` (manager) and `single-league-scorer@`
(scorekeeper), each confined to one league, each with a dev-login button.

- **Nothing outside the fixture layer names a league.**
  `scripts/seed-users.mjs` decides which league each is confined to;
  `e2e/16-league-membership.spec.ts` derives "a league you are in" and "one you
  are not" in a `beforeAll`, and fails loudly if that shape drifts.
- **Seed addresses must not contain another account's address as a substring.**
  `obhl-scorekeeper@` did, and silently broke two People & Roles tests that
  locate a row by `hasText: "scorekeeper@obhl.test"`.
- **To reach a server action with another league's id**, rewrite a form's
  hidden input and submit — no hand-made POST or action id needed. Two rules,
  both learned by watching these tests pass against deliberately broken guards:
  wait for the POST before asserting (a DB read fired after `click()` races the
  action and reads "nothing written yet"), and assert the refusal
  (`toHaveURL("/")`, which _waits_) rather than only the absence.
- **Confirm every new guard fails without itself.** 25 mutations were run this
  way — 17 app-layer, 4 policy-level, 4 action-level — each knocked out with
  the matching test watched go red. Twice this caught a test that proved
  nothing.

## Provenance

Both parked pieces came out of the per-league routing project (PR #12,
`32e77c7`) and were built on 2026-09-01 in PR #13; CI, the `typecheck` script
and the `saveRules` audit entry followed in `feat/ci-and-rules-audit`. The full
routing design, including alternatives rejected, is
`docs/superpowers/specs/2026-08-31-per-league-routing-design.md` — open it only
if you need _why_ beyond what is inlined here. Operational launch steps are in
`LAUNCH.md`.
