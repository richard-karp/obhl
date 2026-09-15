# OBHL — Recreational Hockey League Management

A website to manage and publicly display one or more recreational hockey leagues:
standings, schedules, player/team stats, team pages, league rules, plus
authenticated tools for staff to set rosters, keep score, build balanced
schedules, and edit rules.

Built with **Next.js 16 (App Router)**, **Tailwind v4 + shadcn/ui**, and
**Supabase** (Postgres + Auth + RLS + Storage).

## Roles

- **League manager** — full control (people, seasons, teams, rosters, schedule, rules, scoring).
- **Captain** — sets their own team's game-day roster.
- **Scorekeeper** — a global role that records goals/penalties and finalizes games.

Sign-in is **staff-only** — there is no public sign-up. A magic link is the
primary way in and the only one that works with no JavaScript; a password is the
fallback, set by the account holder at `/set-password` (emailed link) or by a
commissioner in the League Office. The public site is read-only and needs no
account.

## Local development

Prerequisites: **Node 22** (pinned in `.nvmrc` and declared as `engines` in
`package.json`; CI reads the same file), **Docker** (for the local Supabase stack).

```bash
npm install
npx supabase start          # starts the local Postgres/Auth/Storage stack
npm run db:reset            # applies migrations + seed.sql
npm run seed:users          # creates the seeded staff accounts (admin API)
npm run gen-types           # regenerate src/lib/db/types.ts (after schema changes)
npm run dev                 # http://localhost:3000
```

### Seeded accounts (local)

Easiest in dev: the **Dev quick sign-in** panel on `/login` has one-click
buttons for each role (local-only — hidden when `NODE_ENV=production`).
Otherwise sign in with a magic link; the email lands in **Mailpit**
(`http://localhost:54324`).

| Email | Role |
|---|---|
| `manager@obhl.test` | League manager |
| `scorekeeper@obhl.test` | Scorekeeper |
| `captain@obhl.test` | Captain (Oceanview Sharks) |

(Local-only: the seed also sets the password `hockey123`, used by the dev
quick sign-in and scripted testing.)

The seed creates **two public leagues** — Oceanview (`obhl`) and Harbor Rec
(`harbor`) — so the header **league switcher** is live, and two people
(e.g. the Sharks captain) skate in both leagues to exercise shared player
identity.

## Scripts

| Script | Purpose |
|---|---|
| `npm run dev` / `build` / `start` | Next.js dev / production build / serve |
| `npm test` | Vitest unit tests |
| `npm run db:reset` | Drop + re-apply all migrations and `seed.sql` |
| `npm run seed:users` | Create/sync the staff accounts via the admin API |
| `npm run gen-types` | Generate DB types from the local schema |

## Architecture

- **Pages/components never call Supabase directly** — reads go through
  `src/lib/queries/*`, writes through `src/lib/actions/*` (server actions).
- **Standings/stats are SQL views** (`supabase/migrations/0007_views.sql`); the
  ordered standings table (incl. head-to-head) is computed in
  `src/lib/standings/tiebreakers.ts`.
- **The schedule builder** is pure logic in `src/lib/schedule/` (circle-method
  round-robin + greedy night/slot assignment), unit-tested without a database.
  Mid-season edits — move a night, pin a team, repair around it — run the same
  engine and write through the `apply_game_writes` RPC (`0045`), one transaction
  per batch. The pre-flight around it (`gameWrites.ts`) is pure functions, so it
  stays unit-testable the same way.
- **RLS** enforces all access: public read in `0008_rls_public.sql`, role/write
  policies in `0009_rls_roles.sql`, and a custom access-token hook
  (`0010_auth_hook.sql`) injects the role into the JWT for UI gating.

Deploying and operating: see RUNBOOK.md → Deploy and operations.
