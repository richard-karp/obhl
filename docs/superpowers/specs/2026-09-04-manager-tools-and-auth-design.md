# Five changes: schedule constraints, roster editing, team branding, staff auth, season gating

**Protocol — read this and nothing else to start.**

1. This file is self-contained for *what was decided and why*. Its background is
   `SCHEDULE_HANDOFF.md` (§A only), `ACCESS_CONTROL_HANDOFF.md` (§D only) and
   `LAUNCH_READINESS_HANDOFF.md` (§D only). Open one when the section says to,
   not before.
2. ⛔ **Hazards, before any instruction:**
   - `supabase db reset --linked` **wipes production**. Use `db push`.
     `npm run db:reset` is the *local* one and is safe.
   - The `app_role` enum and the JWT hook (`0010_auth_hook.sql`) stay
     **untouched**. §D fixes the role bug on the *read* side deliberately, for
     the reasons in §D.3. Changing the hook also means re-enabling it by hand in
     the Supabase dashboard, which nothing in this design requires.
   - **Migration numbers are pre-assigned** (§F). Two workstreams reaching for
     "the next free number" independently is the one merge conflict that cannot
     be resolved by re-running anything.
   - ⛔ **Run e2e against a dev server belonging to YOUR worktree.** Playwright's
     `reuseExistingServer` takes whichever server is already on port 3000, so a
     suite can silently drive another branch's code. That produced nine phantom
     failures on 2026-09-04. `lsof -ti:3000` before believing a red run.
   - **`npm run test` is wall-clock bounded** in `src/lib/schedule`. One green
     run proves nothing; §A's acceptance bar is three.
3. Claims below are marked. **"Watched"** means it was run and the output read.
   **"A reading"** means it follows from the code and has not been executed.
   Everything in this document is a reading unless it says otherwise — it was
   written before any of the work.

---

## 0 — Why these five together

They are independent in substance and entangled in files. Four of the five are
small; one (§A) is delicate. They are specified together so that the shared
surfaces — ten manage pages, three migrations, one roster editor page — are
divided once, up front, rather than discovered as conflicts. §F is that
division and is the part to read if you are scheduling the work.

---

## A — Schedule constraints

### A.1 What is being added

Six kinds of manager-supplied instruction, per team, per season — three shapes
of bye, plus a forced play night, a pinned ice time, and a windowed slot
preference:

| Kind | `params` | Means |
|---|---|---|
| `bye_on` | `{date}` | This team byes that specific night |
| `bye_in_week` | `{week_of}` | This team byes **one** night that week; the solver picks which |
| `bye_week` | `{week_of}` | This team byes **every** game night that week |
| `play_on` | `{date}` | This team plays that specific night |
| `slot_on` | `{date, time}` | This team takes that ice time (e.g. `"21:30"`) that night |
| `slot_bias` | `{from, to, prefer}` | Over that window, prefer earlier or later slots for this team |

`bye_week` deliberately breaches bye rule 1 ("no two byes in one week"). That is
the request, not a defect; see A.4.

### A.2 The invariants, and why constraints cannot threaten them

Three properties never bend, for any team, constrained or not:

1. **Total games per team.** A team's bye budget is fixed at
   `nights − gamesPerTeam`. A forced bye does not *add* a bye — it **moves**
   one. A forced full week spends 2 of (in the reference season) 12; the other
   10 relocate. Nothing is dropped and nothing is repaid.
2. **Games per night.** Each night's game count is a column total of the
   participation matrix and is already enforced there. Forcing team X off a
   night means another team plays it instead; the night still fills its slots.
3. **Times each pair meets.** The matchup multiset comes from
   `buildBalancedPairings` and Phase M reproduces it exactly or declines
   (`SCHEDULE_HANDOFF.md` §3). Constraints never enter that computation.

**Therefore constraints are pure rearrangements inside the existing feasible
space.** This is the load-bearing observation of §A: it means no structural
relaxation is needed anywhere, and the only thing a constraint can cost is a
soft metric.

### A.3 Where each kind binds

The existing three-phase pipeline already has the seams.

- **`bye_on` / `play_on` / `bye_week` → Phase P** (`solveParticipation`,
  `src/lib/schedule/participation.ts:267`). A new `forced: {team, night, plays}[]`
  option pre-assigns matrix cells before the branch-and-bound. Forced cells
  *shrink* the search tree — a reading, but a firm one: they are eliminated
  variables. `bye_week` expands to one forced cell per game night in that week.
