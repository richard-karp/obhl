# RUNBOOK

## Start here

OBHL is a Next.js 16 + Supabase site for recreational hockey leagues: public
standings, schedules, stats and rules, plus staff tools for rosters, scoring,
schedule building and rules. One instance serves several leagues. Production is
`lccalumnihockey.ca`, with two live leagues.

**Left to do** (2026-09-14):
- **Prove the password-reset email.** Signed out, open
  `https://lccalumnihockey.ca/set-password` and request a reset. Pass: the link
  lands on `/set-password` with a form. Silent failure: it lands on `/` signed
  in, with no form. Until then, a commissioner's `setStaffPassword` is the only
  way to give someone a first password.
- **The owner's ops items:** _Deploy and operations → Open ops items_.
- **Executive's schedule locks** at its first game night, 2026-09-15 23:00 UTC.
  Old Boys is already locked.

| Before you change… | Read |
|---|---|
| a guard, an RLS policy, `src/lib/auth`, audit logging, a new `/manage/` page | Access control |
| `src/lib/schedule/{assignNights,participation,matchups,slots,constraints}.ts` | Schedule generator |
| exports, postponement, the one-off planner or repair, any write to `games` | Schedule edits and exports |
| `supabase/seed.sql`, or any test | Seed and fixtures, Testing |
| a migration, env vars, Vercel or Supabase settings | Deploy and operations |
| `src/lib/import` or `/manage/leagues/new` | Importer |

## Standing gates

- ⛔ **A test config may raise a timeout, never set a search constant:** the suite
  then tests a search production never runs (evidence in `AGENTS.md`).
- ⛔ **e2e resets the one shared local database:** always run
  `PORT=<port> scripts/e2e-locked.sh <files>`; a `PORT` shared with another worktree silently tests its server.
- ⛔ **CI runs the full e2e split across two machines; every spec must be in
  exactly one list in `.github/workflows/ci.yml`,** or it silently stops running.
- `14-schedule-changes` stays off `05-scoring-night`'s machine. CI tests the merge
  with `main`, so a green run on a stale base proves nothing.
- ⛔ **A code comment is at most 2 lines:** the rule and its reason, or a pointer to
  the RUNBOOK section that holds the reasoning. History and narrative go in the commit.

## Access control

**Model.** `profiles.role` (`app_role`) says what someone is; `profile_leagues`
says where. Every guard takes the league from the URL or from the entity being
written and checks membership, not only the role. ⛔ Don't change the `app_role`
enum or the JWT hook (`0010`): a changed hook must be re-enabled by hand.

**League Office (`0034`).** Tiers rank commissioner > deputy > manager, and a
profile is writable only by a strictly higher tier. Commissioners are peer-flat
and appointed in SQL (`league_office` is granted to nobody); a deputy cannot touch
the office. Only a `league_manager` may hold a tier, and it comes off before the
role can change. Managing deputies and `setStaffPassword` need
`requireCommissioner`.

**Guards** (`src/lib/auth/guards.ts`). `requireLeagueManager` and
`requireLeagueRole` guard league actions and pages; `requireLeagueManagerOf`
makes every id an action writes with resolve to the same league. Outside
`[league]/(manage)`: `/manage/leagues/new` uses `requireManager()`, the one legal
role-only page guard because that page has no league; `/manage/office` uses
`requireOfficeMember`; `/set-password` stays open for accounts with no role.
`league-guards.test.ts` scans every action and every `[league]/(manage)` page
(`NO_LEAGUE_ACTIONS` is an exemption list); don't point `MANAGE_DIR` at
`src/app/manage/`.
- ⛔ **`canManageLeague` and `canScoreLeague` are questions, not guards.** They
  decide what a page draws; the server action must still refuse.

**The RLS half.** `0008` public reads, `0009` role writes, `0032` membership,
`0033` profile-write containment, `0042`/`0043` staff reads of a staged league.
⛔ Don't widen the `_is_public` helpers instead: they decide what anonymous
visitors see. `0046` and `0050` are triggers (_Traps_).

### Traps

- ⛔ **An RLS-refused `UPDATE` reports no error.** It matches zero rows with
  `error: null`, so read the row back. Refused inserts and upserts do raise 42501.
- ⛔ **An audit entry filed under a null league is hidden from every view:** give
  `leagueOfEntity` (`src/lib/audit.ts`) a case for every new `entity_type`.
- ⛔ **`0050` refuses privileged `profiles` columns:** a browser session cannot set
  `id`, `role` or `player_id`, or any account could make itself a manager.
