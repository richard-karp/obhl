/**
 * ⛔ The app half of one rule with RLS (`0042` leagues, `0043` child tables): widen or narrow
 * both together, or they disagree and lock people out silently. Pure, so it is unit tested.
 */
export function decideLeagueVisible(
  isPublic: boolean,
  isMember: boolean,
): boolean {
  return isPublic || isMember;
}
