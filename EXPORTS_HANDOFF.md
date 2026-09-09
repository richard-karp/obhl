# OBHL schedule exports — CSV, calendar feeds, and postponement

Written 2026-07-29, after the work landed on `main` (`7275303`). This is what a
person picking the area up needs that the code doesn't say for itself.

Extended 2026-09-09 (#57) for the team-scoped export: the two season exports
now honour the schedule page's team filter, which they had ignored since they
were built. §2 has the parameter and its rules, §3 the decision it reverses,
§6 the seed trap that let the first version of its test pass against a filter
that only worked on half the games.

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
| One team's games from the schedule page | **whole season regardless of the filter** | the selected team only (#57) |
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

**The single write path for a schedule *edit*** is the `apply_game_writes` RPC
(`supabase/migrations/0045_apply_game_writes.sql`), called once from
`src/lib/schedule/writeGames.ts:74`. Not the only code that writes `games` at
all — scoring, the postponement RPCs and `replace_published_schedule` each own
their own — but the only one the editing actions go through. There are **seven**
of those, in two files: `redateDraftSchedule`, `rescheduleNight`,
`applyOneOffGame` and `applyScheduleRepair` in `src/lib/actions/schedule.ts`,
and `exchangeTeams`, `exchangeSlots` and `retimeGame` in
`src/lib/actions/schedule-edits.ts`. `writeGames` also files the audit entry a
failure needs.

`src/lib/schedule/gameWrites.ts` no longer performs the write. It holds the
payload shapes and the pure, unit-tested pre-flight — `checkWrites`,
`payloadFor`, `resultFrom`.

⛔ Still an **UPDATE by id, never an upsert**, and the decision now lives in SQL
rather than TypeScript. An upsert INSERTs when the id is gone, which resurrects
a deleted game as a live fixture — `is_draft` defaults false.

✅ **There IS a transaction now, and this paragraph used to deny it.** `0045`
does the batch as one statement in one transaction under
`pg_advisory_xact_lock` on the season, so the compensation machinery is gone and
with it the `stuck` and `indeterminate` outcomes — `WriteFailure.kind` is now
`"conflict" | "failed"` only, and `gameWrites.ts` asks you not to re-add a
third. The sentence here previously called this
`LAUNCH_READINESS_HANDOFF.md` §5's "first post-launch job"; it shipped in
`d28595a`. ✅ That handoff now agrees — its items table and its §5 section both
read DONE, checked 2026-09-09. ⚠️ They agree only because two documents were
corrected separately, which is the duplication §6 warns about below: if these
two ever disagree again, `src/lib/schedule/writeGames.ts` is the copy that
cannot be stale.

**Three routes**, all thin: `[seasonId]/route.ts` (season `.ics`),
`[seasonId]/schedule.csv/route.ts`, `team/[teamId]/feed.ics/route.ts`. Each
validates its id with `isUuid`, fetches through a query helper, filters with
`isExportableFixture`, and hands rows to a builder.

The two season routes also take an optional `?team=<slug>`, resolved through
`getEnrolledTeamBySlug` — built on `getEnrolledTeams`, so the slugs an export
accepts are exactly the ones the schedule page's filter can offer.
⛔ **A slug that does not resolve is a 404, never "no filter."** Falling back to
the season is the defect the parameter closes: the caller asked for one team and
would silently receive all of them. It covers the cross-league case for free — a
team of another league is not enrolled in this season.

⚠️ **The test is `=== null`, not falsiness, and that is load-bearing.**
`searchParams.get` answers `""` for a bare `?team=` and `null` only when the
parameter is absent, so a truthiness test read an empty one as "no team asked
for" and served the whole season under a 200 — the same failure, reachable by
typing the URL. Nothing this app renders emits `?team=`; the page emits
`?team=<slug>` or no query at all.

`getEnrolledTeams` retries once through `readWithOneRetry` and logs a read that
fails twice. ⚠️ **A 404 from these routes can therefore mean "the read failed",
not only "no such team"** — the return type has no way to say which, and the log
line is what tells them apart afterwards. That 404 is deliberate rather than a
500: it is the same answer `publicLeagueOfSeason` has always given for a failed
read on the same request, and one read of a pair reporting 500 while the other
reports 404 would be worse than either.

---

## 3. Decisions you can't recover from the code

**Why a team-filtered export names the team, and why it may.** Until 2026-09-08
both download buttons pointed at the bare season no matter what the page's team
filter said, on the stated rule that "a filtered export would make the button's
output depend on page state the downloaded file can't show"
(`docs/superpowers/specs/2026-07-28-schedule-csv-export-design.md` §4). The bug
that rule caused was worse than the one it prevented: picking a team and
downloading returned all six teams' games, and the `.ics` dropped a whole season
into a calendar someone had filtered a single team out of.

The objection is answered rather than overruled. A filtered file now says whose
schedule it is with no page present to explain it: `exportFilename` puts the team
in the download name (`obhl-sharks-schedule.csv`), and the `.ics` names the
calendar `<League> — <Team> Schedule`. ⚠️ Remove either and the original
objection is live again — a filtered file indistinguishable from the full one.

⚠️ **A one-time `.ics` download cannot remove events already in a calendar.**
Someone who imported the full season and then imports a team file keeps the other
teams' events: the UIDs are stable (`game-<id>@obhl` — see the note below on why
that matters), so the overlapping events update and the rest simply stay. That is
iCalendar, not this code. The fix stops the *file* carrying games the caller did
not ask for; a calendar already holding them needs those events deleted, or the
calendar re-created from the new file.

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

