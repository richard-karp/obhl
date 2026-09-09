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
| `npm test` | Vitest unit tests (tiebreakers, round-robin, night assignment) |
| `npm run db:reset` | Drop + re-apply all migrations and `seed.sql` |
| `npm run seed:users` | Create/sync the staff accounts via the admin API |
| `npm run gen-types` | Generate DB types from the local schema |
| `npm run verify:auth` | Verify the auth hook + per-role RLS write policies |
| `npm run verify:scoring` | Verify score → finalize → standings/stats propagation |

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

## Deploying (hosted Supabase + Vercel)

1. **Create a Supabase project** and link it: `npx supabase link --project-ref <ref>`.
2. **Push the schema**: `npx supabase db push` (applies `supabase/migrations/`).
3. **Enable the auth hook**: in the Supabase dashboard → Authentication → Hooks,
   set the *Custom Access Token* hook to `public.custom_access_token_hook`
   (mirrors `[auth.hook.custom_access_token]` in `config.toml`).
4. **Set the site URL / redirect URLs** in Authentication settings to your
   production domain (e.g. `https://your-app.vercel.app` and `/auth/confirm`).
5. **Deploy to Vercel** with these environment variables:
   - `NEXT_PUBLIC_SUPABASE_URL`
   - `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`
   - `SUPABASE_SECRET_KEY` (server-only)
   - `NEXT_PUBLIC_SITE_URL` (your production URL)
6. **Bootstrap the first manager**: create the user in the Supabase dashboard and
   insert a `profiles` row with `role = 'league_manager'`. This is the only step
   that needs the dashboard — a manager with no league yet can still sign in and
   reach the next one.
7. **Create the first league** in-app at **`/manage/leagues/new`**, which imports
   a league from an esportsdesk URL (rosters only, or a full migration with the
   schedule and results). A signed-in manager also reaches it from the "New
   league" link on the landing page. Until 2026-09-08 this page lived at
   `/<league>/import` and so needed a league to already exist — the first league
   on an instance had to be inserted by hand in SQL. It does not any more.
8. **Add everyone else** from **People & Roles** inside the new league.

### Test / staging deploy (one-click dev login on)

For a still-in-test deploy where you want the seeded demo data and the one-click
quick sign-in available to testers:

- After step 2, seed the demo data + test accounts against the hosted DB:
  `npx supabase db push` already ran the migrations; run `psql "$DB_URL" -f supabase/seed.sql`
  then `SUPABASE_SECRET_KEY=… NEXT_PUBLIC_SUPABASE_URL=… npm run seed:users`.
- Add one more Vercel env var: **`ENABLE_DEV_LOGIN=true`** — this keeps the
  one-click Manager/Scorekeeper/Captain panel on `/login` even though it's a
  production build.

⚠️ While `ENABLE_DEV_LOGIN=true`, **anyone with the URL can sign in as any role**
— only share the link with people you trust. For real production, **remove the
`ENABLE_DEV_LOGIN` var** (and seed real data instead of `seed.sql`).
