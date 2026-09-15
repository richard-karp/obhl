/**
 * ⚠️ A suggestion, not a decision: `setGoalie` writes whoever the scorekeeper picks, and this
 * only decides what is pre-selected. Nothing here should grow a write.
 */
export type RosterGoalie = {
  playerId: string;
  /** Jersey number, or null. Only used to break a tie. */
  number: number | null;
  /** 0=Sun…6=Sat, or null for "no fixed night". */
  night: number | null;
};

/**
 * @param goalies  Active roster rows only: a departed player is history, not somebody to start.
 * @param gameWeekday  `leagueWeekday(game.scheduled_at)`; -1 (no usable date) must match nobody.
 */
export function suggestGoalie(
  goalies: RosterGoalie[],
  gameWeekday: number,
): string | null {
  if (goalies.length === 0) return null;

  // 1. One goalie is the goalie, whatever night it is. ⚠️ This outranks the night on
  //    purpose: a single netminder marked "Tuesday" still plays on Thursday.
  if (goalies.length === 1) return goalies[0].playerId;

  // 2. Otherwise the one whose night this is.
  const onNight = goalies
    .filter((x) => x.night === gameWeekday)
    // ⛔ Deterministic, since two goalies may share a night: lowest jersey wins, unnumbered last.
    // ⛔ Never `?? Infinity`: two unnumbered goalies give `Infinity - Infinity`, NaN, and no order.
    .sort((a, b) => {
      const an = a.number ?? Number.MAX_SAFE_INTEGER;
      const bn = b.number ?? Number.MAX_SAFE_INTEGER;
      // Ties broken by id so two unnumbered goalies still order stably.
      return an - bn || a.playerId.localeCompare(b.playerId);
    });

  // 3. Two or more goalies and none owns this night: nobody. A guess can credit a
  //    shutout to someone who did not play, and the pick is one tap away.
  return onNight[0]?.playerId ?? null;
}
