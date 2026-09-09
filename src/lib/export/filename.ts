/**
 * The download filename for a schedule export: `<league>-schedule.csv`, or
 * `<league>-<team>-schedule.csv` when the export is narrowed to one team.
 *
 * Shared by the `.ics` and `.csv` routes rather than written out in each,
 * because the team half is the only thing a downloaded file has to say whose
 * schedule it holds. Two copies of that rule are two chances for one export to
 * start naming itself for the season while the other names the team.
 */
export function exportFilename(
  leagueSlug: string,
  teamSlug: string | undefined,
  extension: "ics" | "csv",
): string {
  return `${leagueSlug}${teamSlug ? `-${teamSlug}` : ""}-schedule.${extension}`;
}
