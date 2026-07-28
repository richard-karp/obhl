import { leagueDateKey, formatGameTime } from "@/lib/format";

export type CsvGame = { scheduled_at: string | null; home: string; away: string };

/** Leading characters that make Excel and Sheets evaluate a cell as a formula. */
const FORMULA_LEAD = /^[=+\-@\t\r]/;

/**
 * RFC 4180 quoting — a field holding a comma, quote, CR or LF is wrapped and its
 * inner quotes doubled — plus a leading `'` on anything a spreadsheet would
 * execute.
 *
 * The `'` is not redundant with the quoting: CSV quotes are stripped before the
 * cell value is interpreted, so `"=HYPERLINK(…)"` still runs. It has to sit
 * inside the quotes to be part of the value. Team names reach this unfiltered
 * from `importLeague`, which parses them out of a scraped third-party page, so
 * they are untrusted input. Spreadsheets read `'` as a literal-text marker and
 * don't display it; a programmatic parser will see it.
 */
function escapeField(value: string): string {
  const safe = FORMULA_LEAD.test(value) ? `'${value}` : value;
  return /[",\r\n]/.test(safe) ? `"${safe.replaceAll('"', '""')}"` : safe;
}

/**
 * A season's fixtures as CSV, dated in the league zone. Undated games keep their
 * row with empty date and time cells — unlike `buildIcs`, which has no way to
 * represent one and drops it.
 *
 * Carries no score and no status: this is a schedule, not a results export. The
 * caller is responsible for withholding games whose status makes their date
 * untrue (cancelled, postponed), since nothing here could show it.
 *
 * A non-null `scheduled_at` must be a parseable timestamp: `leagueDateKey`
 * raises `RangeError` on anything else, deliberately rather than emitting a
 * blank cell that would hide corrupt data. Reading from the `timestamptz`
 * column satisfies this for free.
 */
export function buildScheduleCsv(games: CsvGame[]): string {
  const rows = games.map((g) => [
    g.scheduled_at ? leagueDateKey(g.scheduled_at) : "",
    formatGameTime(g.scheduled_at),
    g.home,
    g.away,
  ]);
  const lines = [["Date", "Time", "Home", "Away"], ...rows].map((r) =>
    r.map(escapeField).join(","),
  );
  // BOM so Excel on Windows reads it as UTF-8; CRLF and a trailing newline per
  // RFC 4180.
  return `﻿${lines.join("\r\n")}\r\n`;
}
