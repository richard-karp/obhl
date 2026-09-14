import type { GameWithTeams } from "@/lib/queries/schedule";

/**
 * Only `cancelled`, which keeps its original `scheduled_at`. `postponed` is exportable only
 * because postponing clears the date (`RUNBOOK.md` → Schedule edits and exports).
 */
const WITHHELD = new Set<GameWithTeams["status"]>(["cancelled"]);

/** A denylist on purpose: a new status appearing in an export is noticed; one vanishing is not. */
export function isExportableFixture(status: GameWithTeams["status"]): boolean {
  return !WITHHELD.has(status);
}