- ⛔ **RLS cannot restrict columns, so `0046` is a trigger:** it refuses a
  non-manager moving a game's schedule columns, or its status in or out of scoring.

### Scorekeeper day rule

A scorekeeper may open only games whose **league-local** date is today, enforced
in `src/app/[league]/(manage)/games/[gameId]/score/page.tsx` and listed at
`/tonight`. The check (`isOnLeagueDate`, `leagueToday` in `src/lib/format.ts`)
must stay in the league zone: the 9:40pm Eastern slot is tomorrow in UTC.

⛔ **It has no RLS half, on purpose:** `0032` is date-blind and `0046` limits
columns, not games. Accepted; closing it takes policies on `games` and `game_rosters`, not a guard.

⛔ **Only the page checks the date;** `finalizeGame`, `bumpStat` and `setLineup`
don't. Day-rollover sign-out and _Closing the night_ cover it; add no grace period.

### Closing the night

`vercel.json` calls `/api/cron/close-night` at `0 6 * * *` UTC, past league
midnight in both DST states. It finalizes games still `in_progress` after their
day through `finalizeGameById`, with a `null` audit actor. ⛔ Never `scheduled`
games: finalizing one nobody scored invents a 0-0 result.

⛔ **Pass the admin client to `finalizeGameById`, for every statement:** as `anon` the UPDATE
matches nothing and it throws; privilege only the UPDATE and the empty roster read writes 0-0.

⚠️ **`CRON_SECRET` gates the route and fails closed:** unset, games never close.
Locally `playwright.config.ts` sets it for the dev server. Test:
`PORT=<port> scripts/e2e-locked.sh e2e/05-scoring-night.spec.ts -g "Closing the night"`.

A night that failed to close appears in one place: the manager dashboard's
**Games still open** card (`openPastGames`), listing past `scheduled` or
`in_progress` games.

### Legacy redirects

⛔ **Check a new `/manage/<x>` page against `next.config.ts`:** redirects run first
and `:league` matches `manage`: `score`, `rosters`, `import` (a new page there is silently redirected away).

## Schedule generator

**Priority:** weekday balance > byes > rematch spacing > ice time.

`assignNights` (`src/lib/schedule/assignNights.ts`) runs two planners and keeps
the better by `rankSchedule`: everything placed ▸ adjacent-night byes ▸ weekday ▸
other bye rules ▸ rematch ▸ pairing weekday excess ▸ ice time (adjacent-night
byes above weekday is a league decision). `planByParticipation` runs, in order:

| Phase | File | Decides |
|---|---|---|
| P | `participation.ts` | who plays which night: weekday balance, bye rules (exact branch and bound, 4 s cap) |
| M | `matchups.ts` | who plays whom: opponent balance, rematch spacing |
| S | `slots.ts` | which ice time: season and per-weekday share, three-game runs, repeats |

Weekday balance and every bye rule depend only on who plays which night, so that
matrix is settled exactly before any pairing exists; a search over placed games
made them fight. A night-order pass then reorders whole nights against ice-time
clustering (a constrained season swaps only nights sharing a `nightClass`).
`planByWeeks` covers shapes the participation path declines, such as 12+ teams a
night: keep it. `compareIceOutcome` ranks season share ▸ `slotStreak3` ▸
`slotWeekdaySpread` ▸ `slotConsecutive`; don't swap the middle two.

**Restarts and budget.** Phase S runs `SLOT_CANDIDATES` (five candidates; 160 must
stay), each until `OBHL_SLOT_RESTARTS` restarts (default 1,000) or
`OBHL_SLOT_BUDGET_MS` (default 5,000) is spent, whichever comes first.
- ⛔ **More restarts can return a worse schedule.** On the 6-team reference,
  1,000 gives a worst team of 4; 4,000 and 20,000 give 13. Don't raise it.
- **Output repeats only while every candidate finishes inside the budget.** Once
  the budget ends the search (slow hardware, a big league), the result depends on
  the machine. Assert bounds (`slotWeekdaySpread <= 8`), never exact values; run
  a schedule test three times; on a slow runner raise the budget, never loosen an
  assertion. `vitest.config.ts` keeps production's 5 s budget.

**Variations.** `AssignOptions.seed` picks a variation; `variationsFor` draws 4
seeds up to 80 games, 2 up to 120, 1 above: keyed on game count, never the clock.
The draw is chosen by unmet requests first, then `rankSchedule` with the
clustering terms ahead of `slotConsecutive` (without that, four draws can lose to
one). A tight season has one schedule, and `generateSchedule` says so.

