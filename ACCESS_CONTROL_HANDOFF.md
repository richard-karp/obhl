# Per-league access control — shipped; the database is deployed, #13 is not

**Protocol — read this and nothing else to resume.**

1. This file is self-contained. Do **not** read
   `docs/superpowers/specs/2026-08-31-per-league-routing-design.md` (383 lines)
   or PR #13's description — what still binds is inlined below.
2. ⛔ **Hazards, before any instruction:**
   - `npx supabase db reset --linked` **wipes production**. Use `db push`.
   - **`ENABLE_DEV_LOGIN=true` is live on production.** Anyone can take a
     manager session on the public site until it is removed — see *Next action*.
   - **Until #13 merges, `0032` and this file exist only on
     `feat/per-league-access-control`.** `migration list` shows `0032` with an
     empty **Local** column when `main` is checked out, and a `supabase db
     reset` run there builds a database with no `profile_leagues`.
   - Do not change the `app_role` enum or the JWT hook (`0010_auth_hook.sql`).
     The model is membership-only *so that* both stay untouched; changing the
     hook also means re-enabling it by hand in the Supabase dashboard.
3. Numbers here were **watched appear**. Where a claim is a reading of the code
   rather than a measurement, it says so in those words.
4. Verify with `npm test && npm run test:e2e`. Baseline on this branch:
   **250 unit passed; 117 e2e passed, 1 skipped, 0 failed** (re-run
   2026-09-01, unchanged). The skip is the AI-summary test, gated on an API
   key — not a regression.

**Status: both parked pieces are built, committed and pushed** — staff access
scoped to league membership (`32edd7a`) and per-league naming for the calendar
and CSV exports (`8100662`). PR #13 (`feat/per-league-access-control`) is open
against `main` and mergeable. The database half is deployed; the code is not.

## Next action — two commands, neither runnable by an agent

`gh` and `vercel env` are both denied by the auto-mode classifier, so a human
runs these. Order does not matter; both are outstanding as of 2026-09-01.

    gh pr merge 13 --merge
    vercel env rm ENABLE_DEV_LOGIN production && vercel --prod

Nothing gates the merge. 0029–0032 are applied to `bipxqfszjwncjquymhon` and
verified: all four in the **Remote** column of `npx supabase migration list
--linked`, and `0032`'s backfill confirmed working — `/manage/people` lists all
three staff profiles for a manager on `obhl.vercel.app`, which resolves only
through `shares_league_with()`. They were pushed **from this branch**; the same
command run from `main` would have applied three and skipped the backfill.

**After merging, this section is stale** — replace it with whatever is next.

## Open, in priority order

| # | Item | Where |
|---|---|---|
| 1 | No CI runs the tests — no `.github` directory at all; the only PR checks are Vercel's deploy and preview comments | — |
| 2 | `npm run build` does not typecheck test files; `tsc --noEmit -p e2e/tsconfig.json` is run by hand. A `"typecheck"` script closes it | `EXPORTS_HANDOFF` §5.1 |
| 3 | `saveRules` writes no audit entry | below |

`ENABLE_DEV_LOGIN` was item 4, now a *Next action* — a live auth bypass, not
backlog. **Item 5 closed 2026-09-01: `previewEsportsdeskImport` is not an
SSRF.** It never fetches the pasted string; it regexes two numeric ids out of
it and fetches a hardcoded esportsdesk host with one of four literal paths.
It reads like SSRF at a glance, which is presumably how it was filed originally
— the reasoning is in `src/lib/import/esportsdesk.ts`; do not re-file it.

## `saveRules` leaves no audit trail

Measured 2026-09-01 — `grep -c 'logAudit({' src/lib/actions/*.ts`, summed:
**14** call sites, and `src/lib/actions/rules.ts` contributes **zero**. (An
earlier note said 16; this session moved two into `src/lib/games/finalize.ts`.
Regenerate rather than quoting either figure.) It is the only manage action
that records nothing, and `league_rules` (`0006_rules.sql`)
keeps no history, so an overwrite is unrecoverable. Commit `e0fd273` fixed the
half where it wrote to the *wrong league*; traceability is still open.

**The trap:** `leagueOfEntity` in `src/lib/audit.ts` switches on `entity_type`
and handles exactly four — `team`, `season`, `game`, `team_player` — returning
`null` otherwise. A null-league entry is filtered out of every league-scoped
view *and* hidden by RLS (`manages_league(null)` is false). So adding
`logAudit({ entity_type: "league_rules", … })` alone writes an entry that is
correct and **never appears**. Add the type to that switch in the same change;
its per-entity resolvers are in `src/lib/league/of-entity.ts`.

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
`32e77c7`) and were built on 2026-09-01 in PR #13. The full routing design,
including alternatives rejected, is
`docs/superpowers/specs/2026-08-31-per-league-routing-design.md` — open it only
if you need *why* beyond what is inlined here. Operational launch steps are in
`LAUNCH.md`.
