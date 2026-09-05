/** Date/time formatting for game schedules, anchored to the league timezone. */

// The league plays on US Eastern time. Times are stored as timestamptz and
// formatted in this zone so they read correctly regardless of server timezone.
export const LEAGUE_TZ = "America/New_York";

/**
 * The league zone's UTC offset ("-04:00" in EDT, "-05:00" in EST) for a given
 * calendar date — used when writing a naive wall-clock time as a timestamptz, so
 * games stored across the DST boundary keep the right wall-clock time.
 */
export function leagueOffset(dateISO: string): string {
  const noon = new Date(`${dateISO.slice(0, 10)}T12:00:00Z`);
  const name =
    new Intl.DateTimeFormat("en-US", {
      timeZone: LEAGUE_TZ,
      timeZoneName: "longOffset",
    })
      .formatToParts(noon)
      .find((p) => p.type === "timeZoneName")?.value ?? "GMT-05:00";
  // "longOffset" yields e.g. "GMT-04:00".
  return name.replace("GMT", "") || "-05:00";
}

/** The league-zone calendar date ("YYYY-MM-DD") for a timestamp — for grouping. */
export function leagueDateKey(iso: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: LEAGUE_TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(iso));
}

/**
 * Day of week (0 = Sunday) of a plain "YYYY-MM-DD" calendar date. No timezone
 * is involved: the components are read directly, so the result can't drift.
 *
 * Lives here rather than in the schedule generator that first needed it, so
 * there is one weekday-from-date implementation for everything to share.
 */
export const weekdayOf = (date: string): number => {
  const [y, m, d] = date.slice(0, 10).split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
};

/**
 * Day of week in the league zone, as `day_of_week` stores it, or -1 when there
 * is no usable date — which matches no row, so no defaults apply.
 *
 * Goes through the league-local calendar date rather than reading the timestamp
 * directly, so a late-evening game reports the day it was played on rather than
 * the UTC day it spilled into.
 */
export function leagueWeekday(iso: string | null): number {
  if (!iso) return -1;
  // Degrades rather than raising: this runs on the live scoring page, where
  // losing the goalie defaults beats losing the page. Unreachable from a
  // timestamptz column, which is the only thing that feeds it today.
  if (Number.isNaN(Date.parse(iso))) return -1;
  return weekdayOf(leagueDateKey(iso));
}

export function formatGameDate(iso: string | null): string {
  if (!iso) return "TBD";
  return new Date(iso).toLocaleDateString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    timeZone: LEAGUE_TZ,
  });
}

export function formatGameTime(iso: string | null): string {
  if (!iso) return "";
  return new Date(iso).toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    timeZone: LEAGUE_TZ,
  });
}

export function formatGameDateTime(iso: string | null): string {
  if (!iso) return "TBD";
  const date = formatGameDate(iso);
  const time = formatGameTime(iso);
  return time ? `${date} · ${time}` : date;
}

export function formatLongDate(iso: string | null): string {
  if (!iso) return "";
  // Date-only values (e.g. season start/end) are calendar dates — format in UTC
  // to avoid a zone shift; full timestamps format in the league zone.
  const dateOnly = iso.length <= 10 || !iso.includes("T");
  return new Date(
    dateOnly ? `${iso.slice(0, 10)}T12:00:00Z` : iso,
  ).toLocaleDateString("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric",
    timeZone: dateOnly ? "UTC" : LEAGUE_TZ,
  });
}