**Manager constraints** (`constraints.ts`, `season_schedule_constraints`) are six
best-effort kinds; games per team, games per night and pair meeting counts never
move.
- ⛔ `byeRuleCost` and `buildMinAdjTable` stay untouched: they are Phase P's
  admissible bound. Forced byes are credited in reporting only.
- ⛔ `slot_bias` must reach `compareIceOutcome`, not only `assignSlots`, or the
  best-of-five choice ignores it.
- ⛔ `planByWeeks` cannot honour constraints. Satisfaction is read from the placed
  games, never from what a phase was asked to do.

**Changing it.**
- ⛔ Never ship a bigger weight that wins by overpowering opponent balance
  (`WD_SPLIT_W`, anti-periodicity); build a compound pass that holds meeting counts.
- ⛔ **Assert a schedule claim from the persisted `scheduledAt`, not the report.**
  A pass that rewrote only `nightIndex` kept 364 tests green and shipped nothing.
- `MULT_W`, `SPACING_W` and `oneOff.ts`'s `CHURN_W` move together;
  `weightCoupling.test.ts` pins their ratios.

## Schedule edits and exports

**The single read path is `src/lib/queries/schedule.ts`.** `getSchedule` requires
a `seasonId` (optional, it would read the whole league); `getTeamFeedGames` spans
every season (season-scoped, it would delete past games from calendars).
`isExportableFixture` (`src/lib/export/fixtures.ts`) withholds only `cancelled`.

**The single write path for a schedule edit.** The seven editing actions in
`actions/schedule.ts` and `actions/schedule-edits.ts` call `writeGames`
(`src/lib/schedule/writeGames.ts`), which calls the `apply_game_writes` RPC
(`0045`): one transaction under `pg_advisory_xact_lock` on the season.
`src/lib/schedule/gameWrites.ts` holds the payloads and the pure pre-flight
(`checkWrites`, `payloadFor`, `resultFrom`).
- ⛔ **An UPDATE by id, never an upsert:** an upsert re-inserts a deleted game as
  a live fixture, since `is_draft` defaults to false.
- Don't copy `0026`'s `season_is_started` gate into it: repair must keep working
  on a started season.

**Publish, replace, remove.** `replace_published_schedule` (`0026`) and
`remove_published_schedule` (`0027`) refuse once `season_is_started` (a published
game with a past time, a non-`scheduled` status, or a score). The `for update`
above each gate stops a game finalized mid-race from being deleted; keep it. No
partial replace and no bulk cancel for a started season, on purpose. A past first
night is refused at generate and warned at publish, against face-off time.

**Postponing.** `postpone_game` moves `scheduled_at` into `postponed_from` and
nulls it; `restore_game` reverses that. The date is kept because
`groupIntoNights` places the game by it (so its night stays locked), status
changes aren't audited, and restore needs it.
- **The trap:** `SeasonNightGame.scheduledAt` is the game's own `scheduled_at`
  (null when postponed), not its night's date; `Slot.at` places, `scheduledAt` is
  written. Conflate them and a row ends up both scheduled and postponed.
- ⛔ `expectScheduledAt: r.scheduledAt!` holds only through a chain: placed by
  `postponed_from`, so the night locks, so `checkOneOffWrite` refuses it. Clear
  `postponed_from` and a null reaches a `WHERE`.
- If postponing stops clearing the date, `isExportableFixture` must withhold
  `postponed` too.

**The `?team=` filter.** Both season exports, `/api/schedule/[seasonId]` (`.ics`)
and `.../schedule.csv`, take `?team=<slug>`, resolved by `getEnrolledTeamBySlug`.
- ⛔ **An unresolved slug is a 404, never "no filter"**, or a caller who asked for
  one team silently gets all. Test `=== null` (a bare `?team=` is `""`).

**404 or 503.** The export routes answer 404 when the league or team lookup is
null (that null already covers "not yours": 0042/0043), and 503 with
`Cache-Control: no-store` when the games read failed: an empty file looks like a
season with no games, and `feed.ics` caches success for an hour.
- ⛔ **Check `readFailed` before `!league`:** when both reads fail, league-first
  reports a 404. A team with no games is still a 200.