**Publishing replaces; a started season refuses.** `publishSchedule` calls
`replace_published_schedule`, which deletes the season's live games and promotes
the drafts in one transaction. It refuses once `season_is_started` is true —
defined as any published game having a past `scheduled_at`, a status other than
`scheduled`, or a non-zero score.

Protecting played games is a *consequence* of that gate, not a separate rule: a
single played game flips the season to started and removes the delete path
entirely, so no code walks a set of games deciding which to keep. Don't
"improve" this by adding a partial replace that keeps played games and drops the
rest — that reintroduces exactly the class of bug the gate was written to make
unreachable, and it needs the generator seeded with games-played and home/away
already accrued or the back half of the season won't balance against the front.

That consequence holds only because of the `for update` line above the gate. The
gate and the delete are separate statements, so under READ COMMITTED they see
separate snapshots, and without those row locks a game finalized *between* them
is deleted — the gate reads the pre-finalize snapshot, then the delete
re-evaluates against the new row version and removes it. This was reproduced
before the lock was added, and the lock is the only thing making the guarantee
true rather than merely true-in-sequence. Don't drop it as redundant.

The locks cover games that already exist. A played game *inserted* concurrently
in the same window cannot be locked and would still be deleted. Nothing does
that today — the esportsdesk import writes finals only into a season it creates
itself, and the one-off planner only ever inserts future `scheduled` rows — so
if you add a path that bulk-inserts played games into a live season, this is the
assumption you are breaking.

`game_rosters` cascades on game delete, so a replace also discards lineups a
captain set in advance. Reachable only before the season starts, and the confirm
dialog says so.

