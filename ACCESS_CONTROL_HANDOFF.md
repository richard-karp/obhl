# Per-league access control — shipped; one item still parked beside it

**Protocol — read this and nothing else to resume.**

1. This file is self-contained. Do **not** read
   `docs/superpowers/specs/2026-08-31-per-league-routing-design.md` (383 lines)
   — that project shipped in PR #12, and every decision of its that still binds
   is inlined below.
2. ⛔ **Hazards, before any instruction:**
   - `auth_role()` (`0009_rls_roles.sql:10`) and `is_league_member()`
     (`0032_profile_leagues.sql`) back **every** write policy in the schema. Get
     an edit wrong and you either lock every manager out or expose another
     league's data.
   - Do **not** change the `app_role` enum or the JWT hook (`0010_auth_hook.sql`).
     The model is membership-only *so that* both stay untouched. Changing the
     hook also means re-enabling it in the dashboard.
   - `npx supabase db reset --linked` wipes production. Use `supabase db push`.
     See `LAUNCH.md`.
3. Verify with: `npm test && npm run test:e2e`. Current baseline on `main`:
   **248 unit passed; 114 e2e passed, 1 skipped, 0 failed.** The skip is the
   AI-summary test, gated on an API key — it is not a regression.

**Status: items 1 and 2 are built. Item 3 has not been started.**

## Index

| # | Item | State |
|---|---|---|
| 1 | Per-league membership (`profile_leagues`) | **Done** — `0032`, guards on 14 pages + 11 action files |
| 2 | People & Roles was global and hard-deleted | **Done** — scoped to one league; Remove revokes membership |
| 3 | `saveRules` writes no audit entry | **Open.** ~10 lines + a trap. Unrelated to 1–2 |

---

## Items 1 & 2 — what was built, and what still binds

### The model

- **`profile_leagues(profile_id, league_id)` — membership only.** A role says
  *what* an account may do; membership says *where*. Both must hold. No change
  to the `app_role` enum, no change to the JWT hook, no superadmin tier.
- **Managers grant access only within leagues they are already in.** That is
  what removes the need for a superadmin. Adding an existing manager to your
  league as a manager is the one edit `people.ts` allows on a manager account —
  it grants membership without touching their profile.
- **`players` stays globally writable**, and its RLS policy is deliberately the
  one role-keyed policy 0032 left alone. A person is one human across leagues;
  scoping rides on `team_players`.
- **A person may be manager *and* captain.** The two couplings that prevented it
  are undone: `people.ts` no longer nulls `player_id` for a non-captain role,
  and the captain UI (dashboard, scoresheet) derives from the player link rather
  than `role === "captain"`.
- **Every id an action writes with must name the SAME league** — that is what
  `requireLeagueManagerOf` is for, and single-id writes use
  `requireLeagueManager`. Checking each id's league separately is not enough: a
  person who manages both leagues passes two independent membership checks while
  binding one league's team into the other league's season. Two roster actions
  shipped with exactly that hole and were caught in review.
- **Remove takes someone out of a league; it never deletes an account**, and it
  refuses only one thing: removing *yourself*. That single rule is also what
  stops a league reaching zero managers — the caller is always a manager and a
  member, so a different manager of that league means there are at least two,
  and a league's only manager is always the person looking at the page. A
  manager's *role* still cannot be changed here.

### Both halves are enforced, and they are independent

- **App guards** (`requireLeagueManager` / `requireLeagueManagerOf` /
  `requireLeagueRole` in `src/lib/auth/guards.ts`) gate the UI and every server
  action. Actions hold an entity id and no league, so they derive one through
  `src/lib/league/of-entity.ts`; a null league is always a refusal. Pass the
  *lookup*, not its result — `requireLeagueManager(() => leagueOfTeam(id, admin))`
  — so the role check runs before any query.
- **Nothing in `lib/actions` is an internal helper.** Every export of a
  `"use server"` file is a callable endpoint, so a doc comment saying otherwise
  is not a boundary. `finalizeGameById`/`reopenGameById` were two unguarded ones
  and now live in `src/lib/games/finalize.ts`, a plain module; `check` and
  `revalidateAfterScore` are in `src/lib/games/shared.ts` because a
  `"use server"` file cannot export a non-async value at all.
- **RLS** (`0032`) carries the same membership test into the policies, because a
  staff account holds a real Supabase session and can address PostgREST without
  going through a page. Doing only the app half would look finished and fix
  nothing — the actions that write on the **admin client** (seasons, rosters,
  schedule, announcements, people, logos, `generateGameRecap`) are the reverse
  case, where the app guard is the only thing standing there.

### The one thing that would break on a fresh deploy

