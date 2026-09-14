// The league plays on US Eastern time. Times are stored as timestamptz and
// formatted in this zone so they read correctly regardless of server timezone.
export const LEAGUE_TZ = "America/New_York";

/**
 * The zone's offset for a calendar date, sampled at noon: right for stamping an evening ice time,
 * wrong for midnight (use `leagueDayStart`).
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
 * ⛔ Not built from `leagueOffset`, which samples noon: on a fall-back day midnight is still EDT.
 * Two passes, because the offset depends on the instant, and a transition moves the guess once.
 */
export function leagueDayStart(day: string): string {
  const date = day.slice(0, 10);
  // ⚠️ Raises, unlike its neighbours: this returns a range bound, and inventing one for a
  // non-date would silently query the wrong window.
  if (Number.isNaN(Date.parse(`${date}T00:00:00Z`))) {
    throw new RangeError(`leagueDayStart: not a calendar date: ${day}`);
  }
  const offsetAt = (at: Date) =>
    (
      new Intl.DateTimeFormat("en-US", {
        timeZone: LEAGUE_TZ,
        timeZoneName: "longOffset",
      })
        .formatToParts(at)
        .find((p) => p.type === "timeZoneName")?.value ?? "GMT-05:00"
    ).replace("GMT", "") || "-05:00";

  const guess = offsetAt(new Date(`${date}T00:00:00Z`));
  const candidate = new Date(`${date}T00:00:00${guess}`);
  return new Date(`${date}T00:00:00${offsetAt(candidate)}`).toISOString();
}

/** ⚠️ `now` is a parameter, not a clock read, so this is testable without fake timers. */
export function leagueToday(now: Date = new Date()): string {
  return leagueDateKey(now.toISOString());
}

/**
 * ⛔ Compared in the league zone, never UTC: the 9:40pm slot is tomorrow in UTC (`RUNBOOK.md` →
 * Scorekeeper day rule). A null or bad `scheduled_at` is `false`: refuse one game, keep the page.
 */
export function isOnLeagueDate(
  scheduledAt: string | null,
  dateKey: string,
): boolean {
  if (!scheduledAt || Number.isNaN(Date.parse(scheduledAt))) return false;
  return leagueDateKey(scheduledAt) === dateKey;
}

/**
 * League-local "HH:MM", for matching a constraint's typed ice time ("21:30") against a placed
 * game; the display formatter renders "9:30 PM".
 */
export function leagueTimeKey(iso: string): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: LEAGUE_TZ,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(new Date(iso));
}

/** Weekday (0 = Sunday) of a plain "YYYY-MM-DD", read from its components with no timezone. */
export const weekdayOf = (date: string): number => {
  const [y, m, d] = date.slice(0, 10).split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
};

/**
 * Weekday via the league-local date, so a late game reports the day it was played; -1 for no
 * usable date, which matches no row.
 */
export function leagueWeekday(iso: string | null): number {
  if (!iso) return -1;
  // Degrades rather than raising: on the live scoring page, losing the goalie
  // defaults beats losing the page.
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