**Removing is the same gate without the promotion.** `removeSchedule` calls
`remove_published_schedule` (0027), which deletes the season's live games and
leaves it empty — the case `replace_published_schedule` cannot serve, because it
needs a draft standing ready. It carries 0026's advisory lock and its `for
update` above the gate, and that line is needed here for exactly the same
reason: the hazard is in the gate reading a stale snapshot, not in the promotion
that follows it. Don't drop it on the grounds that this function promotes
nothing. Verified by running the race both ways — with the lock the call blocks
then refuses `started` and the finalized game survives; without it the same race
returns a clean `deleted=1, refused=null` and the game is gone.

Removal is offered in `published` mode only, not `replace`. The RPC filters
`not is_draft`, so a draft survives a removal, and the dialog's "no games until
you generate and publish a new one" would be false in front of a manager who
already has one. If you add removal to replace mode, the copy has to branch.

Its dialog is deliberately shorter than the replace dialog: no game count, no
calendar-feed line. Removal is gated to before the season starts, so nothing has
been played and the games regenerate from the form directly above — only the
cascading lineups are a real loss, so they are the only thing it mentions.

**Why there is no bulk cancel for a started season.** It was designed and
deliberately not built; the spec
(`docs/superpowers/specs/2026-07-30-remove-published-schedule-design.md` §5)
carries the predicate and the reasoning. The short version: schedule work
happens before a season begins, mid-season change is individual games and is
itself rare, and the fallback is cancelling them from the score pages — already
possible, already reversible. Leaving it unbuilt is what keeps the played-game
guarantee above structural: nothing selects which live games to delete.

The builder renders five modes off `publishMode`. The `locked` mode must
suppress the publish control inside the *draft* section too, not just the
generate form — a started season can still hold a stale draft, and that section
renders on draft count alone.

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
one-off repair hands that field down the write path — `payloadFor`
(`src/lib/schedule/gameWrites.ts`) into `writeGames`
(`src/lib/schedule/writeGames.ts`) and on to the `apply_game_writes` RPC. If you ever conflate the two, the repair will
resurrect a date that was cleared on purpose and leave a row claiming both a
schedule and a postponement. `groupIntoNights` keeps them apart deliberately:
`Slot.at` for placement and ordering, `game.scheduledAt` for what gets written.

**Since #38 that preserved date is load-bearing, not merely prudent.** Both
write sites pass `expectScheduledAt: r.scheduledAt!` — a non-null assertion whose
soundness is one chain and nothing else: `groupIntoNights` places a postponed game
by `postponed_from`, so it stays on its night; it locks any night holding a game
whose status is not `scheduled`; and `checkOneOffWrite` refuses a locked night, so
no row for a postponed game ever reaches the writer. ⛔ Clear `postponed_from` and
the FIRST link breaks — the game leaves its night, the night stops being locked,
and the assertion becomes a null in a `WHERE` clause. That is this table's first
row over again, now with a second victim.

---

## 5. Deliberately not done

1. ~~**`npm run build` does not typecheck test files.**~~ ✅ **DONE.**
   `package.json` carries `"typecheck": "tsc --noEmit && tsc --noEmit -p
   e2e/tsconfig.json"`, and `.github/workflows/ci.yml` runs it on every PR
   alongside `npm run lint` and `npm test`. Left in place rather than deleted so
   the list's numbering keeps matching anything that cites it.
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

**Deployment state lives in `ACCESS_CONTROL_HANDOFF.md`**, not here. This
paragraph used to name which migrations the hosted database had, and went stale
— it said `0026` when the answer was `0028`. Two homes for one moving fact is
how that happens; regenerate it with `npx supabase migration list --linked`
rather than quoting either file.

**There IS CI now, and this paragraph used to deny it.** `.github/workflows/ci.yml`
runs two jobs on a PR — `Typecheck and unit tests` (~2m30s) and `End-to-end
tests` (~16m30s) — and Vercel builds a preview deployment alongside them. The
sentence here previously read "there is still no CI workflow or `vercel.json` in
the repo, so nothing runs the tests on a PR"; that stopped being true and nobody
came back to it, which is the same failure mode as the migration list two
paragraphs up. ⚠️ CI tests the MERGE, not the branch, so a green run against a
`main` that has since moved proves nothing — re-check the merge base before
trusting it.