`0032` backfills every existing profile into every existing league before its
policies tighten — that is today's behaviour written down, and without it
`supabase db push` locks out whoever runs it. Locally the backfill is a no-op
(`db reset` creates leagues before any profile exists), so
`scripts/seed-users.mjs` grants the memberships instead.

### How it is tested, and why the old suite could not do it

The rest of the suite signs in as `manager@obhl.test`, who belongs to every
league — so a guard that checks membership and a guard that checks nothing
behave identically. Two seeded accounts exist purely to break that symmetry:

| Account | Role | Member of |
|---|---|---|
| `single-league-lead@obhl.test` | league_manager | exactly one league |
| `single-league-scorer@obhl.test` | scorekeeper | exactly one *other* league |

Both have a dev-login button (`One-league mgr`, `One-league scorer`).

Two rules about them:

- **Nothing outside the fixture layer names a league.** `scripts/seed-users.mjs`
  decides which league each is confined to; `src/` does not know what leagues
  exist, and neither does the spec — `16-league-membership.spec.ts` derives
  "the league you are in" and "one you are not" from the seeded memberships in
  a `beforeAll`, and a fixture-sanity test fails loudly if that shape drifts.
  Hardcoding the slugs meant that flipping the seed would leave every test
  navigating to a league the account *is* in and expecting a refusal.
- **Their addresses must not contain another account's address as a substring.**
  `obhl-scorekeeper@` did, and it silently broke two People & Roles tests that
  locate a row by `hasText: "scorekeeper@obhl.test"`. `one-league-manager@`
  would have done the same to `manager@obhl.test`.

`e2e/16-league-membership.spec.ts` drives them: the app guards through the
browser, and the RLS half through a signed-in anon-key client talking to
PostgREST directly. `src/lib/actions/league-guards.test.ts` is a convention
guard covering what a browser cannot reach — a server action posted with another
league's id — by failing when any action or manage page falls back to the
role-only guards.

Every one of those guards was confirmed to fail without itself: each was knocked
out in turn and the matching test watched go red (17 app-layer, 4 policy-level,
5 action-level).
**Do the same for anything added here.** A new guard nobody has watched fail is
a guard nobody has tested, and this is the class of bug where the whole suite
stays green.

### Reaching a server action with another league's id

There is a way, and it needs no hand-made POST or action id: a manage form
carries its ids as hidden inputs, so a Playwright test can rewrite one and
submit through the genuine endpoint.

    await form.locator('input[name="team_id"]')
      .evaluate((el, id) => ((el as HTMLInputElement).value = id), foreignId);

Two rules, both learned the hard way when the first version of these tests
passed against a deliberately broken guard:

- **Wait for the POST before asserting.** A DB read fired straight after
  `click()` races the action and reads "nothing written yet", so an
  absence assertion passes whether the guard is there or not. `submitAndSettle`
  in `16-league-membership.spec.ts` waits on the response.
- **Assert the refusal, not only the absence.** `await expect(page).toHaveURL("/")`
  is a *waiting* assertion and fails loudly; "no row was written" is not.

Run these as `Manager`, who belongs to both leagues — that is the case a per-id
membership check cannot catch.

---

## Item 3 — `saveRules` leaves no audit trail

Measured 2026-09-01: `src/lib/actions/rules.ts` contains **zero** `logAudit`
references, against 16 `logAudit({` call sites elsewhere in `src/lib/actions`.
It is the only manage action that records nothing.

That matters because `league_rules` (`0006_rules.sql`) keeps **no history**, so
an overwrite is unrecoverable. Commit `e0fd273` fixed the half where it wrote to
the *wrong league*; the traceability half is still open.

**The trap, and the reason this is written down rather than left as "add a
logAudit call":** `leagueOfEntity` in `src/lib/audit.ts` maps an entity to its
league by switching on `entity_type`, and it handles exactly four — `team`,
`season`, `game`, `team_player` — returning `null` for anything else. An audit
entry with a null `league_id` is filtered out of every league-scoped view by
design, and `manages_league(null)` is false, so RLS hides it too. Adding
`logAudit({ entity_type: "league_rules", … })` on its own therefore produces an
entry that is written, is correct, and **never appears in the audit log**. Add
the new entity type to that switch in the same change; the per-entity resolvers
it delegates to are in `src/lib/league/of-entity.ts`.

---

## Provenance

Items 1 and 2 were parked out of the per-league routing project (PR #12, merged
`32e77c7`) and built on 2026-09-01. The full routing design, including
alternatives considered and rejected, is
`docs/superpowers/specs/2026-08-31-per-league-routing-design.md` — reach for it
only if you need *why* beyond what is inlined above. Operational launch steps
are in `LAUNCH.md`.
