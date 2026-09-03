/**
 * Same-name player detection for the merge review.
 *
 * esportsdesk carries only names, so a roster-only import creates a fresh
 * `players` row per team appearance: one person on two teams arrives as two
 * records. Two real people also genuinely share a name, which is why this
 * reports candidates for a human to judge rather than merging anything.
 */

export type DuplicateCandidate = {
  playerId: string;
  firstName: string;
  lastName: string;
  seasonId: string;
  teamId: string;
  teamName: string;
  jerseyNumber: number | null;
  position: "F" | "D" | "G";
};

export type DuplicateCluster = { key: string; members: DuplicateCandidate[] };

/**
 * The importer's matching rule, so a name that matched there matches here.
 * Mirrored rather than imported: it lives in `src/lib/actions/import.ts`, a
 * "use server" module, where every export has to be an async function.
 */
const normName = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

/** `a|b` with the ids ordered, matching `0035`'s `check (player_a < player_b)`. */
const pairKey = (x: string, y: string) => (x < y ? `${x}|${y}` : `${y}|${x}`);

/**
 * Group roster rows into clusters of records that may be the same person.
 *
 * A cluster needs two or more *distinct* player ids: one player listed on two
 * teams is one player, not a duplicate. A cluster disappears only when every
 * pair inside it has been dismissed — dismissing a–b out of {a,b,c} leaves a–c
 * and b–c unjudged, so the cluster stays.
 */
export function findDuplicateClusters(
  rows: DuplicateCandidate[],
  dismissed: ReadonlyArray<readonly [string, string]> = [],
): DuplicateCluster[] {
  // Normalized here, not at the call site: a caller passing a pair in the other
  // order would otherwise match nothing, and every cluster would reappear with
  // the dismissal table quietly filling up behind it.
  const dismissedPairs = new Set(dismissed.map(([x, y]) => pairKey(x, y)));

  const byName = new Map<string, DuplicateCandidate[]>();
  for (const r of rows) {
    const key = normName(`${r.firstName}${r.lastName}`);
    if (!key) continue;
    const bucket = byName.get(key);
    if (bucket) bucket.push(r);
    else byName.set(key, [r]);
  }

  const clusters: DuplicateCluster[] = [];
  for (const [key, members] of byName) {
    const ids = [...new Set(members.map((m) => m.playerId))];
    if (ids.length < 2) continue;

    let allDismissed = true;
    for (let i = 0; i < ids.length && allDismissed; i++) {
      for (let j = i + 1; j < ids.length; j++) {
        if (!dismissedPairs.has(pairKey(ids[i], ids[j]))) {
          allDismissed = false;
          break;
        }
      }
    }
    if (allDismissed) continue;

    clusters.push({ key, members });
  }
  // Sorted so the review page lists clusters the same way every load.
  return clusters.sort((a, b) => a.key.localeCompare(b.key));
}
