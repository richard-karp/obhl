/**
 * Whether a season's published games are missing from the public site because
 * nothing is active — and whether saying so would actually help.
 *
 * Publishing does not make a schedule public. `replace_published_schedule`
 * promotes the draft games and stops there; visibility comes from
 * `setActiveSeason`, a separate action on a separate screen. A manager can
 * finish the builder and have a complete season the public site never shows.
 *
 * ⛔ NOT A SIXTH `publishMode`. That enum answers "what may the builder offer?",
 * where `started` outranks everything and collapses to `locked`. This question
 * is orthogonal: a STARTED season that is not active still has games the site
 * does not show — worse, they have actually been played — so folding it in would
 * force the notice inside the `mode === "locked"` fork and hide it in the case
 * that matters most.
 */
export function needsActivation(state: {
  /** Whether this is the league's active season — what the public site shows. */
  isActive: boolean;
  /**
   * Published (non-draft) games in this season.
   *
   * ⚠️ Meaningless unless `readFailed` is false — see below.
   */
  liveCount: number;
  /**
   * Whether ANY of the reads behind the panel's picture of this season failed.
   *
   * ⛔ READ THIS BEFORE DECIDING THE GUARD IS DEAD CODE — an earlier version of
   * this comment claimed `liveCount` is "unknown when the read failed", which
   * made the guard look redundant and invited its removal. It is not:
   * `getPublishState` builds `readFailed` from SIX independent reads but takes
   * `liveCount` from one of them. When that one fails, `liveCount` is already 0
   * and this guard changes nothing. The case where it is load-bearing is the
   * opposite one — a SIBLING read failed while the count came back fine, so
   * `liveCount` is accurate and the notice would otherwise fire on a panel whose
   * picture is only partial.
   *
   * Withholding on a partial picture is what the rest of the panel does too:
   * `hasDraft` and the "Move a game night" card are both gated the same way.
   */
  readFailed: boolean;
  /**
   * Whether the league already has a DIFFERENT season set active.
   *
   * ⛔ THE ARCHIVE GUARD, and the reason this predicate is not simply
   * "published and not active". Every row of `/<league>/seasons` links to a
   * setup page, so without this the notice appears on every season a league has
   * ever retired — offering a one-click, unconfirmed "Make this season active"
   * that would deactivate the league's CURRENT season and swap the public site
   * back to a finished one. The notice means "nothing is live and this should
   * be", not "this particular season isn't live".
   *
   * ⚠️ THE TRADE THIS MAKES, stated so it is not rediscovered as a bug. A
   * manager who builds next season, publishes it and forgets to activate it
   * gets NO warning, because last season is still active and the public site
   * still shows something coherent. That case is given up deliberately in
   * exchange for killing the archive false-positive; the alternative rule
   * considered was `ends_on < today`, which catches the forgotten activation
   * but not a retired season with no end date.
   *
   * ⚠️ A FAILED READ MUST ARRIVE HERE AS `true`. The caller cannot know whether
   * another season is active if the query errored, and suppressing a banner is
   * the harmless way to be wrong — the alternative offers a destructive button
   * on information nobody has.
   */
  leagueHasAnotherActiveSeason: boolean;
}): boolean {
  if (state.readFailed) return false;
  if (state.isActive) return false;
  if (state.leagueHasAnotherActiveSeason) return false;
  return state.liveCount > 0;
}
