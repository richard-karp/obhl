# Launching into production

A one-time runbook for taking this from a local database to two live leagues.
Written to be worked through in order — several steps fail *silently* if done in
the wrong order, and three of them cannot be undone.

Read the hazards first. Everything else is a checklist.

---

## Hazards

**1. `supabase db reset --linked` wipes the production database.** It also
re-seeds the demo data unless you pass `--no-seed` (`supabase/config.toml`
enables `[db.seed]`). Use **`supabase db push`** to apply migrations — it applies
what is pending and destroys nothing. `db reset --linked` is only for starting
completely over, and even then it does **not** delete `auth.users`.

**2. A published season locks once its first game night passes.** Then
`season_is_started` (`supabase/migrations/0026_replace_published_schedule.sql`)
permanently blocks generate, replace and remove for that season. No UI undoes it.
This is the real deadline — everything else can be fixed after launch.

**3. There is no UI to delete a league or a season.** Cleanup is hand-written
SQL. Get the slug right the first time.

---

## Phase 1 — Close the test doors

Do this before the URL is reachable by anyone.

- [ ] **Delete all five seeded accounts** (Dashboard → Authentication → Users):

          manager@obhl.test              scorekeeper@obhl.test
          captain@obhl.test              single-league-lead@obhl.test
          single-league-scorer@obhl.test

      They share the password `hockey123`, committed in
      `scripts/seed-users.mjs`. Supabase's password grant is reachable with the
      anon key, so these are a way in **regardless of any application setting**
      — removing `ENABLE_DEV_LOGIN` below does not close this door. A
      `db reset --linked` does **not** remove them.

      ⚠️ `single-league-lead@` is a **manager**. It and `single-league-scorer@`
      arrived with the per-league membership tests, after this list was first
      written — check for all five, not the three this used to name.
- [ ] **Confirm `ENABLE_DEV_LOGIN` is not set** in the production environment:
      `vercel env ls production`. The one-click role buttons are off in a
      production build unless this is `true` (`src/lib/auth/dev-login.ts`), but
      confirm rather than assume.

## Phase 2 — Configuration

Each of these fails quietly and separately. A sign-in that "does nothing" is
usually one of them.

**Vercel environment variables**

| Variable | Notes |
|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | Production project URL |
| `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | Anon/publishable key |
| `SUPABASE_SECRET_KEY` | Server-only, bypasses RLS. Never expose to the client |
| `NEXT_PUBLIC_SITE_URL` | Real domain. Magic-link redirects are built from it (`src/lib/actions/auth.ts`); it defaults to `localhost:3000` |
| `NEXT_PUBLIC_SITE_TITLE` | Optional. Landing page heading and tab title |
| `NEXT_PUBLIC_SITE_SUBTITLE` | Optional. Landing page subtitle |

Both `NEXT_PUBLIC_SITE_*` values are read at build time, so changing one needs a
redeploy.

**Supabase dashboard**

- [ ] **Site URL and redirect allow-list** include the production domain, or
      `/auth/confirm` rejects the magic link at the last step.
- [ ] **SMTP configured**, or sign-in emails never arrive. The default sender is
      heavily rate-limited and not suitable for real use.
- [ ] **Custom Access Token hook enabled** — Authentication → Hooks → Customize
      Access Token (JWT) Claims → Postgres function, schema `public`, function
      `custom_access_token_hook`.

⚠️ **The hook stopped being a lockout on 2026-09-05. Check it anyway.** It used
to be one: `getSessionUser` (`src/lib/auth/session.ts`) read the role **only**
from the JWT claim, so with the hook off every signed-in user held `role: null`
and nobody reached the manage tools — while sign-in still appeared to work,
which is what made it confusing. Since #24 the claim is only the fast path: when
it is absent, `roleFromProfile` reads `profiles.role` through the normal RLS
client, memoized with `cache()`. A hook that never fires now costs a round trip
per render instead of locking the league out of its own tools.

⛔ **Two things that fallback does NOT do.**

- It repairs a missing **claim**, not a missing **row**. An account with no
  `profiles` row, or one whose `role` is null, is exactly as locked out as
  before — the fallback has nothing to find.
- A claim that is **present but stale still wins**. The resolution is
  `claimed ?? profileRole`, so changing someone's role while the hook is on has
  no effect until their next sign-in mints a new token.

⛔ **The two settings above this one have no fallback of any kind.** A missing
SMTP config or a missing redirect-allow-list entry breaks sign-in one step
earlier, at the link itself, before any application code runs — and with
dev-login removed and the seeded accounts deleted, either one leaves no way in
but SQL against production.

Verify the function and its grants landed:

```sql
select
  has_function_privilege('supabase_auth_admin',
    'public.custom_access_token_hook(jsonb)', 'execute')      as can_execute,
  has_table_privilege('supabase_auth_admin', 'public.profiles', 'select')
                                                              as can_read_profiles;
