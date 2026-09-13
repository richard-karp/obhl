import { resolveGoalieOfRecord } from "@/lib/goalie/of-record";

/**
 * What is missing from a scoresheet that is about to be completed.
 *
 * ⛔ THIS EXISTS BECAUSE A MUTED BUTTON IS NOT A GATE. `score-board.tsx` draws
 * an unconfirmed goalie suggestion in a lighter variant and says, in a comment
 * written before any of this shipped, exactly what would happen if a
 * scorekeeper read past it: "both branches of `v_goalie_stats` miss and the
 * goalie gets no GP, no GAA, no W/L". Measured against production on
 * 2026-09-12, the first three real games: FOUR of six team-sides had no goalie
 * of record, and one team had no dressed players at all. The styling was the
 * whole mitigation and it carried nothing.
 *
 * ⚠️ A pure function over facts, not a query, so the server action and the
 * scoresheet cannot disagree about what "incomplete" means — the action is the
 * gate, the page only explains it, and a page that computed a different answer
 * would offer "Complete anyway" for a refusal that never came.
 *
 * ⛔ NOT IN `lib/actions/games.ts`. That file is `"use server"`, where every
 * export is a callable endpoint and a non-async export is a build error.
 */
export type SideCheck = {
  /** Shown to the user, so it has to be the team's name, not its id. */
  teamName: string;
  /**
   * EVERY `game_rosters` row for this team, the aggregate Substitutes row
   * included.
   *
   * ⛔ NOT "non-substitute rows". A team that dressed only the Substitutes row
   * is a state the scoresheet deliberately supports (`setSubstitutes`), and
   * the fault this catches was a team with ZERO rows of any kind. Counting
   * only real players would invent a second fault and warn about a sheet that
   * is correct.
   */
  dressedCount: number;
  goalieId: string | null;
  goalieIsSub: boolean;
  /** Dressed players whose roster row is `position = 'G'`. */
  dressedGoalieIds: string[];
};

/**
 * One line per problem, ready to print. Empty means nothing is missing.
 *
 * ⛔ A SUBSTITUTE GOALIE IS NOT A MISSING ONE. `setGoalie` writes
 * `goalie_id = null, is_sub = true` for the Sub button, and that is a complete,
 * deliberate answer — `0015` gives a substitute goalie no individual record on
 * purpose. Warning about it would nag a correctly-entered sheet, and a warning
 * that fires on correct data is how people learn to click through warnings,
 * which is the behaviour this function exists to prevent. Only `none` warns.
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
