/**
 * How a position is written for a reader.
 *
 * ⛔ ONE COPY. This lived in three files — `team-player-table.tsx`,
 * `roster-editor.tsx` and the player page — and they disagreed: two said
 * "Defense" and `duplicate-clusters.tsx` said "Defence". The maintainer's
 * spelling is Defence, and the roster page's section heading uses the same
 * word as the row label by construction now rather than by coincidence.
 */
export const POSITION_LABEL: Record<string, string> = {
  F: "Forward",
  D: "Defence",
  G: "Goalie",
};