```

Both must be `true`. They come from `0010_auth_hook.sql`, so if migrations
applied cleanly they will be.

## Phase 3 — Apply the schema

```bash
supabase link --project-ref <ref>
supabase db push
```

**Do this before creating any league.** Migrations `0029` and `0030` add the
constraints that keep a slug usable — lower-case only, and not one of `api`,
`auth`, `login`, `manage`, `_next`. Create leagues first and nothing checks you:
a league slugged `Harbor` is unreachable at every URL, with no error anywhere,
because lookup lower-cases the URL and nothing lower-cased the stored value.

## Phase 4 — The first manager

Chicken-and-egg: People & Roles requires already being a manager, so the first
one is manual.

1. Dashboard → Authentication → Users → add your email.
2. Give it the role:

```sql
insert into profiles (id, role, display_name)
values ('<auth user id>', 'league_manager', 'Your Name')
on conflict (id) do update set role = 'league_manager';
```

3. Sign out, sign in via magic link, and confirm the manage nav shows the
   **Manager** badge.
   ⚠️ If the badge is missing, re-read the hook note in Phase 2 before touching
   anything. A token carrying **no** role claim now resolves from `profiles` on
   the very next request, so that case needs no re-sign-in at all. A token
   carrying a **stale** claim is not repaired by the fallback, and only a fresh
   sign-in replaces it.

Everyone else is created from `/<league>/people`. Note it **sends no
email**: the account is created without a password, so tell the person to go to
`/login` and request a link themselves.

## Phase 5 — Leagues and data

All hand-written SQL. Slugs are permanent public identifiers — renaming a league
breaks every link already shared, so treat a change as a migration, not an edit.

```sql
-- League. Lower-case slug; not api/auth/login/manage/_next.
insert into leagues (name, slug, is_public)
values ('Oceanview Beer Hockey League', 'obhl', true)
returning id;

-- Season. Only one per league may be active.
insert into seasons (league_id, name, starts_on, ends_on, is_active, point_system)
values ('<league id>', 'Fall 2026', date '2026-09-15', date '2026-12-20', true,
        '{"win":2,"tie":1,"loss":0}'::jsonb)
returning id;

-- Teams, then enrolment in the season.
insert into teams (league_id, name, slug, color)
values ('<league id>', 'Sharks', 'sharks', '#0ea5e9')
returning id;

insert into season_teams (season_id, team_id)
values ('<season id>', '<team id>');

-- Players are global people; rosters are season-scoped.
insert into players (first_name, last_name) values ('Alex', 'Chen') returning id;

insert into team_players
  (season_id, team_id, player_id, jersey_number, position, is_captain)
values ('<season id>', '<team id>', '<player id>', 9, 'F', true);
```

`position` is one of `F`, `D`, `G`. Set goalies correctly — goalie stats depend
on it.

**Staging a league privately.** Create it with `is_public = false` and it is
manageable at its ordinary URLs while 404ing for the public. **Its own staff can
see it**: migrations 0042 and 0043 expose a non-public league and its content to
anyone with a `profile_leagues` row for it, so scorekeepers and captains can
work in a staged league rather than getting a 404 on the league they are
staffing. Everyone else still gets nothing. Flip `is_public` to `true` to go
live.

⚠️ This changed. Before 0042 the manager policy was the only way in, and this
paragraph used to say scorekeepers and captains could not see a staged league at
all. If you are reading an older copy of that sentence somewhere, it is stale.

## Phase 6 — Schedules

This is the step with the deadline. Build and publish each season's schedule from
`/<league>/schedule-builder` (or a season's setup page) **before its first
game night**. See `SCHEDULE_HANDOFF.md` for what the generator balances and why.

Once the first published game's date passes, that season's schedule is locked for
good.

---

## Verification

Against the live site, signed in as manager:

1. `/` lists both leagues; each links to its own.
2. `/<league-a>/standings` and `/<league-b>/standings` show different tables.
3. An unknown slug 404s.
4. Sign out, sign in by magic link → lands on `/`, and the manage nav shows your
   role badge.
5. The league switcher in the manage header moves between leagues.
6. Post an announcement in one league; it appears on that league's home page and
   not the other's.
7. `/api/schedule/team/<team id>/feed.ics` resolves.

---

## Known limits at launch

Not defects to fix before going live — things to know while handing out accounts.

**Staff access is scoped to league membership.** `profile_leagues` decides which
leagues an account can reach, and every manage guard resolves the league from the
URL and checks membership — not the role alone. Concretely:

- **Captains** derive their surface from `team_players` → season → league, so a
  captain only ever sees their own team's games.
- **A scorekeeper** can score only in the leagues they belong to.
- **A second manager** has full access to the leagues they belong to, and no
  visibility into the others.

So a scorekeeper or a second manager is a supported thing to hand out, not a
reason to stay the sole manager. `ACCESS_CONTROL_HANDOFF.md` has the model and
the traps.

**People & Roles is league-scoped.** `/<league>/people` lists that
league's staff only, and **Remove** revokes that one membership rather than
deleting the account — the account, its role, its player link and its other
leagues all survive, so it is reversible. Two rules there are worth knowing
before you hand out accounts:

- **You cannot remove yourself.** That one rule is also what stops a league
  reaching zero managers, so there is no separate "last manager" check.
- **A manager's role cannot be changed from this page at all** — not yours, not
  anyone's (`updateStaffRole` refuses any account whose role is
  `league_manager`). Demoting a manager is hand-written SQL against
  `profiles.role`.

**One timezone for the whole instance.** `LEAGUE_TZ` in `src/lib/format.ts` is
module-level, so both leagues share it.
