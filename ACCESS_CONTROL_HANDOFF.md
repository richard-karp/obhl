# Per-league access control — shipped, with CI and the audit gap closed

**Protocol — read this and nothing else to resume.**

1. This file is self-contained. Do **not** read
   `docs/superpowers/specs/2026-08-31-per-league-routing-design.md` (383 lines)
   or PR #13's description — what still binds is inlined below.
2. ⛔ **Hazards, before any instruction:**
   - `npx supabase db reset --linked` **wipes production**. Use `db push`.
     `npm run db:reset` is the *local* one and is safe.
   - Do not change the `app_role` enum or the JWT hook (`0010_auth_hook.sql`).
     The model is membership-only *so that* both stay untouched; changing the
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
`/manage/people` listing all three staff profiles for a manager on
`obhl.vercel.app`, which resolves only through `shares_league_with()`.

## Next action

Nothing in this file's scope is outstanding. The per-league work shipped, and
so did CI, the `typecheck` script and the `saveRules` audit entry.

**Outstanding work now lives in `LAUNCH_READINESS_HANDOFF.md`** — two open
production doors, three false claims in `LAUNCH.md`, and the audit-log gaps in
`people.ts` / `seasons.ts` / `announcements.ts`. That file is the one to read
first; this one is background for its item 3.

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
  schedule tests bound *quality* (`slotWeekdaySpread <= 8` and friends), and
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
the entry is written only if a **row comes back** — not merely if `error` is
unset, because a policy-level refusal here need not set `error` (see *Traps*).
And it is skipped when the document is **unchanged**, compared with a
key-sorted serialisation: `previous.content` arrives from a `jsonb` column,
which normalises key order, so a plain `JSON.stringify` comparison would call
every save a change and quietly do nothing.

**Known limitation — the read and the write are not atomic.** `saveRules` reads
the previous document, then upserts. Two managers saving the same league's
rules concurrently both read the same `previous`, so one entry's `old_data`
names a document it did not actually overwrite. *This is a reading of the code;
it has not been reproduced.* Left alone deliberately: closing it means making
read-and-replace atomic, which realistically means a plpgsql function and a
migration, and this area is not worth a migration for an unmeasured race on a
page edited a few times a season. Revisit if rules editing ever becomes
concurrent.

**The trap it sat behind, which is still armed for the next entity type:**
`leagueOfEntity` in `src/lib/audit.ts` switches on `entity_type`. A type it
does not handle returns `null`, and a null league is filtered out of every
league-scoped view *and* hidden by RLS (`manages_league(null)` is false). So
adding a `logAudit` call alone writes an entry that is **correct and never
appears**. Add the type to that switch in the same change; the per-entity
resolvers are in `src/lib/league/of-entity.ts`.

`e2e/10-rules.spec.ts` guards exactly this: it saves rules and then asserts the
entry is visible on `/obhl/manage/audit`, which reads with `.eq("league_id",
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

**`previewEsportsdeskImport` is not an SSRF** (closed 2026-09-01). It never
fetches the pasted string; it regexes two numeric ids out of it and fetches a
hardcoded esportsdesk host with one of four literal paths. It reads like SSRF
at a glance, which is presumably how it was filed originally — the reasoning is
in `src/lib/import/esportsdesk.ts`.

## Traps this area sets

Each of these cost a review round or a wrong fix in the session that built it.

- **Every export of a `"use server"` file is a callable endpoint.** "Internal
  helper" in a doc comment is not a boundary. `finalizeGameById` /
  `reopenGameById` were two unguarded ones taking the audit actor as a
  parameter; they now live in `src/lib/games/finalize.ts`, a plain module.
- **`logAudit` writes on the admin client, past RLS, with whatever entity id it
  is handed.** Guarding an action's *table* writes is therefore not enough — an
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
  (`toHaveURL("/")`, which *waits*) rather than only the absence.
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
if you need *why* beyond what is inlined here. Operational launch steps are in
`LAUNCH.md`.
