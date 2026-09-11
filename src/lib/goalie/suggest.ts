/**
 * Who the scoresheet offers as a team's goalie, before anyone picks.
 *
 * ⛔ THIS REPLACED A TABLE AND A FLAG, AND IT REPRODUCES BOTH. Until 2026-09-11
 * a team had `team_players.is_default_goalie` (the fallback) and
 * `team_goalie_days` (a per-weekday override). Measured against production the
 * day they went: every `is_default_goalie` in both live leagues sat on a team
 * with exactly ONE goalie, which rule 1 below covers — so the flag converted to
 * nothing on purpose rather than by omission. The weekday table became
 * `team_players.night_of_week`, which any player may carry, not just a goalie.
 *
 * ⚠️ A SUGGESTION, NOT A DECISION. `setGoalie` still writes whoever the
 * scorekeeper picks; this only decides what is pre-selected. Nothing here
 * should grow a write.
 */
export type RosterGoalie = {
  playerId: string;
  /** Jersey number, or null. Only used to break a tie. */
  number: number | null;
  /** 0=Sun…6=Sat, or null for "no fixed night". */
  night: number | null;
};

/**
 * @param goalies  The team's rostered goalies — active rows only; a departed
 *                 player is history, not somebody to start.
 * @param gameWeekday  `leagueWeekday(game.scheduled_at)`: 0-6, or -1 when the
 *                 game has no usable date, which must match no assignment.
 */
export function suggestGoalie(
  goalies: RosterGoalie[],
  gameWeekday: number,
): string | null {
  if (goalies.length === 0) return null;

  // 1. One goalie is the goalie, whatever night it is. ⚠️ THIS OUTRANKS THE
  //    NIGHT ON PURPOSE: a team with a single netminder who happens to be
  //    marked "Tuesday" still plays them on Thursday, and asking their manager
  //    to assign a night to state the obvious is the tax this avoids.
  if (goalies.length === 1) return goalies[0].playerId;

  // 2. Otherwise the one whose night this is.
  const onNight = goalies
    .filter((x) => x.night === gameWeekday)
    // ⛔ DETERMINISTIC, BECAUSE THE DATA PERMITS A TIE. Nothing stops two
    //    goalies sharing a night — deliberately, so a team that alternates can
    //    be represented — and a suggestion that changed between two reads of
    //    the same roster would look like the page losing the scorekeeper's
    //    pick. Lowest jersey wins; a goalie with no number sorts last rather
    //    than winning as 0.
    .sort((a, b) => (a.number ?? Infinity) - (b.number ?? Infinity));

  // 3. Two or more goalies and none owns this night: nobody. Guessing here is
  //    how a scorekeeper ends up crediting a shutout to someone who did not
  //    play, and the pick is one tap away.
  return onNight[0]?.playerId ?? null;
}
