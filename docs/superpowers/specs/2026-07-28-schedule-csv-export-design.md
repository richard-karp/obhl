# Schedule CSV export

## Problem

The season schedule can leave the app as a calendar but not as a spreadsheet.
Two `.ics` endpoints exist — `src/app/api/schedule/[seasonId]/route.ts` for a
whole season and `src/app/api/schedule/team/[teamId]/feed.ics/route.ts` for a
subscribable team feed — and both are surfaced in the UI. There is no CSV, no
XLSX, and no spreadsheet dependency anywhere in the project.

A calendar is the wrong tool for the jobs people actually use a schedule file
for: printing a season grid, sorting or filtering it, pasting it into a rink
booking sheet, or handing it to someone who does not want a subscription
cluttering their calendar.

## Goals

1. Download the published season schedule as a CSV from the `/schedule` page.
2. Get the escaping right, so a team name containing a comma or a quote cannot
   corrupt the file.
3. Format dates and times in the league timezone, not UTC.
4. Never state that a game happens on a date it does not. See section 2.

## Non-goals

- **Results.** This is a schedule export. It carries no score, no status, and no
  result type. This is a deliberate divergence from `buildIcs()`
  (`src/lib/schedule/ics.ts:14`), which titles a finished game
  `Away 3–2 Home (Final)`. Because there is no status column, games whose status
  makes their date untrue are excluded rather than shown — see section 2.
- **XLSX.** CSV opens in Excel, Sheets, and Numbers without a new dependency.
  Nothing here needs formatting, formulas, or multiple tabs.
- **Per-team export.** The season file covers it; a reader can filter four
  columns themselves. The per-team `.ics` exists because a *subscription* is
  inherently per-person, which a download is not.
- **Refactoring the `.ics` routes.** See section 6.

---

## 1. The route

`src/app/api/schedule/[seasonId]/schedule.csv/route.ts`, a `GET` handler.

The filename lives in the URL, mirroring the existing `feed.ics`, so the
download is named sensibly even if a proxy strips `Content-Disposition`. A
dotted directory nested under the existing `[seasonId]/route.ts` is valid — the
team feed already relies on the same pattern.

`params` is a `Promise` in this Next version and is awaited, matching both
existing routes. Next 16.2.7 also offers a global `RouteContext<'/path'>` helper
for typed params; this route uses the manual form the codebase already uses,
rather than introducing a second convention for one file.

Route Handlers are uncached by default, which is correct here — a schedule
changes and a download should reflect it. No cache header is set, unlike the
team `.ics` feed which deliberately sets `max-age=3600` for polling calendar
clients.

**Guard.** A `seasonId` that is not a UUID returns `404` with the same shape as
the team route's existing guard. Without it, Postgres rejects the malformed
`.eq()` comparison, `getSchedule` logs and returns `[]`, and the caller
downloads a header-only file that looks like a real but empty season.

**Response headers**

| Header | Value |
|---|---|
| `Content-Type` | `text/csv; charset=utf-8` |
| `Content-Disposition` | `attachment; filename="obhl-schedule.csv"` |

**Access.** Public and unauthenticated, exactly matching the season `.ics` route
it sits beside. Draft games are excluded — see section 2.

## 2. Data source

The route calls the existing read helper `getSchedule(seasonId)`
(`src/lib/queries/schedule.ts:35`) rather than issuing its own query. That
helper already filters `is_draft = false`, orders by `scheduled_at` ascending,
and returns a typed `GameWithTeams[]` — so this route needs none of the
`any` casts the two `.ics` routes carry.

It is called with no options, so it uses the default RLS client. This is
correct for a public endpoint: an admin client would bypass the
`public read games` policy.

Team names map through the same fallback the `.ics` routes use:
`home_team?.name ?? "Home"`, `away_team?.name ?? "Away"`.

**Cancelled and postponed games are filtered out** in the route, before the
rows reach the builder. `postponeGame` and `cancelGame`
(`src/lib/actions/games.ts:450-462`) change only `status`; they leave
`scheduled_at` pointing at the original date, despite `postponeGame`'s docstring
claiming "date TBD until rescheduled". `getSchedule` does not filter on status.
So without this, a four-column file would assert that a postponed game happens
on a date it is not being played, and that a cancelled game happens at all —
the website shows a status badge in both cases, and this file structurally
cannot.

