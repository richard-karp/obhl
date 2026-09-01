# Per-league access control — shipped; a deploy and one item still open

**Protocol — read this and nothing else to resume.**

1. This file is self-contained. Do **not** read
   `docs/superpowers/specs/2026-08-31-per-league-routing-design.md` (383 lines)
   or PR #13's description — what still binds is inlined below.
2. ⛔ **Hazards, before any instruction:**
   - **The hosted database is four migrations behind the code.** See *Next
     action*. Merging #13 before applying them locks every manager out of
     every league.
   - `npx supabase db reset --linked` **wipes production**. Use `db push`.
   - Do not change the `app_role` enum or the JWT hook (`0010_auth_hook.sql`).
     The model is membership-only *so that* both stay untouched; changing the
     hook also means re-enabling it by hand in the Supabase dashboard.
3. Numbers here were **watched appear**. Where a claim is a reading of the code
   rather than a measurement, it says so in those words.
4. Verify with `npm test && npm run test:e2e`. Baseline on this branch:
   **250 unit passed; 117 e2e passed, 1 skipped, 0 failed.** The skip is the
   AI-summary test, gated on an API key — not a regression.

**Status: items 1 and 2 are built, committed and pushed.** PR #13
(`feat/per-league-access-control`, commits `32edd7a` + `8100662`) is open
against `main` and mergeable. Nothing has been deployed.

## Next action — apply 0029–0032 to the hosted database

Measured 2026-09-01 with `npx supabase migration list --linked` against
`bipxqfszjwncjquymhon`: remote is at **0028**. Local `0029`, `0030`, `0031`,
`0032` are **not applied**.

Three of those four pre-date this work — they shipped in PR #12, which is
already merged — so `main` is *already* schema-behind-code today, which is the
direction `EXPORTS_HANDOFF` §6 records as the dangerous one. `/manage/audit`
filters on `audit_log.league_id`, a column the hosted database does not have.

    npx supabase db push        # NOT db reset --linked

Expect four migrations applied. `0032` tightens RLS **and** backfills every
existing profile into every existing league in the same transaction; that
backfill is what preserves today's access, so it must land before the code.

*Reading, not measured:* PR #13's Vercel preview built green, and a green
deploy check means it compiled, not that it works. If the preview inherits the
project's env vars it is running this branch against the 0028-era database,
where `profile_leagues` does not exist and every manager is locked out.
`vercel env ls` would settle which database it points at.

## Open, in priority order

| # | Item | Where |
|---|---|---|
| 1 | Apply 0029–0032, then merge #13 | above |
| 2 | No CI runs the tests — no `.github/workflows` at all; the only PR checks are Vercel's deploy and preview comments | — |
| 3 | `npm run build` does not typecheck test files; `tsc --noEmit -p e2e/tsconfig.json` is run by hand. A `"typecheck"` script closes it | `EXPORTS_HANDOFF` §5.1 |
| 4 | `saveRules` writes no audit entry | below |
| 5 | `ENABLE_DEV_LOGIN=true` in a real deploy lets anyone sign in as any role — five one-click accounts now, two of them league-confined | `src/lib/auth/dev-login.ts` |
| 6 | `previewEsportsdeskImport` fetches a user-supplied URL server-side | `src/lib/actions/import.ts` |

## Item 3 — `saveRules` leaves no audit trail

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

Items 1 and 2 were parked out of the per-league routing project (PR #12,
`32e77c7`) and built on 2026-09-01 in PR #13. The full routing design,
including alternatives rejected, is
`docs/superpowers/specs/2026-08-31-per-league-routing-design.md` — open it only
if you need *why* beyond what is inlined here. Operational launch steps are in
`LAUNCH.md`.
