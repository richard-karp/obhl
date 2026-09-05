/**
 * Which of the builder's five states a season is in.
 *
 * `started` outranks everything: a season under way offers no publish path at
 * all, which is what keeps the delete in `replace_published_schedule` from ever
 * reaching a played game.
 */
export type PublishMode =
  | "empty" // nothing live, nothing drafted
  | "draft-only" // first publish — one click, not destructive
  | "published" // live schedule, no draft to replace it with
  | "replace" // a draft would displace a live schedule — needs confirming
  | "locked"; // season under way

export function publishMode(state: {
  liveCount: number;
  draftCount: number;
  started: boolean;
}): PublishMode {
  if (state.started) return "locked";
  if (state.liveCount === 0)
    return state.draftCount === 0 ? "empty" : "draft-only";
  return state.draftCount === 0 ? "published" : "replace";
}