The accepted cost is that the CSV's row count will not match the website's, and
a postponed game disappears rather than announcing itself. `scheduled`,
`in_progress` and `final` are all kept: they occupy or occupied their slot, and
a season schedule omitting played games would be useless.

The filter lives in the route rather than the builder so that `CsvGame` never
has to carry a `status` it only uses to drop rows.

**Undated games.** `scheduled_at` is nullable
(`supabase/migrations/0004_games.sql:9`), but no application path currently
produces a null — the generator, the importer and the one-off planner all write
a date, and `rescheduleGame` returns early on empty input rather than clearing
one. Only direct SQL or seed data reaches that state. The builder handles it
regardless, because `GameWithTeams.scheduled_at` is typed `string | null` and
the code must decide something; it is cheap insurance rather than a case that
will be seen in practice.

Row order is inherited from the query, not guaranteed here — see section 7.

## 3. The builder

`src/lib/schedule/csv.ts`, beside `ics.ts`, pure and free of Supabase imports.

```ts
export type CsvGame = { scheduled_at: string | null; home: string; away: string };
export function buildScheduleCsv(games: CsvGame[]): string;
```

`CsvGame` is a narrow input type owned by this module, so the builder never
depends on the database row shape and stays trivially testable.

**Columns** — exactly four, in this order:

| Column | Source | Undated game |
|---|---|---|
| `Date` | `leagueDateKey(scheduled_at)` → `2026-09-14` | empty |
| `Time` | `formatGameTime(scheduled_at)` → `8:00 PM` | empty |
| `Home` | `home` | unchanged |
| `Away` | `away` | unchanged |

Both formatters come from `src/lib/format.ts` and are anchored to
`LEAGUE_TZ` (`America/New_York`), so a late game stored as the next UTC day
still reports its league-local date. `leagueDateKey` requires a non-null string,
so the null check happens at the call site and yields `""` rather than the
`"TBD"` that `formatGameDate` would produce — an empty cell sorts and filters
correctly in a spreadsheet where the literal `TBD` does not.

**Escaping** — RFC 4180. A field is wrapped in double quotes when it contains a
comma, a double quote, a carriage return, or a line feed; any inner double quote
is doubled. This is the whole reason the builder is a tested unit: a team named
`Steelheads, Jr.` would otherwise shift every subsequent column right.

**Formula neutralisation** — a field beginning `=`, `+`, `-`, `@`, tab or CR is
additionally prefixed with `'`. RFC 4180 quoting does *not* cover this: CSV
quotes are stripped before the cell value is interpreted, so `"=HYPERLINK(…)"`
still executes when the file opens in Excel or Sheets. The marker therefore goes
inside the quoting, as part of the value.

This matters because team names are not all manager-typed. `importLeague`
inserts `t.name` verbatim (`src/lib/actions/import.ts:147`) from a name parsed
out of a scraped third-party page (`src/lib/import/esportsdesk.ts:168`), so
untrusted external content reaches a publicly downloadable spreadsheet. The
`.ics` export shares the data path but not the exposure — iCalendar has no
formula semantics — so this risk is created by adding CSV.

The accepted cost: spreadsheets treat `'` as a literal-text marker and don't
display it, but a programmatic parser sees it in the cell value.

**Framing** — `CRLF` line endings per RFC 4180, a trailing newline after the
final row, and a leading `U+FEFF` byte-order mark.

The BOM is what makes Excel on Windows read the file as UTF-8; without it an
accented or curly-quoted team name is mangled. It is invisible in Excel,
Sheets, and Numbers. The cost is that a naive programmatic parser sees it
attached to the `Date` header — accepted, because the audience for this file is
a person opening a spreadsheet.

An empty season yields BOM + header + `CRLF`.

## 4. UI

