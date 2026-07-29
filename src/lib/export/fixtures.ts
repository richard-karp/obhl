import type { GameWithTeams } from "@/lib/queries/schedule";

/**
 * Statuses withheld from every schedule export.
 *
 * Only `cancelled`, because cancelling a game changes its status but leaves
 * `scheduled_at` pointing at the original date — an export listing it would
 * assert the game happens on a date it does not.
 *
 * `postponed` is deliberately absent. Postponing clears the date
 * (`postpone_game`), so a postponed game is no longer claiming a date it isn't
 * being played on: the CSV shows it honestly with empty date and time cells, and
 * `buildIcs` drops it as it drops any undated game. No special rule needed.
 *
 * The rule lives here rather than in `getSchedule` because the schedule page
 * needs these games: it has a status badge to tell the truth with, and an export
 * file does not.
 */
const WITHHELD = new Set<GameWithTeams["status"]>(["cancelled"]);

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
