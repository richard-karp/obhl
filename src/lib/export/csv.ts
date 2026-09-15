import { leagueDateKey, formatGameTime } from "@/lib/format";

export type CsvGame = {
  scheduled_at: string | null;
  home: string;
  away: string;
};

/** Leading characters that make Excel and Sheets evaluate a cell as a formula. */
const FORMULA_LEAD = /^[=+\-@\t\r]/;

/**
 * RFC 4180 quoting, plus a leading `'` inside the quotes on anything a spreadsheet would run:
 * quotes are stripped before a cell is evaluated, and scraped team names are untrusted.
 */
function escapeField(value: string): string {
  const safe = FORMULA_LEAD.test(value) ? `'${value}` : value;
  return /[",\r\n]/.test(safe) ? `"${safe.replaceAll('"', '""')}"` : safe;
}

/**
 * Undated games keep a row with empty cells. The caller withholds statuses whose date is untrue;
 * a non-null `scheduled_at` must parse, or `leagueDateKey` raises rather than hiding bad data.
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