**The one-off planner and repair** (`planOneOff`, `planRepair`,
`checkOneOffWrite` in `src/lib/schedule/oneOff.ts`; `/<league>/schedule/one-off`
and `/repair`). A night locks by date or by holding a non-`scheduled` game, and
writes to it are refused. Repair runs Phase S once (a user is waiting) with
`weekdayOfNight`, judges each ice-time metric separately against no repair, and
flags a worse plan with `worseThan` rather than dropping it; don't unify that with
generation's rule. It keeps a `slot_on` pin only while the game still has that ice
time, and ignores bye and play requests.

## Seed and fixtures

`e2e/global-setup.ts` resets and seeds before every e2e run, from
`supabase/seed.sql` and `scripts/seed-users.mjs`.

- **Two leagues.** Oceanview (`obhl`, 6 teams): rounds 1–3 final, 4–5
  `scheduled` in the past, 6 tonight. Harbor Rec (`harbor`, 4 teams): rounds 1–2
  final, 3 `scheduled` in the past, 4 tonight. Two players skate in both. Spring
  2026 is started (locked builder); Fall 2026 must stay future-dated for generate.
- **Past rounds.** Oceanview 4–5 and Harbor 3 are `scheduled` in the past, which
  lets the scoring specs open a game that isn't today.
- ⛔ **The tonight rounds are a shared, consumable fixture** (the only games a
  scorekeeper can open): never assert their count; restore what you cancel or postpone.
- ⛔ **The Sharks are 5–0 at home, so a team-filter test on them checks one branch
  of the home/away OR.** Use `ducks` or `wolves` and assert both positions.
- **Accounts** (password `hockey123`, committed). `manager@` is in every league,
  so a membership check needs `single-league-lead@` or `single-league-scorer@`;
  `commissioner@`/`deputy@` hold Office tiers; `no-league-mgr@` is a manager with
  no league. No address may contain another.
- ⛔ **Count `grep -n "email:" scripts/seed-users.mjs`; a written list goes stale.**
  Never run `seed:users` against production.

## Testing

`npm test` (Vitest), `npm run typecheck` (both tsconfigs; `next build` skips test
files), `npm run lint`. e2e runs only through the locked script.

**Survival rule (part 2).** A test stays only if it is one of:
- (a) the one happy-path smoke of a real flow;
- (b) an access refusal;
- (c) a value assertion on scores, standings, stats or three stars;
- (d) a schedule invariant: every pair plays, no double-booking, per-night sheet
  capacity, weekday balance ≤ 1, or dates moving with nightIndex;
- (e) a named data-integrity trap: postponement date, `checkOneOffWrite`,
  `planRepair`, the audit null-league trap, stale publish, or audit revert.

**No new tests unless absolutely necessary:** at most one, for a security or
integrity trap nothing else covers.

**Every new security test is shown red with its guard loosened**, then restored.
Loosen a policy or trigger through a temporary
`supabase/migrations/0052_tmp_red_proof.sql`, delete it before the green run, and
never commit it (`git status --short supabase/migrations` prints nothing after).

**RLS refusals are asserted on the row read back through the admin client
(`admin()`)**, never on `error`: a refused UPDATE returns none.

Pair every refusal test with a positive control that succeeds, so an empty result
cannot pass vacuously.

## Deploy and operations

### Hazards

- ⛔ **`supabase db reset --linked` wipes production** and re-seeds demo data.
  Use `db push`; `npm run db:reset` is the local one.
- ⛔ **A published season locks when its first game's time passes:**
  `season_is_started` refuses generate, replace and remove for good; no UI undoes it.
- ⛔ **Push a migration before merging code that reads it:** a merge deploys in
  seconds, and `0049` merged first broke every team page for over 1h40m.
- `db push` skips a migration numbered below the latest applied one; pass
  `--include-all`. No UI deletes a league or season; slugs are permanent URLs.
- **Migrations are pushed only by the owner, or by an agent at the owner's
  explicit request.**
- ⛔ **Worktrees lack the Supabase link** (`supabase/.temp/` is gitignored): copy it
  in; never `--workdir <main checkout>`, which pushes `main`'s migrations instead.
- ⛔ A Remote migration with no Local file: look for an uncommitted migration
  before running `migration repair --status reverted`.

### Setting up a hosted instance

1. **Schema:** `npx supabase link --project-ref <ref>`, then
   `npx supabase db push`, before any league exists (slug constraints, mirrored
   in `src/lib/league/reserved-slugs.ts`).
2. **Auth hook:** Authentication → Hooks → Customize Access Token → Postgres,
   `public.custom_access_token_hook`. With it off, roles fall back to
   `profiles.role` per render; that repairs a missing claim, not a missing row,
   and a stale claim wins until the next sign-in.
