import { leagueDateKey } from "@/lib/format";
import type { BalanceRow } from "./balance";

// ⛔ `legalAfter` runs on the post-edit rows for every primitive: `exchangeSlots` changes no
// team column yet can put a team on a night it already plays.
export type GuardRow = BalanceRow & {
  home_goals: number | null;
  away_goals: number | null;
};

export type NameOf = (teamId: string) => string;

const identity: NameOf = (id) => id;

/** ⛔ Scheduled only, narrower than the user asked: the write refuses other statuses, so a wider
 *  guard offers games that fail forever. Widen both together; a 0-0 final is still played. */
export function editable(
  row: GuardRow,
  nameOf: NameOf = identity,
): string | null {
  if (row.status === "final") {
    return `${nameOf(row.home_team_id)} v ${nameOf(row.away_team_id)} has been played. A final game cannot be changed, even a 0-0 one.`;
  }
  if (row.status !== "scheduled") {
    return `${nameOf(row.home_team_id)} v ${nameOf(row.away_team_id)} is ${row.status}. Restore it to scheduled first, then change it.`;
  }
  const goals = (row.home_goals ?? 0) + (row.away_goals ?? 0);
  if (goals > 0) {
    return `${nameOf(row.home_team_id)} v ${nameOf(row.away_team_id)} already has goals recorded. Reopen and clear the scoresheet first.`;
  }
  return null;
}

/** Takes every season row: the game a doubleheader collides with may be one nobody touched. */
export function legalAfter(
  rows: GuardRow[],
  nameOf: NameOf = identity,
): string | null {
  for (const r of rows) {
    if (r.home_team_id === r.away_team_id) {
      return `${nameOf(r.home_team_id)} cannot play itself.`;
    }
  }

  /** night → team ids playing it. Postponed and cancelled games are not on the ice. */
  const nights = new Map<string, Set<string>>();
  for (const r of rows) {
    if (r.status !== "scheduled" || !r.scheduled_at) continue;
    const key = leagueDateKey(r.scheduled_at);
    const seen = nights.get(key) ?? new Set<string>();
    for (const t of [r.home_team_id, r.away_team_id]) {
      if (seen.has(t)) {
        return `${nameOf(t)} would play twice on ${key}. A team plays at most one game a night.`;
      }
      seen.add(t);
    }
    nights.set(key, seen);
  }

  return null;
}
