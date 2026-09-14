import { resolveGoalieOfRecord } from "@/lib/goalie/of-record";

/**
 * ⛔ A muted button is not a gate: the action refuses, sharing this pure rule with the page.
 * ⛔ Not in `lib/actions/games.ts`: a `"use server"` file cannot export a non-async function.
 */
export type SideCheck = {
  /** Shown to the user, so it has to be the team's name, not its id. */
  teamName: string;
  /**
   * ⛔ EVERY `game_rosters` row, the Substitutes row included: a subs-only team is supported
   * (`setSubstitutes`), and the fault this catches is a team with no rows at all.
   */
  dressedCount: number;
  goalieId: string | null;
  goalieIsSub: boolean;
  /** Dressed players whose roster row is `position = 'G'`. */
  dressedGoalieIds: string[];
};

/**
 * ⛔ A substitute goalie is not a missing one (`0015`): a warning that fires on a correct sheet
 * teaches people to click through warnings. Only `none` warns.
 */
export function scoresheetProblems(sides: SideCheck[]): string[] {
  const problems: string[] = [];
  for (const side of sides) {
    if (side.dressedCount === 0) {
      problems.push(`${side.teamName}: no players dressed`);
    }
    if (resolveGoalieOfRecord(side).kind === "none") {
      problems.push(`${side.teamName}: no goalie recorded`);
    }
  }
  return problems;
}
