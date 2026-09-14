/**
 * Shared by the `.ics` and `.csv` routes: the team half is how a downloaded file says whose
 * schedule it holds, and two copies of that rule could drift.
 */
export function exportFilename(
  leagueSlug: string,
  teamSlug: string | undefined,
  extension: "ics" | "csv",
): string {
  return `${leagueSlug}${teamSlug ? `-${teamSlug}` : ""}-schedule.${extension}`;
}
