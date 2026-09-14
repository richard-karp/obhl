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

- ⛔ **A test config may raise a timeout, never set a constant that shapes a
  search, a budget or a result.** `vitest.config.ts` pinned
  `OBHL_SLOT_RESTARTS=2000` while production ran 20,000: the clustering tests
  passed at 2,000 and failed at 20,000, and the league got 14 -> 13 instead of
  14 -> 4. Never delete `runs Phase S at the production default, not a test-only
  one` in `assignNights.test.ts`.
- ⛔ **e2e resets the one shared local database, so always run
  `PORT=<port> scripts/e2e-locked.sh <files>`.** Every worktree shares one
  Supabase and `e2e/global-setup.ts` resets it, so overlapping runs wipe each
  other's fixtures; the script takes a lock. Give each worktree its own `PORT`,
  or `reuseExistingServer` drives another branch's server (`lsof -ti:$PORT`
  before trusting a red run). Name full files, never a glob.
- ⛔ **CI runs the full e2e suite split across two machines; the spec lists are
  the `e2e` matrix in `.github/workflows/ci.yml`.** A new spec must go in exactly
  one list, or it silently stops running. `14-schedule-changes` must not run
  before `05-scoring-night` on one database, and a spec that reads another's data
  goes on that spec's machine.
- CI tests the merge with `main`, not the branch: a green run on a stale base
  proves nothing.

## Access control

**Model.** `profiles.role` (`app_role`) says what someone is; `profile_leagues`
says where. Every guard takes the league from the URL or from the entity being
written and checks membership, not only the role. Captains reach only their
team's games. ⛔ Don't change the `app_role` enum or the JWT hook (`0010`): the
model is membership-only so both stay untouched, and a changed hook must be
re-enabled by hand in the dashboard.

**League Office (`0034`).** `league_office` holds `commissioner` and `deputy`
tiers, which widen reach across leagues and add no powers; none outranks another.
Only a `league_manager` may hold one, and the tier comes off before the role can
change. The table is granted to nobody, so the first commissioner is inserted in
SQL. An Office member can change a manager's role in `/<league>/people`; another
manager cannot. `setStaffPassword` requires `requireCommissioner`.

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
- A shared public/staff page renders every branch on the server: gate staff data
  on the entitlement, not a tab. Header staff links guard nothing.
- Every export of a `"use server"` file is a callable endpoint; helpers go in
  plain modules such as `src/lib/games/finalize.ts`.