- **`bye_in_week` → Phase P, as a disjunction.** "At least one bye among this
  week's cells" is not a pre-assignment and must be checked in the feasibility
  test rather than folded into the assignment.
- **`slot_on` → Phase S** (`assignSlots`, `src/lib/schedule/slots.ts:213`).
  `SlotOptions` already carries `initial` and `pinned` (`slots.ts:95`), built for
  the one-off repair path. After Phase M resolves who plays whom, a `slot_on`
  constraint resolves to a night index, the game index within it that carries
  this team, and a slot index for the stored time. Those go into `initial` and
  `pinned`, and the night's other games permute around the pin.
- **`slot_bias` → Phase S cost function.** A per-(team, night) slot preference
  term, weighted **below** the existing ice-share and streak goals, so a
  preference can never outrank a guarantee.

### A.4 Keeping everyone else green

The goal is not "all metrics zero" — a constraint may make that arithmetically
impossible. The goal is that **every breach is attributable to a team you
constrained**. Three changes get there:

- `chooseWeekdayByeTargets` (`participation.ts:143`) pins **unconstrained** teams
  to their exact even weekday split and lets a constrained team absorb the
  slack. Today it spreads slack evenly, which would smear one team's request
  across the league.
- `byeRuleCost` (`participation.ts:55`) **excludes breaches involving a
  constraint-forced bye**. Two reasons, and the second is the important one:
  the search should not burn its budget fighting a decision the manager already
  made; and `SCHEDULE_HANDOFF.md`'s zeroed table must keep reading zero, or the
  next person goes hunting for a regression that is actually a request.
- The report carries **per-team** metrics, so a non-zero row is immediately
  attributable: *"1 rule-1 breach — Sharks, requested"*, never a bare
  `byeConsecWeek=1`.

### A.5 Infeasibility is arithmetic, not search

Two failure modes, both refutable before any search runs, both reported rather
than guessed at:

- Constraints demand more byes than a team's budget allows.
- Constraints take more teams off a night than that night can spare
  (`T − 2·n.games` is the exact number of byes a night has to give).

`solveParticipation` already runs `O(teams × weekdays)` arithmetic pre-checks
for exactly this class of refutation; these join them.

### A.6 Best-effort reporting

`BalanceReport` (`assignNights.ts:59`) gains
`constraints: {id, satisfied, reason}[]`. Every constraint appears, satisfied or
not.

⛔ **The fallback planner cannot honour constraints at all.** `planByWeeks`
searches over placed games and has no participation matrix to force. When it
wins the rank-off (`SCHEDULE_HANDOFF.md` §3 lists when the participation path
declines) **every constraint is reported unmet, with that as the reason.** A
generator that silently drops the manager's instructions because an unrelated
planner won is the failure this clause exists to prevent.

### A.7 Storage and UI

Migration **`0039`** — `season_schedule_constraints`: `id`, `season_id`,
`team_id`, `kind`, `params jsonb`, `created_at`. RLS matching the league-scoped
pattern in `0008`/`0009`. `leagueOfEntity` (`src/lib/audit.ts:47`) gains the
`schedule_constraint` case **in the same change** — see the trap in
`LAUNCH_READINESS_HANDOFF.md`: a `logAudit` call added without it writes an
entry that is correct and permanently invisible.

UI: a Constraints card in the schedule builder above Generate; unmet constraints
surface on the preview.

### A.8 Acceptance

- **With no constraints set**, the reference scenario's nine metrics in
  `SCHEDULE_HANDOFF.md` §1 are unchanged, **measured over three runs**. Phase S
  is wall-clock bounded; a single green run is not evidence.
- **With constraints set**, all three invariants of A.2 hold exactly, and every
  unconstrained team still reads zero on every metric.
- Infeasible constraint sets are refused by arithmetic with a specific reason,
  not by timeout.

### A.9 Two things that must not be left to interpretation

Both are the same principle: **store what the manager meant; resolve to solver
indices at generation time.**

- **A week is not a week number.** `ParticipationNight.week` is the generator's
  own numbering, derived from the calendar the form builds out of weekdays and
  skip dates — change either and every index shifts. So `bye_in_week` and
  `bye_week` store `{week_of: <date>}`, any date inside the intended week, and
  resolve to the generator's week when generation runs. A stored week index
  would silently point at a different week after a skip date is added.
- **A slot is not a slot index.** `slot_on` stores the ice time as it is written
  in the form (`"21:30"`), not position 2. Slot times are free text on the
  builder and can be reordered or retimed between runs. The index is derived at
  generation; a time no longer on the card is a reported-unmet constraint, not a
  silent off-by-one.

