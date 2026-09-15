/** The fields `getLeagueSeasons` sorts on, so "newer" here matches the season switcher. */
export type SeasonStamp = {
  /** `seasons.starts_on`; null sorts oldest. */
  startsOn: string | null;
  /** `seasons.created_at`; breaks a tie on `startsOn`. */
  createdAt: string;
};

/** Whether `a` sorts ahead of `b`: `starts_on` desc with nulls last, then `created_at` desc. */
function isNewer(a: SeasonStamp, b: SeasonStamp): boolean {
  if (a.startsOn !== b.startsOn) {
    if (a.startsOn === null) return false;
    if (b.startsOn === null) return true;
    return a.startsOn > b.startsOn;
  }
  return a.createdAt > b.createdAt;
}

/**
 * Whether a season's published games are missing from the public site: publishing
 * does not activate a season, so a manager can finish the builder and nobody sees it.
 *
 * ⚠️ Warn only when nothing is active or the active season is OLDER. A newer active
 * season means this one is retired, and a banner there would be noise.
 */
export function needsActivation(state: {
  isActive: boolean;
  /** Published (non-draft) games in this season. */
  liveCount: number;
  /** Any read behind this picture failed; withhold rather than warn on a partial one. */
  readFailed: boolean;
  thisSeason: SeasonStamp;
  /** The league's active season, or null when it has none. */
  activeSeason: SeasonStamp | null;
}): boolean {
  if (state.readFailed || state.isActive || state.liveCount === 0) return false;
  if (state.activeSeason === null) return true;
  return isNewer(state.thisSeason, state.activeSeason);
}
