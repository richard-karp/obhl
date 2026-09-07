import { leagueDateKey } from "@/lib/format";
import type { BalanceRow } from "./balance";

/**
 * What a manual schedule edit may not produce, independent of the balance
 * invariant in `balance.ts`.
 *
 * Two halves, and they run at different moments:
 *
 * - `editable` asks whether a row may be TOUCHED, and runs on the rows as they
 *   are now.
 * - `legalAfter` asks whether the schedule the edit would produce is legal, and
 *   runs on the POST-EDIT rows.
 *
 * ⛔ `legalAfter` RUNS FOR EVERY PRIMITIVE, INCLUDING THE ONES THAT DO NOT TOUCH
 * TEAMS. `exchangeSlots` trades dates, so it can drop a team onto a night it
 * already plays without changing a single team column. A guard list attached to
 * "the operation that changes teams" would leave that door open; one that runs
 * over the resulting rows cannot.
 */
export type GuardRow = BalanceRow & {
  home_goals: number | null;
  away_goals: number | null;
};

/** Turn a team id into something a manager recognises. */
export type NameOf = (teamId: string) => string;

const identity: NameOf = (id) => id;

/**
 * `null` when this row may be edited, otherwise why not.
 *
 * ⛔ SCHEDULED ONLY, FOR NOW — AND THIS IS NARROWER THAN THE USER ASKED FOR.
 * They chose "postponed and cancelled stay editable, refuse only when goals
 * exist", and this guard was written that way. It was wrong in a way no test
 * caught: `applyGameWrites`'s pre-flight (`gameWrites.ts:246`) hard-codes
 * `row.status !== "scheduled" → conflict`, so a widened status set never
 * reached the UPDATE at all. A cancelled game keeps its date, so it WAS
 * offered in the picker, and choosing one gave "The schedule changed while
 * this was on screen" forever.
 *
 * So the guard now refuses what the write path refuses, and says so honestly.
 * ⚠️ Widening belongs to the schedule-write RPC — it rewrites that pre-flight,
 * and doing it here first means writing it twice. Decided with the user
 * 2026-09-07. See `docs/superpowers/plans/2026-09-06-schedule-write-rpc.md`.
 *
 * `final` is refused whether or not goals exist: a 0-0 final holds none and is
 * still a played game.
 */
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

/**
 * `null` when the post-edit schedule is legal, otherwise the first problem.
 *
 * Takes every row of the season, not only the edited ones: a doubleheader is a
 * property of a night, and the game that collides may be one nobody touched.
 */
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