---

## B — Roster editing

### B.1 Edit in place

New `updateRosterPlayer` (jersey number, position) writing `team_players` —
season-scoped, guarded by `requireLeagueManagerOf` over the season and team, as
`addRosterPlayer` already is.

Name is separate and is **not** season-scoped. `players` is global across
leagues (`0002_core.sql:53`), so `updatePlayerName` changes that person
everywhere they play. That is stated in the confirm copy rather than hidden —
the alternative (per-league name overrides) is a schema change to the identity
model and is rejected in §G.

### B.2 Archive, not delete — and the archive is league-scoped

Migration **`0040`** — a new `player_league_archive (player_id, league_id,
archived_at, archived_by)` table, **not** a global `players.archived_at` column.

The scope is the whole point. `players` is deliberately global so one person can
play in several leagues, and the add-player picker reads it unfiltered
(`rosters/[teamId]/page.tsx`: *"Global people not already on this team's
roster"*). A global flag would therefore make "remove them from **this** league"
also erase them from every other league's picker — silently, and for a person
those other leagues never touched. What was asked for is removal from *the
league*; a league-scoped row is what that means.

So an archived player disappears **in that league only**: from the add-player
picker and the transfer targets in `rosters/[teamId]/page.tsx`, and from the
captain-candidate list on `/manage/people`. That page lists staff *profiles* —
its only player-derived control is a candidate list built from `team_players`
joined to `players` (`people/page.tsx:80-92`), and there is no general player
list there to filter.

Game history is untouched: every stats view keeps crediting what was earned. The
"Show archived" toggle that un-hides and restores lives **on the add-player
picker**, which is the one surface where somebody hunting for a missing person
actually is, and where restoring them is one click from adding them back.

Hard deletion is rejected in §G, as is the global flag.

### B.3 Adding to a team moves them off the old one

`addRosterPlayer` gains a check: does this player already hold an **active**
`team_players` row in the **same season** on another team? If so, route through
the transfer path instead of inserting.

⛔ **Reuse `transferPlayer`'s body; do not write a second one.** That path
(`src/lib/actions/rosters.ts:222`) already handles the soft-departure rules from
`0036`. The naive version — delete the old row, insert a new one — destroys the
old team's goalie record through `v_goalie_stats`' inner join while the games
stay on the schedule, and reports no error. `0036` exists because of that. The
shared body is extracted, not duplicated.

Note the interaction with `0003`'s non-partial `unique (season_id, team_id,
player_id)`: a returning player already has a departed row, which is cleared
rather than inserted over. `addRosterPlayer` already does this; the extracted
helper must keep doing it.

### B.4 Autocomplete picker

The `<select>` in `add-player-form.tsx` becomes a filtered combobox: type, see
matches, pick one. Built on the `Input` and `Popover` primitives already in
`src/components/ui`. **No new dependency** — `cmdk` is not installed (watched),
and adding it for one field is not worth the surface.

### B.5 Acceptance

- A player moved to a new team has exactly one active roster row, and their old
  team's goalie and skater stats for games already played are unchanged.
- An archived player appears in no picker, no roster, and no staff list **in
  the league they were archived from**, still appears normally in every other
  league, and their historical stats pages still render.
- Editing a jersey number does not disturb `game_rosters` history.

---

## C — Team branding

Three small changes, one migration.

- **Colour after creation.** `updateTeamColor` action in
  `src/lib/actions/seasons.ts`; the edit control sits on the season setup page
  (`seasons/[seasonId]/page.tsx`), beside the enrolled-teams list where
  `AddTeamForm` already sets a colour at creation. Editing a team's colour
  belongs next to creating it — and it keeps C off `rosters/[teamId]/page.tsx`
  altogether, which is what lets C run in the first wave rather than queue
  behind B (§F.1, §F.4).
- **Letter contrast.** Migration **`0041`** — `teams.logo_text_color`, a
  two-value check (`'light' | 'dark'`), default `'light'`. `TeamLogo`
  (`src/components/shared/team-logo.tsx`) reads it instead of hardcoding
  `text-white`. A toggle sits beside the colour picker.
- **The underline.** The monogram is a `<span>` inside links carrying
  `hover:underline` (`standings-table.tsx:50` and five siblings), so
  `text-decoration` inherits onto it. Fixed **once**, with `no-underline` on the
  span in `team-logo.tsx`, rather than at six call sites — a reading, and the
  cheapest thing in this document to verify by eye.

---

## D — Staff auth

### D.1 Password sign-in, magic link demoted

`signInWithPassword` action and a password field on `/login`. The magic link
stays as a secondary "email me a link instead" path — it is the recovery route
when a password is forgotten, and removing it would make §D.4 the only way back
in.

⛔ **This lands last, not first.** No existing staff account has a password:
production's were made for magic-link sign-in, and the seeded ones were deleted
on 2026-09-04. A password-primary login page shipped before anybody can *set* a
password locks every real user out. So §D.4 and §D.2's self-serve reset both
precede it, and until they land `/login` defaults to magic link with no password
field shown.

### D.2 Custom SMTP

Supabase's built-in sender is rate-limited and cannot be un-branded; that is the
whole of the reported magic-link problem.

⛔ **This half cannot be done from a checkout.** It is Supabase dashboard
configuration plus `vercel env`, and `LAUNCH_READINESS_HANDOFF.md` records that
mutating `vercel env` is denied to an agent under the auto-mode classifier. The
deliverable from the implementing agent is **written steps and the exact env
keys**, for a human to run. Do not work around the denial.

### D.3 The role bug — the actual fix

`getSessionUser` (`src/lib/auth/session.ts:16`) reads the role **only** from the
JWT `app_metadata.role` claim, with no database fallback. If the
custom-access-token hook did not fire, the account signs in successfully with
`role: null` — present in `profiles` with the right role, refused by every role
guard. That is the reported symptom, and
`LAUNCH_READINESS_HANDOFF.md` independently names it as the standing lockout
risk.

The fix is a `cache()`-wrapped fallback read of `profiles.role` when the claim is
absent. Three constraints on it:

- The claim stays the fast path. The fallback runs only when the claim is
  missing, so the common case costs no extra query.
- `cache()` is not optional. `getSessionUser` is called by several segments per
  render; an uncached fallback multiplies round trips on exactly the sessions
  that are already broken.
- **The JWT hook is not touched.** This is a read-side fix by choice: it repairs
  every already-issued token, needs no dashboard action, and cannot break
  sign-in for accounts that are currently working.

RLS remains the authority for writes, unchanged. This changes which shell and
which actions are *offered*, not what the database will *accept*.

### D.4 Commissioner-set passwords

The League Office gains a set-password control for staff, via the admin API.
This is the no-email recovery path and it is what makes the lockout scenario
survivable without SQL against production. `requireCommissioner` guards it
server-side, in the action itself — not by rendering the button conditionally.
`ACCESS_CONTROL_HANDOFF.md`'s *Traps* section is about exactly that mistake.

### D.5 Acceptance

**D1** — §D.3 and §D.4, the half that gates on nothing:

- An account whose JWT carries no role claim but whose `profiles.role` is
  `league_manager` can reach the manage tools. Probe it by clearing the claim,
  not by trusting the code path.
- A working account's sign-in is unchanged, and `/login` still defaults to magic
  link.
- Every new office action refuses a hand-made POST from a non-commissioner.

**D2** — only once the SMTP work of §D.2 exists:

- A staff member can set their own password from an email that arrives from your
  domain, not Supabase's.
- Only after that does the password field become the primary path, with the
  magic link secondary.

---

## E — Season gating

### E.1 The problem, precisely

Every manage page calls `getActiveContext` (`src/lib/queries/season.ts:35`) and
renders "No active season" when `is_active` is false. Both importers insert
seasons with `is_active: false` (`import.ts:170`, `import-rosters.ts:124`).
So: import a season, its rosters exist, and nothing can edit them. One root
cause, ten pages.

### E.2 The split

`is_active` keeps exactly one job: **what the public site shows.**

A new `getManageContext(slug, seasonId?)` sits alongside `getActiveContext`,
which is unchanged. It resolves the season from a `?season=` param, else a
cookie, else the active season, else the newest. Ten manage pages swap to it:
`dashboard`, `import`, `people`, `people/duplicates`, `rosters`,
`rosters/[teamId]`, `rules/edit`, `schedule-builder`, `schedule-builder/one-off`,
`score`. A season switcher goes in the manage nav.

The nine public pages keep `getActiveContext` and are not touched.

### E.3 Acceptance

- After an import with no active season, that season's rosters are editable.
- The public site shows the active season and nothing else, unchanged.
- Switching season in manage does not change what the public site shows.

---

## F — Order, and the division of shared files

### F.1 Order

**First wave: E, D1 and C, in parallel.**

E edits all ten manage pages, which A and B also edit, so those two wait —
running them concurrently guarantees conflicts on shared files and buys nothing.
But that argument only reaches the workstreams that touch those pages.

**D touches none of them.** It lives in `src/lib/auth/*`, `/login`, and the
office pages under `src/app/manage/office/` — a separate route tree from
`src/app/[league]/manage/`. And D carries the lockout fix (§D.3), so queueing it
behind unrelated work is the one ordering here that costs something real. D
therefore splits: **D1** (§D.3 and §D.4) has no human dependency and ships in the
first wave; **D2** (§D.2's SMTP, the self-serve reset, and §D.1's demotion of the
magic link) waits on a human doing the dashboard work.

**C** owns `team-logo.tsx`, `actions/seasons.ts` and
`seasons/[seasonId]/page.tsx`. The seasons pages already operate per-season, so
none of them are among E's ten and C has nothing to wait for either.

**Second wave: A and B in parallel**, each branched off E.

### F.2 Isolation

Each parallel workstream gets **its own git worktree, its own branch, and its
own dev-server port.** Two reasons, both recorded rather than hypothetical:
other sessions run in this tree, and Playwright's `reuseExistingServer` will
take another branch's server off port 3000 and report its failures as yours.

⛔ **That port is not free.** `playwright.config.ts` hardcodes
`http://localhost:3000` in both `use.baseURL` and `webServer.url`, with no env
var — so "its own port" is unachievable as stated, and if each workstream edits
that file to get one they all collide on it, which is precisely the shared-file
conflict this structure exists to avoid. The config is parameterised on
`process.env.PORT` **once, on `main`, before anything branches**. After that each
worktree exports a distinct `PORT` and no workstream touches the file.

### F.3 Pre-assigned migration numbers

| Workstream | Migration | Table / column |
|---|---|---|
| A | `0039` | `season_schedule_constraints` |
| B | `0040` | `player_league_archive` |
| C | `0041` | `teams.logo_text_color` |
| D | — | none |
| E | — | none |

Nobody takes "the next free number".

### F.4 Overlapping files, and who owns them

| File | Owners | Rule |
|---|---|---|
| `rosters/[teamId]/page.tsx` | B | B alone — C's colour control moved to the season setup page (§C) |
| `seasons/[seasonId]/page.tsx` | C | C alone |
| `src/lib/audit.ts` | A, B | Each adds its own `entity_type` case; the switch is append-only |
| ten manage pages | E | E lands first; A and B rebase onto it |
| `src/components/shared/team-logo.tsx` | C | C alone |
| `src/lib/auth/*` | D1 | D1 alone; D2 takes `/login` and `actions/auth.ts` |
| `playwright.config.ts` | nobody | Parameterised on `main` before any branch (§F.2) |

### F.5 What needs a human, not an agent

- Supabase SMTP configuration and the matching `vercel env` writes (§D.2).
- `supabase db push` of `0039`–`0041` to production.
- Confirming the JWT hook's state in the dashboard, if §D.3's fallback ever
  reads as *always* firing — that would mean the hook is off, which is worth
  knowing even though the fallback makes it survivable.

---

## G — Alternatives considered and rejected

- **Hard-deleting players (§B.2).** Rewrites past seasons' box scores and stats
  silently and is not reversible. Archiving gets the requested outcome — gone
  from every list — without touching history.
- **A global `players.archived_at` flag (§B.2).** One column instead of a whole
  table, but archiving someone in one league would take them out of every other
  league's picker — a silent cross-league effect on people those leagues never
  touched.
- **Per-league name overrides (§B.1).** A schema change to the identity model to
  avoid one sentence of confirm copy. `players` being global is what makes
  cross-league profile reuse work at all.
- **Constraints as soft preferences only (§A).** Cheapest to build and lowest
  risk to solver quality, but "Sharks must bye Nov 12" would quietly not happen,
  which is not what a constraint means.
- **Strictly-hard constraints that refuse to generate (§A.6).** On a tight
  calendar this yields no schedule at all, and the manager cannot tell which
  instruction was the impossible one.
- **Fixing the role bug by changing the JWT hook (§D.3).** Requires a dashboard
  action to re-enable, is listed as a hazard in two handoffs, and does not repair
  already-issued tokens.
- **Auto-activating imported seasons (§E.2).** One-line change, but it publishes
  an unfinished season to the public site the moment it is imported.
