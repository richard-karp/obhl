# OBHL schedule exports — CSV, calendar feeds, and postponement

Written 2026-07-29, after the work landed on `main` (`7275303`). This is what a
person picking the area up needs that the code doesn't say for itself.

It started as one question — "is the schedule exportable as .csv/.xlsx/.ics?" —
and turned up three pre-existing defects on the way to answering it. All three
are fixed.

---

## 1. Outcome

| | Before | Now |
|---|---|---|
| Season schedule as `.ics` | yes | yes |
| Per-team subscribable `.ics` | yes | yes |
| Season schedule as `.csv` | **no** | **yes** |
| `.xlsx` | no | no, deliberately |
| Cancelled games in calendar feeds | **published as live events** | withheld |
| Postponing a game | **left `scheduled_at` intact**, despite its docstring | clears it into `postponed_from` |
| Goalie-default weekday | **computed in `America/Chicago`** | league zone |
| Endpoints reading `games` | 3 different inline queries, 2 with `any` casts | one read path, typed |

No `.xlsx` and no plans for it: CSV opens in Excel, Sheets and Numbers with no
dependency, and nothing here needs formatting, formulas or multiple tabs.

---

## 2. Architecture

**`src/lib/export/`** — pure serialisation, no Supabase imports.

- `csv.ts` — `buildScheduleCsv(games)`. Four columns, `Date,Time,Home,Away`.
- `ics.ts` — `buildIcs(games, calName)`. Moved here from `src/lib/schedule/`,
  which is the generator's domain and never should have held it.
- `fixtures.ts` — `isExportableFixture(status)`, the single definition of which
  games an export may publish.

**`src/lib/queries/schedule.ts`** — the only place any export reads `games`.
`getSchedule` for season-scoped reads, `getTeamFeedGames` for the team feed.

The team feed needs its own helper because it returns a team's games across
*every* season and `getSchedule` requires a `seasonId`. Don't "simplify" that by
making `seasonId` optional — a caller who then forgets it silently reads the
whole league — and don't season-scope the feed, which would delete past games out
of calendars that already hold them.

**Three routes**, all thin: `[seasonId]/route.ts` (season `.ics`),
`[seasonId]/schedule.csv/route.ts`, `team/[teamId]/feed.ics/route.ts`. Each
validates its id with `isUuid`, fetches through a query helper, filters with
`isExportableFixture`, and hands rows to a builder.

---

## 3. Decisions you can't recover from the code

**Why `isExportableFixture` withholds only `cancelled`.** A cancelled game keeps
its date, so listing it asserts a game happens when it doesn't. A postponed one
no longer has a date to lie about, so the CSV shows it with empty date/time cells
and `buildIcs` drops it like any undated game. If you ever make postponement stop
clearing the date, this rule has to grow `postponed` back.

**Why the rule isn't in `getSchedule`.** The schedule page *needs* cancelled
games — it has a status badge to tell the truth with, and a file doesn't.

**Why the `.ics` feeds drop cancelled games rather than marking them.**
iCalendar can express this: the `ics` package supports `STATUS:CANCELLED`, and
`buildIcs` emits a stable `game-<id>@obhl` UID, so marking would *update* the
event already in a subscriber's calendar where dropping it just makes the entry
vanish. Uniformity across the three exports was chosen over that. It is a
defensible call, not an oversight — revisit it if subscribers complain that games
disappear without explanation.

**Why CSV fields get a `'` prefix.** Not decoration. A field opening with
`=`, `+`, `-`, `@`, tab or CR executes as a formula in Excel and Sheets, and RFC
4180 quoting does *not* prevent it — CSV quotes are stripped before the cell is
interpreted. Team names reach the export unfiltered from `importLeague`, which
parses them out of a scraped third-party page. **Do not remove this**, and if you
add a column, route it through `escapeField` too.

**Why the UTF-8 BOM.** Excel on Windows misreads UTF-8 without it. The cost is
that a programmatic parser sees it on the `Date` header. Audience is people
opening a spreadsheet.

---

## 4. `postponed_from`, and the trap in it

Postponing moves `scheduled_at` into `postponed_from` and nulls the original,
via the `postpone_game` RPC. `restore_game` reverses it. Both are RPCs because
PostgREST cannot express a column-to-column move, and both are idempotent by
`coalesce`. `restore_game` is restricted to `status in ('cancelled','postponed')`
so it can't silently un-finalise a played game.

