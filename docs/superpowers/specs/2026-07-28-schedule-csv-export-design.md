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

## Non-goals

- **Results.** This is a schedule export. It carries no score, no status, and no
  result type. This is a deliberate divergence from `buildIcs()`
  (`src/lib/schedule/ics.ts:14`), which titles a finished game
  `Away 3–2 Home (Final)`.
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

Postgres sorts `NULL`s last under `ASC`, so undated games appear at the bottom
of the file without any explicit handling.

Team names map through the same fallback the `.ics` routes use:
`home_team?.name ?? "Home"`, `away_team?.name ?? "Away"`.

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
6. Rows are `CRLF`-separated with a trailing newline.
7. A timestamp falling on the next UTC day still reports the league-local date.
8. Games in January and July both format to the correct wall-clock time across
   the EST/EDT boundary.

No e2e test. There is no e2e coverage of the `.ics` downloads in any of the 14
specs, so a CSV e2e would establish a new pattern rather than follow one, and it
would only prove the button is wired — the logic that can actually break is
covered above.

## 6. Decisions taken

- **BOM included**, for Excel on Windows.
- **No e2e test**, per section 5.
- **The `.ics` routes are left alone.** Both issue their own inline query with
  `any` casts instead of using `getSchedule`, so after this change three
  endpoints will read the same table three different ways. Unifying them is
  worth doing, but as its own commit — a calendar-feed regression should not be
  able to hide inside a CSV feature.

## 7. Known limitation

`getSchedule` logs query errors and returns `[]`
(`src/lib/queries/schedule.ts:51`). A genuine database failure therefore
produces a well-formed CSV containing only a header — indistinguishable from a
season with no games. Fixing this means changing the helper's contract for all
of its callers, which is out of scope here. The UUID guard in section 1 covers
the common cause, a mistyped URL.