Schema-ahead-of-code is the correct direction and is harmless — the functions
are simply uncalled. The reverse is not. `getPublishState` fails closed on an
RPC error, so code that ships ahead of its migration renders every season as
"This season's games couldn't be read" and locks the builder for every manager.
A PR preview did exactly that, which is how the rule got established: **apply
migrations first, then merge.**

**Stacked PRs need their base branch deleted at merge time.** #4/#5/#6 were a
stack; merging #4 while its branch still existed left #5 pointing at it, so #5
and #6 merged into branches that were themselves already merged and then deleted.
GitHub reported them MERGED — correctly, just not into `main` — and the work sat
only in local refs until it was found. Delete each branch as you merge it.

**The seeded season is lopsided on home/away, and it will pass a broken team
filter.** Every team-scoped read is an OR over two columns
(`home_team_id.eq.<id>,away_team_id.eq.<id>`), and the seeded Oceanview teams
do not split evenly:

| sharks | bisons | bears | hawks | wolves | ducks |
|---|---|---|---|---|---|
| 5 home / 0 away | 0 / 5 | 4 / 1 | 1 / 4 | 3 / 2 | 2 / 3 |

⛔ **A team-filter test written on `sharks` exercises only one branch of that
OR.** The first version of the #57 export test did exactly this: rewriting the
filter to `.eq("home_team_id", …)` returned the identical five rows and the test
stayed green. Use `ducks` or `wolves`, and assert the team appears in BOTH the
home and away positions — a row count alone cannot tell the two branches apart.
This applies to standings, stats and feeds too, not just exports.

**The e2e builder tests depend on a season that hasn't started.** The seeded
active season (`Spring 2026`, May–Jun 2026) is in the past and reads as started,
so it renders the locked panel. `Fall 2026` exists in `supabase/seed.sql` purely
to give the generate/publish flow somewhere to run. If the builder tests start
failing with "Generate schedule not found", check that season's games are still
future-dated — anything that ages them past `now()` locks it.

---

## 7. Files

| Path | |
|---|---|
| `src/lib/export/csv.ts` + test | CSV builder, escaping, formula neutralisation |
| `src/lib/export/ics.ts` + test | iCalendar builder; tests are characterisation, written before it moved |
| `src/lib/export/fixtures.ts` + test | `isExportableFixture` |
| `src/lib/export/filename.ts` | `exportFilename` — the one place the team half of a download name is decided |
| `src/lib/queries/teams.ts` | `getEnrolledTeams` (retrying), `getEnrolledTeamBySlug` — what an export's `?team=` may name |
| `src/lib/schedule/nights.ts` + test | `groupIntoNights` — placement and locking |
| `src/lib/schedule/publishMode.ts` + test | the builder's five modes |
| `src/lib/queries/schedule.ts` | the single read path; every team filter guarded by `isUuid` |
| `src/lib/schedule/gameWrites.ts` + test | the single write path for a schedule edit; UPDATE by id, conditional on expected values |
| `src/lib/db/uuid.ts` + test | `isUuid` |
| `src/lib/format.ts` + test | league-zone dates, `leagueWeekday`, `weekdayOf` |
| `src/app/api/schedule/**` | the three routes |
| `src/components/manage/publish-controls.tsx` | publish / replace, and the confirm dialog |
| `src/components/manage/remove-controls.tsx` | remove, and its (deliberately shorter) confirm dialog |
| `supabase/migrations/0025_postponed_from.sql` | column, backfill, both RPCs |
| `supabase/migrations/0026_replace_published_schedule.sql` | `season_is_started`, `replace_published_schedule` |
| `supabase/migrations/0027_remove_published_schedule.sql` | `remove_published_schedule` |
| `docs/superpowers/specs/2026-07-28-schedule-csv-export-design.md` | CSV + unification design |
| `docs/superpowers/specs/2026-07-29-postponing-clears-the-date-design.md` | postponement design |
| `docs/superpowers/specs/2026-07-30-remove-published-schedule-design.md` | removal design; §5 is the unbuilt bulk cancel |