The date is preserved rather than dropped for three reasons, all of which bite
if you "simplify" it away:

| | Consequence of just clearing it |
|---|---|
| The night | `groupIntoNights` places games by date. A dateless postponed game vanishes from its night, **taking the night's lock with it** — the one-off planner could then re-pair a night it must not touch, and would see it one game short. |
| The date | Status changes are not audited, so the original time would be unrecoverable. |
| Restore | Would leave a `scheduled` game with no date. |

**The trap.** `SeasonNightGame.scheduledAt` holds the game's *own* `scheduled_at`
— null when postponed — and **not** the date its night was derived from. The
one-off repair writes that field straight back to the column
(`src/lib/actions/schedule.ts`). If you ever conflate the two, the repair will
resurrect a date that was cleared on purpose and leave a row claiming both a
schedule and a postponement. `groupIntoNights` keeps them apart deliberately:
`Slot.at` for placement and ordering, `game.scheduledAt` for what gets written.

---

## 5. Deliberately not done

1. **`npm run build` does not typecheck test files.** It passed clean while
   `tsc --noEmit` reported two real errors in a test. A `"typecheck": "tsc
   --noEmit"` script closes it. Smallest item here, and the one that already
   caught a real mistake.
2. **The one-off e2e never exercises locking by status.** Its seeded games are
   all in the past, so every night locks by date. `nights.test.ts` covers the
   rule directly, but the integration path is untested.
3. **Status changes aren't audited.** `setStatus` and both RPCs don't call
   `logAudit`. `postponed_from` makes this moot for the date, not for the status.
4. **Neither RPC checks the row exists.** A bogus id updates zero rows and the
   action reports success. Pre-existing pattern, not new.
5. **Row order in the CSV is inherited, not guaranteed.** Undated games sort last
   only because PostgREST omits the null-ordering clause and Postgres defaults to
   `NULLS LAST`. Cosmetic — spreadsheets sort blanks last anyway — and pinning it
   in the builder would let the CSV diverge from the schedule page, which builds
   its "Date TBD" group from the same query.
6. **`format.ts` is mostly untested** — `leagueWeekday` and `weekdayOf` only.

---

## 6. Gotchas

**Exact time strings in tests are coupled to the ICU build.** `formatGameTime`
emits `8:00 PM` with a plain ASCII space on Node 22.18 / ICU 77; some ICU 72+
builds emit `U+202F` there. A future failure diffing two visually identical
strings has this as its cause.

**The migration backfill has run once, on production, and never on a fresh
database.** A clean `db reset` has no postponed rows to convert. It was verified
by shaping a row like production's, running the `update` verbatim, and rolling
back. If you need to re-verify, that's the recipe.

**Deployment state at time of writing.** `main` and the hosted database
(`bipxqfszjwncjquymhon`) both have migration `0025`. Whether the Vercel app had
picked up `main` was not confirmed — there is no CI workflow or `vercel.json` in
the repo, so the deploy trigger is unknown. Schema-ahead-of-code is harmless in
this direction (the column is simply unused), but postponement won't clear dates
until the app is running `7275303` or later.

**Stacked PRs need their base branch deleted at merge time.** #4/#5/#6 were a
stack; merging #4 while its branch still existed left #5 pointing at it, so #5
and #6 merged into branches that were themselves already merged and then deleted.
GitHub reported them MERGED — correctly, just not into `main` — and the work sat
only in local refs until it was found. Delete each branch as you merge it.

---

## 7. Files

| Path | |
|---|---|
| `src/lib/export/csv.ts` + test | CSV builder, escaping, formula neutralisation |
| `src/lib/export/ics.ts` + test | iCalendar builder; tests are characterisation, written before it moved |
| `src/lib/export/fixtures.ts` + test | `isExportableFixture` |
| `src/lib/schedule/nights.ts` + test | `groupIntoNights` — placement and locking |
| `src/lib/queries/schedule.ts` | the single read path; every team filter guarded by `isUuid` |
| `src/lib/db/uuid.ts` + test | `isUuid` |
| `src/lib/format.ts` + test | league-zone dates, `leagueWeekday`, `weekdayOf` |
| `src/app/api/schedule/**` | the three routes |
| `supabase/migrations/0025_postponed_from.sql` | column, backfill, both RPCs |
| `docs/superpowers/specs/2026-07-28-schedule-csv-export-design.md` | CSV + unification design |
| `docs/superpowers/specs/2026-07-29-postponing-clears-the-date-design.md` | postponement design |