3. **URLs:** the Site URL and redirect allow-list name the production host and
   `/auth/confirm`. ⛔ Add `https://<host>/auth/confirm?**`: the reset link carries
   `?next=/set-password`, and an unlisted redirect raises no error, silently
   landing on the Site URL with the token spent. Add a preview pattern too.
4. **SMTP** (Resend): `smtp.resend.com`, port 465, username `resend`, the API key
   as password (kept in Supabase, not Vercel), a sender at a verified domain;
   minimum password length 8. ⛔ SMTP and the allow-list have no fallback: with
   dev login off, a miss leaves only SQL.
5. **Vercel environment variables:**

   | Variable | Notes |
   |---|---|
   | `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | project URL and publishable key |
   | `SUPABASE_SECRET_KEY` | server-only; bypasses RLS |
   | `NEXT_PUBLIC_SITE_URL` | Production **and** Preview; email links use it (default `localhost:3000`) |
   | `CRON_SECRET` | required, or games never close |
   | `NEXT_PUBLIC_SITE_TITLE`, `NEXT_PUBLIC_SITE_SUBTITLE` | optional; build-time, so redeploy after a change |
   | `OBHL_SLOT_BUDGET_MS`, `OBHL_SLOT_RESTARTS` | optional; read _Schedule generator_ first |

6. **First manager:** add the user in the dashboard, then upsert their `profiles`
   row with `role = 'league_manager'`. No trigger creates `profiles` rows, and
   deleting an auth user cascades away its role and memberships, so a restore
   also needs a `profile_leagues` row per league.
7. **First commissioner:** in the SQL editor (not PostgREST), insert a
   `league_office` row with `tier = 'commissioner'` for an existing
   `league_manager`'s profile; expect one row back.
8. **League:** import one at `/manage/leagues/new` (_Importer_);
   `is_public = false` stages it, visible to its own staff. Add staff at
   `/<league>/people`: no email is sent, so they request a magic link or a
   commissioner sets a password.
9. **Schedules:** publish each season from `/<league>/seasons/<id>` before its
   first game night.
10. **Custom domain:** add it in Vercel as production, confirm it serves, then
    redirect the `.vercel.app` host to it; a session belongs to one origin.

**Staging** (demo data, dev login): `psql "$DB_URL" -f supabase/seed.sql`, then
`SUPABASE_SECRET_KEY=… NEXT_PUBLIC_SUPABASE_URL=… npm run seed:users`, and set
`ENABLE_DEV_LOGIN=true`.

### `ENABLE_DEV_LOGIN`

The one-click role sign-in (`devLoginEnabled()`, `src/lib/auth/dev-login.ts`) is
on in every non-production build; `ENABLE_DEV_LOGIN=true` turns it on in a
production build too.

⚠️ **While it is set, anyone with the URL can sign in as any role.** Staging only,
never production or CI; absent from every Vercel environment since 2026-09-04.
Seeded accounts on a hosted database are a way in regardless: their password is
in git.

### Production reads

`npx supabase db query --linked "<sql>"` answers read-only questions and
`npx supabase migration list --linked` shows schema state; re-run rather than
quote. `public.season_is_started(<season id>)` says whether a season is locked.

### Open ops items

From the owner's ops list, 2026-09-13; none is verified from a checkout.
- **Domain renewal:** turn on auto-renew for `lccalumnihockey.ca` (registered
  2026-09-07), and give two managers passwords in case email fails.
- **The `next` security upgrade:** 16.2.7 → 16.3.5 (`npm audit` reports critical
  and high advisories); turn on Dependabot security updates.
- **Backups:** the Supabase plan and its backups are unknown.
- **Node 22 end of life:** 2027-04-30 (`.nvmrc`, `engines`).
- **`CRON_SECRET`:** whether it is set in Vercel production is unverified.
- `secure_password_change` is off locally and in production; turning it on is
  untested and may refuse old sessions at `/set-password`.
- Public pages return 200 for `notFound()` by decision (issue #30); ⛔ don't
  re-run that issue's experiments.

## Importer

`/manage/leagues/new` imports **rosters only** (one esportsdesk league's teams and
players) into a new **public** league, first season inactive
(`src/lib/actions/import.ts`, parser `src/lib/import/esportsdesk.ts`).

- ⚠️ **Its unit tests stub the network and the database, so they cannot see a
  markup change;** a green suite says nothing about the live source.
- ⚠️ **A bad run leaves a public league with no delete UI**; cleanup is SQL.
