import type { GameWithTeams } from "@/lib/queries/schedule";

/**
 * Statuses withheld from every schedule export.
 *
 * Cancelling or postponing a game changes only its status — `scheduled_at` keeps
 * pointing at the original date (`src/lib/actions/games.ts`). An export that
 * still listed one would assert the game happens on a date it does not.
 *
 * The rule lives here rather than in `getSchedule` because the schedule page
 * needs these games: it has a status badge to tell the truth with, and an export
 * file does not.
 */
const WITHHELD = new Set<GameWithTeams["status"]>(["cancelled", "postponed"]);

/**
 * Whether a game's status makes it safe to publish in a schedule export.
 *
 * Deliberately a denylist. A status added to the enum later will be exported
 * until someone revisits this — chosen because a new status silently *appearing*
 * in an export is noticed, whereas one silently vanishing from every export is
 * not.
 */
export function isExportableFixture(status: GameWithTeams["status"]): boolean {
  return !WITHHELD.has(status);
}
