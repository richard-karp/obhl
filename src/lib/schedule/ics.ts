import { createEvents, type EventAttributes } from "ics";

export type IcsGame = {
  id: string;
  scheduled_at: string | null;
  status: string;
  home: string;
  away: string;
  home_goals?: number;
  away_goals?: number;
};

/** Builds a VCALENDAR string with a stable UID per game (so updates replace). */
export function buildIcs(games: IcsGame[], calName: string): string {
  const events: EventAttributes[] = games
    .filter((g) => g.scheduled_at)
    .map((g) => {
      const d = new Date(g.scheduled_at!);
      const title =
        g.status === "final"
          ? `${g.away} ${g.away_goals ?? 0}–${g.home_goals ?? 0} ${g.home} (Final)`
          : `${g.away} @ ${g.home}`;
      return {
        uid: `game-${g.id}@obhl`,
        start: [
          d.getUTCFullYear(),
          d.getUTCMonth() + 1,
          d.getUTCDate(),
          d.getUTCHours(),
          d.getUTCMinutes(),
        ],
        startInputType: "utc",
        startOutputType: "utc",
        duration: { hours: 1, minutes: 30 },
        title,
        calName,
        productId: "obhl/ics",
      } satisfies EventAttributes;
    });

  const { error, value } = createEvents(events);
  if (error || !value) {
    return `BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:obhl\r\nEND:VCALENDAR`;
  }
  return value;
}
