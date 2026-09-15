/**
 * Candidates for a human to judge, never merged here: an import creates a `players` row per team
 * appearance, and two real people can share a name.
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
  /**
   * Display only: a departed appearance still counts toward a cluster, since it is as likely to be
   * a duplicate. The review page passes it so a transfer can be told from two people.
   */
  leftOn?: string | null;
};

export type DuplicateCluster = { key: string; members: DuplicateCandidate[] };

const normName = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

/** `a|b` with the ids ordered, matching `0035`'s `check (player_a < player_b)`. */
const pairKey = (x: string, y: string) => (x < y ? `${x}|${y}` : `${y}|${x}`);

/**
 * A cluster needs two distinct player ids and stays until every pair in it is dismissed. `members`
 * holds every matching ROW: to count players, de-duplicate on `playerId` first.
 */
export function findDuplicateClusters(
  rows: DuplicateCandidate[],
  dismissed: ReadonlyArray<readonly [string, string]> = [],
): DuplicateCluster[] {
  // Normalized here: a pair passed in the other order would match nothing, and dismissed
  // clusters would reappear.
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
