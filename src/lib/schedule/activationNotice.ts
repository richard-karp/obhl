/**
 * Enough of a season to place it in the league's ordering.
 *
 * ⚠️ THE FIELDS ARE THE ONES `getLeagueSeasons` SORTS ON, and that is the whole
 * reason both are here. It orders `starts_on` descending with nulls LAST, then
 * `created_at` descending — so "newer" below has to mean the same thing the
 * season switcher means by "first in the list", or this notice and the UI around
 * it would disagree about which season is the current one.
 */
export type SeasonStamp = {
  /** `seasons.starts_on`. Null sorts as the OLDEST, per `nullsFirst: false`. */
  startsOn: string | null;
  /** `seasons.created_at`. Breaks a tie on `startsOn`, same as the query. */
  createdAt: string;
};

/** Whether `a` sorts ahead of `b` in the league's newest-first ordering. */
function isNewer(a: SeasonStamp, b: SeasonStamp): boolean {
  if (a.startsOn !== b.startsOn) {
    // Null is the oldest, so a dated season beats an undated one either way
    // round. Plain string comparison is correct for ISO dates.
    if (a.startsOn === null) return false;
    if (b.startsOn === null) return true;
    return a.startsOn > b.startsOn;
  }
  return a.createdAt > b.createdAt;
}

/**
 * Whether a season's published games are missing from the public site in a way
 * worth telling the manager about.
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
  /** This season's place in the league's ordering. */
  thisSeason: SeasonStamp;
  /**
   * The league's active season — `null` when it has none, `"unreadable"` when
   * the query errored.
   *
   * ⛔ THREE VALUES, AND THE THIRD IS NOT `null`. `null` means "nothing is
   * live", which WARNS — it is the original case this notice was built for, a
   * league's first season published and never flipped on. Folding a failed read
   * into it would fire a banner carrying a destructive button on information
   * nobody has. Same discipline as `staleDraftFor`'s `"unreadable"`.
   *
   * ⛔ AND IT IS COMPARED, NOT MERELY TESTED FOR EXISTENCE. "Some other season
   * is active" conflates two opposite situations:
   *
   *   - active is OLDER than this one → next season is built, published, and
   *     nobody flipped it live. Warn: the site still looks coherent, which is
   *     exactly why this goes unnoticed.
   *   - active is NEWER than this one → this season is retired. Stay quiet; the
   *     banner's one-click button would drag the public site back onto it.
   *
   * A bare boolean suppressed BOTH, which made the notice unreachable for any
   * league that had ever activated anything. CI caught it, because the e2e
   * asserting the banner could no longer see it.
   */
  activeSeason: SeasonStamp | null | "unreadable";
}): boolean {
  if (state.readFailed) return false;
  if (state.isActive) return false;
  if (state.activeSeason === "unreadable") return false;
  if (state.liveCount === 0) return false;
  // Nothing live at all — a league's first season, published and never flipped
  // on, so every public page reads "No active season".
  if (state.activeSeason === null) return true;
  // Something IS live. Warn only if this season comes after it.
  return isNewer(state.thisSeason, state.activeSeason);
}
