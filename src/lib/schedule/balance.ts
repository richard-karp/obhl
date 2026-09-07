import { leagueDateKey } from "@/lib/format";

/**
 * The two numbers a manual schedule edit may never change.
 *
 * ⛔ THE USER'S CONSTRAINT, AND THE REASON THIS MODULE EXISTS: "Total games
 * played and games per night are non-negotiable. Those numbers always have to
 * be even" — even meaning EQUAL, confirmed before the design was written. Follow
 * it through and most edits cannot exist as stated: replacing team B with C
 * leaves B a game short forever; moving a game to another night robs the night
 * it left. Only trades preserve both counts, which is why every operation in
 * `schedule-edits.ts` is a trade.
 *
 * ⚠️ WHAT IS ENFORCED IS PRESERVATION, NOT GLOBAL EQUALITY. A season may
 * legitimately hold an uneven night — a short final week, a rink that gave up
 * two sheets instead of three. An edit must not be refused for an imbalance it
 * did not cause, so the rule is "these counts are what they were", never "these
 * counts are all the same". See the design doc, 2026-09-07.
 */
export type BalanceRow = {
  id: string;
  home_team_id: string;
  away_team_id: string;
  scheduled_at: string | null;
  status: string;
};

export type Counts = {
  /** Team id → games that team owes or has played. */
  perTeam: Map<string, number>;
  /** League-local date key → games being played that night. */
  perNight: Map<string, number>;
};

/**
 * A game still on the ice.
 *
 * ⛔ POSTPONED AND CANCELLED GAMES ARE NOT ON A NIGHT. Postponing a game takes
 * it off its night — that is what postponing IS — so counting it would make
 * restoring one read as an edit that unbalanced the schedule, and the invariant
 * would refuse the single operation that recovers from a rink closure.
 */
const onIce = (r: BalanceRow) => r.status === "scheduled";

export function countsFor(rows: BalanceRow[]): Counts {
  const perTeam = new Map<string, number>();
  const perNight = new Map<string, number>();

  for (const r of rows) {
    // ⚠️ ASYMMETRY, AND IT IS DELIBERATE. A postponed game still counts toward
    // a team's TOTAL, because it is still a game they owe. Dropping it here
    // would let a manager postpone a game, trade it away, and finish the season
    // a game short with every check green.
    bump(perTeam, r.home_team_id);
    bump(perTeam, r.away_team_id);

    if (!onIce(r) || !r.scheduled_at) continue;
    bump(perNight, leagueDateKey(r.scheduled_at));
  }

  return { perTeam, perNight };
}

function bump(m: Map<string, number>, k: string) {
  m.set(k, (m.get(k) ?? 0) + 1);
}

/**
 * `null` when the edit changed neither number, otherwise the first difference in
 * words a manager can act on.
 *
 * The message names the thing that moved and both numbers, because "that would
 * unbalance the schedule" tells a manager nothing about what to do instead.
 */
export function preserved(
  before: Counts,
  after: Counts,
  /** Team id → name. Without it the message names a UUID, which helps nobody. */
  nameOf: (teamId: string) => string = (id) => id,
): string | null {
  const teams = keysOf(before.perTeam, after.perTeam);
  for (const t of teams) {
    const was = before.perTeam.get(t) ?? 0;
    const now = after.perTeam.get(t) ?? 0;
    if (was !== now) {
      return `${nameOf(t)} would play ${now} games, not ${was}. Every team has to end with the same number of games.`;
    }
  }

  const nights = keysOf(before.perNight, after.perNight);
  for (const n of nights) {
    const was = before.perNight.get(n) ?? 0;
    const now = after.perNight.get(n) ?? 0;
    if (was !== now) {
      return `${n} would hold ${now} ${now === 1 ? "game" : "games"}, not ${was}. A night keeps the number of games it was built with.`;
    }
  }

  return null;
}

/** Every key on either side, so a team or night that only appears after the edit still reports. */
function keysOf(a: Map<string, number>, b: Map<string, number>): string[] {
  return [...new Set([...a.keys(), ...b.keys()])].sort();
}