**The RLS half.** `0008` public reads, `0009` role writes, `0032` membership,
`0033` profile-write containment, `0042`/`0043` staff reads of a staged league.
⛔ Don't widen the `_is_public` helpers instead: they decide what anonymous
visitors see. `0046` and `0050` are triggers (_Traps_). Decided, don't re-file:
the password actions take no league (the caller's session is the authorisation),
and `previewEsportsdeskImport` is not an SSRF (it fetches a hardcoded host).

### Traps

- ⛔ **An RLS-refused `UPDATE` reports no error.** It matches zero rows with
  `error: null`, so read the row back. Refused inserts and upserts do raise 42501.
- ⛔ **An audit entry filed under a null league is hidden from every view.**
  `leagueOfEntity` (`src/lib/audit.ts`) returns null for an `entity_type` with no
  case, and league views and RLS both drop the entry. Add the case in the same
  change and prove it by removing it. An action that deletes what it logs passes
  `league_id`, resolved before the delete.
- `logAudit` writes on the admin client with any id it is handed: guard every id
  an action names, or the entry lands in another league's log.
- ⛔ **`0050` refuses privileged `profiles` columns.** A browser session
  (`authenticated`, `anon`) cannot set `id`, `role` or `player_id`; without it any
  account could make itself a manager. `SECURITY INVOKER` keeps `current_user` the
  caller. Server writes use the service role; `display_name` stays owner-writable.
- ⛔ **RLS cannot restrict columns, so `0046` is a trigger** (a policy sees only
  `NEW`). It refuses a non-manager changing `scheduled_at`, a team, `is_draft`,
  `season_id`, `postponed_from`, `label` or `division_id`, or moving `status`
  into or out of the scoring lifecycle. A new schedule column goes in it too.

### Scorekeeper day rule

A scorekeeper may open only games whose **league-local** date is today, enforced
in `src/app/[league]/(manage)/games/[gameId]/score/page.tsx` and listed at
`/tonight`. The check (`isOnLeagueDate`, `leagueToday` in `src/lib/format.ts`)
must stay in the league zone: the 9:40pm Eastern slot is tomorrow in UTC.

⛔ **It has no RLS half, on purpose.** `0032`'s `"scorekeeper update games"` is
date-blind, `0046` limits columns rather than games, and `scorekeeper@` is a
shared login. All accepted; tightening it takes a policy on `games` and
`game_rosters`, not a guard.

⛔ **Only the page checks the date.** `finalizeGame`, `bumpStat` and `setLineup`
don't, so a submit at 00:01 succeeds and the re-render refuses the game. Sign-out
at day rollover and _Closing the night_ cover that; don't add a grace period
without deciding what both should then do.

### Closing the night

`vercel.json` calls `/api/cron/close-night` at `0 6 * * *` UTC (1am EST, 2am
EDT; Hobby fires within that hour, never early). It finalizes every game still
`in_progress` after its day through `finalizeGameById`, the one definition of
"complete", with a `null` audit actor. ⛔ Never `scheduled` games: finalizing one
nobody scored invents a 0-0 result.

⛔ **The route must pass the admin client to `finalizeGameById`.** A cron request
has no cookie, so the default client is `anon`: the `UPDATE` matches nothing with
no error, `logAudit` still files `finalize_game`, and `game_rosters` reads empty
for a non-final game, so the score recomputes as 0-0. Fixing only the `UPDATE`
turns a no-op into data loss.

⚠️ **`CRON_SECRET` gates the route and fails closed:** unset means a silent daily
401 and games that never close. Set it in Vercel (`.env*` is gitignored, so an
example file reaches nobody). Locally `playwright.config.ts` gives the dev server
`e2e-cron-secret`; a server started without it answers 401. Test:
`PORT=<port> scripts/e2e-locked.sh e2e/05-scoring-night.spec.ts -g "Closing the night"`.

A night that failed to close appears in one place: the manager dashboard's
**Games still open** card (`openPastGames`), listing past games still `scheduled`
or `in_progress`.

### Legacy redirects

⛔ **Check a new `/manage/<x>` page's second segment against `next.config.ts`.**
Redirects run before the filesystem and `:league` matches any first segment,
`manage` included, so `/:league/score`, `/:league/rosters` and `/:league/import`
capture `/manage/score`, `/manage/rosters` and `/manage/import` (the last would
loop). A new top-level route also needs its name reserved as a league slug: a
migration plus `src/lib/league/reserved-slugs.ts`, as `0047` and `0048` did.

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

**Restarts and budget.** Phase S runs `SLOT_CANDIDATES` (five weights; 160 must
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
  (`WD_SPLIT_W`, anti-periodicity); build a compound pass that holds meeting
  counts. Add or drop Phase S candidates rather than re-tune one weight.
- ⛔ **Assert a schedule claim from the persisted `scheduledAt`, not the report.**
  A pass that rewrote only `nightIndex` kept 364 tests green and shipped nothing.
- A Phase M change re-rolls Phase S's input: check `SLOT_CANDIDATES` covers it
  before calling an ice-time regression a defect.
- `MULT_W` and `SPACING_W` are coupled, untested, to `oneOff.ts`'s `nightPenalty`.

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
  (null when postponed), not its night's date. `Slot.at` places a game;
  `game.scheduledAt` is written. Conflate them and a cleared date comes back,
  leaving a row both scheduled and postponed.
- ⛔ `expectScheduledAt: r.scheduledAt!` holds only through a chain: placed by
  `postponed_from`, so the night locks, so `checkOneOffWrite` refuses it. Clear
  `postponed_from` and a null reaches a `WHERE`.
- If postponing stops clearing the date, `isExportableFixture` must withhold
  `postponed` too.

**The `?team=` filter.** Both season exports, `/api/schedule/[seasonId]` (`.ics`)
and `.../schedule.csv`, take `?team=<slug>`, resolved by `getEnrolledTeamBySlug`.
- ⛔ **An unresolved slug is a 404, never "no filter"**, or a caller who asked for
  one team silently gets all. Test `=== null` (a bare `?team=` is `""`).
- A filtered file names its team (`exportFilename`, the calendar name); without
  that it is indistinguishable from the full file.
- CSV fields opening with a formula character get a `'` prefix (`escapeField`):
  team names come from a scraped page.

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
- ⛔ **The tonight rounds are a shared, consumable fixture:** the only games ever
  today, so the only ones a scorekeeper can open. Finalizing, cancelling or
  postponing one removes it for every later spec. Find a scoresheet by
  `a[href$="/score"]`, not the "Score" label; never assert a count of tonight's
  games; restore anything you cancel or postpone in a `finally`.
- ⛔ **The Sharks are 5–0 at home**, and a team filter is an OR over home and
  away, so a Sharks test exercises one branch. Use `ducks` (2/3) or `wolves`
  (3/2) and assert the team as both home and away, for standings, stats and
  feeds too.
- **Accounts** (password `hockey123`, committed). `manager@` is in every league,
  so a membership check needs `single-league-lead@` or `single-league-scorer@`;
  `commissioner@`/`deputy@` hold Office tiers; `no-league-mgr@` has no role. No
  address may contain another. ⛔ Count `grep -n "email:" scripts/seed-users.mjs`
  rather than trusting a list, and never run `seed:users` against production.

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
Dropping a trigger in the database proves nothing: the next e2e reset restores it.

**RLS refusals are asserted on the row read back through the admin client
(`admin()`)**, never on `error`: a refused UPDATE returns none.

**Cross-league attacks** rewrite a hidden input through `tamper()` (settle, set,
assert `toHaveValue`): a pre-hydration write is undone, and a permitted original
value passes with no attack made. Wait for the POST, assert the refusal
(`toHaveURL("/")`), and keep an own-league positive control.

Keep Playwright's `expect` at 15 s: above the 5 s generator budget, below the
60 s test timeout. On a red CI run, `gh run download` and read `error-context.md`.

## Deploy and operations

### Hazards

- ⛔ **`supabase db reset --linked` wipes production** and re-seeds demo data.
  Use `db push`; `npm run db:reset` is the local one.
- ⛔ **A published season locks when its first game's time passes:**
  `season_is_started` refuses generate, replace and remove for good, and no UI
  undoes it. No UI deletes a league or season either; slugs are permanent URLs.
- ⛔ **Push a migration before merging code that reads it.** A merge deploys in
  seconds; `0049` went up after its merge and every team page and scoresheet
  errored for over 1h40m. Run `migration list --linked`, `db push`, `migration
  list --linked`, then merge; add `--include-all` when a number sorts below the
  latest applied. Code ahead of its migration also makes `getPublishState` lock
  the builder. CI never checks production's schema.
- **Migrations are pushed only by the owner, or by an agent at the owner's
  explicit request.**
- ⛔ **Worktrees lack the Supabase link** (`supabase/.temp/` is gitignored): copy
  `project-ref` and `linked-project.json` in, or re-run `supabase link`. Never
  `--workdir <main checkout>`: it pushes `main`'s migrations and skips yours.
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
shared with people you trust; never production, never CI. It has been absent from
every Vercel environment since 2026-09-04. Seeded accounts on a hosted database
are a way in regardless: their password is in git and the password grant takes
the anon key.

### Production reads

`npx supabase db query --linked "<sql>"` answers read-only questions and
`npx supabase migration list --linked` shows schema state; re-run rather than
quote. `public.season_is_started(<season id>)` says whether a season is locked;
`audit_log` rows with a null `league_id` are the null-league trap firing.

### Open ops items

From the owner's ops list, 2026-09-13; none is verified from a checkout.
- **Domain renewal:** turn on auto-renew for `lccalumnihockey.ca` (registered
  2026-09-07), and give two managers passwords in case email fails.
- **The `next` security upgrade:** 16.2.7 → 16.3.5 (`npm audit` reports critical
  and high advisories); turn on Dependabot security updates.
- **Backups:** the Supabase plan and its backups are unknown.
- **Node 22 end of life:** 2027-04-30 (`.nvmrc`, `engines`).
- **`CRON_SECRET`:** whether it is set in Vercel production is unverified.
- **Password hardening:** `secure_password_change` and the password-changed email
  are off (read 2026-09-07); turning them on is untested and may refuse old
  sessions at `/set-password`. Password sign-in has no per-account throttle.
- **Also:** no playoff-creation UI; rosters don't carry forward; no confirm on
  announcement delete or player merge; close PRs #51 and #74; prune ~20 stale
  branches. Public pages return 200 for `notFound()` by decision (issue #30);
  ⛔ don't re-run that issue's experiments.

## Importer

`/manage/leagues/new` imports **rosters only** (one esportsdesk league's teams and
players) into a new **public** league, first season inactive
(`src/lib/actions/import.ts`, parser `src/lib/import/esportsdesk.ts`).

- ⚠️ **Its unit tests stub the network and the database, so they cannot see
  esportsdesk change its markup.** `import.test.ts` covers the clean redirect, a
  `teams.insert` failure reported as a shortfall, and a failed membership grant;
  other failure branches are untested. `esportsdesk.test.ts` checks the parser
  against saved HTML. The one real run found loss the stubs missed (unnumbered
  players printed `-` matched nothing): a green suite says nothing about the
  live source.
- ⚠️ **A bad run leaves a public league with no delete UI**; cleanup is SQL.
- The `import_league` audit entry has no test: nothing local can drive the fetch.
