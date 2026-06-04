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
  return new Date(dateOnly ? `${iso.slice(0, 10)}T12:00:00Z` : iso).toLocaleDateString(
    "en-US",
    {
      month: "long",
      day: "numeric",
      year: "numeric",
      timeZone: dateOnly ? "UTC" : LEAGUE_TZ,
    },
  );
}