One `Button` in the `PageHeader` of `src/app/(public)/schedule/page.tsx`,
beside the existing "Download .ics" button at line 84, labelled
`Download .csv` and matching its `variant="outline" size="sm"` styling.

The page's team filter does **not** affect the download; the button always
exports the full season. A filtered export would make the button's output depend
on invisible page state.

## 5. Testing

`src/lib/schedule/csv.test.ts`, vitest, colocated per the convention every other
module in `src/lib/schedule/` follows. This also makes `csv.ts` the first
module in that directory to ship with tests alongside a sibling that lacks them
— `ics.ts` is currently the only untested file there.

Cases:

1. Empty input yields BOM + header + `CRLF` and nothing else.
2. A dated game yields `2026-09-14,8:00 PM,Ice Hawks,Rivermen`.
3. An undated game yields `,,Northstars,Ice Hawks` — two empty leading cells.
4. A team name containing a comma is wrapped in quotes.
5. A team name containing a double quote has it doubled and the field wrapped.
6. A team name containing a newline is wrapped — otherwise the `\r\n` branch of
   the escape regex is dead code the function claims to support.
7. Rows are `CRLF`-separated with a trailing newline.
8. A timestamp falling on the next UTC day still reports the league-local date.
9. Games in January and July both format to the correct wall-clock time across
   the EST/EDT boundary.

Cases 2 and 9 assert an exact time string, coupling them to the ICU build.
Verified correct on Node 22.18 / ICU 77, which emits a plain ASCII space before
`PM`; some ICU 72+ builds emit `U+202F` there instead. A future failure diffing
two visually identical strings has this as its cause.

The cancelled/postponed filter is route-level and therefore not unit-tested;
it is covered by manual verification.

No e2e test. There is no e2e coverage of the `.ics` downloads in any of the 14
specs, so a CSV e2e would establish a new pattern rather than follow one, and it
would only prove the button is wired — the logic that can actually break is
covered above.

## 6. Decisions taken

- **BOM included**, for Excel on Windows.
- **No e2e test**, per section 5.
- **Cancelled and postponed games excluded**, per section 2.
- **`csv.ts` goes beside `ics.ts`**, even though `src/lib/schedule/` is
  otherwise pure scheduling algorithm and `ics.ts` is already misfiled there.
  Keeping the two export formats together beats either one being in the
  theoretically correct directory; moving both to `src/lib/export/` belongs in
  the follow-up commit below, which has to touch both `.ics` routes anyway.
- **The `.ics` routes are left alone.** Both issue their own inline query with
  `any` casts instead of using `getSchedule`, so after this change three
  endpoints will read the same table three different ways. Unifying them is
  worth doing, but as its own commit — a calendar-feed regression should not be
  able to hide inside a CSV feature.

## 7. Known limitations

**Swallowed query errors.** `getSchedule` logs and returns `[]`
(`src/lib/queries/schedule.ts:51`). A genuine database failure therefore
produces a well-formed CSV containing only a header — indistinguishable from a
season with no games. Fixing this means changing the helper's contract for all
of its callers, which is out of scope here. The UUID guard in section 1 covers
the common cause, a mistyped URL.

**Row order is inherited, not guaranteed.** Undated games sort last only because
PostgREST omits the null-ordering clause when `nullsFirst` is unset, leaving
Postgres's `NULLS LAST` default for `ASC`. Nothing in the CSV path states this
and no unit test can cover it, since the builder preserves input order.
Deliberately left alone: the property is cosmetic, both Excel and Sheets sort
blank cells last regardless of direction, and pinning the order inside the
builder would let the CSV diverge from the `/schedule` page, which builds its
"Date TBD" group from this same query.

**The `.ics` routes have the cancelled/postponed problem this fixes for CSV.**
Both include every non-draft game, so a cancelled game still appears in
subscribed calendars. Worth addressing in the follow-up commit named in
section 6.

**`postponeGame`'s docstring is wrong.** It claims "date TBD until rescheduled"
while the code preserves `scheduled_at` (`src/lib/actions/games.ts:459-462`).
Correcting it means first deciding whether postponing *should* clear the date —
a product question outside this work.
