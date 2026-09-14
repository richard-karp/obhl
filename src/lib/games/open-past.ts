import { leagueDateKey } from "@/lib/format";

/** Whether a game's league-zone date is before `today` (a `leagueToday()` key). */
export function isPastGame(
  g: { scheduled_at: string | null },
  today: string,
): boolean {
  return !!g.scheduled_at && leagueDateKey(g.scheduled_at) < today;
}

/** Past games never finalized: still `scheduled` or `in_progress`. */
export function openPastGames<
  G extends { status: string; scheduled_at: string | null },
>(games: G[], today: string): G[] {
  return games.filter(
    (g) =>
      (g.status === "scheduled" || g.status === "in_progress") &&
      isPastGame(g, today),
  );
}
