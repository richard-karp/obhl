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
 * The UTC instant at which a league-zone calendar day begins.
 *
 * ⛔ DO NOT BUILD THIS FROM `leagueOffset`. That function samples NOON, which is
 * the right choice for stamping an evening ice time and the wrong one for
 * midnight: on 1 Nov 2026 the zone switches EDT->EST at 2am, so noon is -05:00
 * while midnight is still -04:00. Stamping midnight with the noon offset puts
 * the day's start an hour late and clips 00:00-01:00 off it.
 *
 * Two passes, because the offset depends on the very instant being computed:
 * guess with the offset in force at midnight UTC, apply it, then re-read the
 * offset at that candidate. The second read is the answer — a transition can
 * move the candidate across itself once, never twice.
 */
export function leagueDayStart(day: string): string {
  const date = day.slice(0, 10);
  // ⚠️ RAISES, AND DELIBERATELY DOES NOT DEGRADE LIKE ITS NEIGHBOURS.
  // `isOnLeagueDate` and `leagueWeekday` answer a bad input with a refusal
  // because they decide about ONE game and losing the page is worse. This one
  // returns a range BOUND: there is no sensible day-start for a non-date, and
  // inventing one would silently query the wrong window. `Intl.formatToParts`
  // would throw anyway a few lines down — this only makes the message name the
  // input instead of surfacing an opaque RangeError from inside Intl.
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

/**
 * Today's league-zone calendar date ("YYYY-MM-DD").
 *
 * ⚠️ `now` IS A PARAMETER, NOT A CLOCK READ, and that is the whole reason this
 * is testable. Nothing in this repo uses fake timers, so a function that read
 * `new Date()` internally could only be tested by mocking the clock. Callers
 * pass the value down; the default is the convenience.
 */
export function leagueToday(now: Date = new Date()): string {
  return leagueDateKey(now.toISOString());
}

/**
 * Is this game on the given league-zone date?
 *
 * ⛔ THE COMPARISON MUST BE IN THE LEAGUE ZONE, NOT UTC. The last slot of a
 * night is 9:40pm Eastern, which is already the next day in UTC — comparing UTC
 * dates would drop the final game of every night off its own night.
 *
 * Degrades to `false` rather than raising, matching `leagueWeekday`: a null
 * `scheduled_at` is a postponed or unscheduled game (`0025` nulls it), and this
 * runs on the scoring path, where refusing one game beats losing the page.
 */
export function isOnLeagueDate(
  scheduledAt: string | null,
  dateKey: string,
): boolean {
  if (!scheduledAt || Number.isNaN(Date.parse(scheduledAt))) return false;
  return leagueDateKey(scheduledAt) === dateKey;
}

/**
 * Has this game started, and started recently enough to still be in play?
 *
 * ⛔ A TAIL, NOT A WINDOW, AND THE DIRECTION IS THE WHOLE POINT. It only ever
 * reaches BACKWARD from now. Tonight's later games are reachable because they
 * are TODAY — if this reached forward too it would become the rolling window
 * that was considered and rejected, where a scorekeeper arriving at 6pm cannot
 * prepare the 9:40 game.
 *
 * It exists because the day rule alone cuts at local midnight, and the last slot
 * of a night starts at 9:40pm: a scorekeeper still entering that game at 00:05
 * would be refused the page mid-shift. The writes never stopped working — no
 * action carries a day check — so without this the submit SUCCEEDS and the
 * re-render then locks them out of the game they just changed, which is worse
 * than refusing them outright.
 *
 * ⚠️ No timezone maths here on purpose: this is a duration between two instants,
 * and instants have no zone. The league zone only matters for deciding which
 * calendar DAY something falls on, which is `isOnLeagueDate`'s job.
 */
export function hasStartedWithin(
  scheduledAt: string | null,
  hours: number,
  now: Date = new Date(),
): boolean {
  if (!scheduledAt) return false;
  const started = Date.parse(scheduledAt);
  if (Number.isNaN(started)) return false;
  const elapsed = now.getTime() - started;
  return elapsed >= 0 && elapsed <= hours * 60 * 60 * 1000;
}

/**
 * League-local wall-clock time as "HH:MM", 24-hour.
 *
 * The counterpart of `leagueDateKey`, and it exists for the same reason: a
 * schedule constraint stores the ice time the manager typed into the generate
 * form ("21:30"), and matching it against a placed game means reading that
 * game's time back in the league's timezone rather than the server's. The
 * display formatter above cannot be used for that — it renders "9:30 PM".
 */
export function leagueTimeKey(iso: string): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: LEAGUE_TZ,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
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
