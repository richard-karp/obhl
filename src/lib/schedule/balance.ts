import { leagueDateKey } from "@/lib/format";

/** ⛔ The user's rule: games per team and per night never change, so every edit is a trade.
 *  ⚠️ Enforced as preservation, not equality: a season may already hold an uneven night. */
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

/** ⛔ Postponed and cancelled games are not on a night: counting them makes restoring one read
 *  as an unbalancing edit, refusing the one recovery from a rink closure. */
const onIce = (r: BalanceRow) => r.status === "scheduled";

export function countsFor(rows: BalanceRow[]): Counts {
  const perTeam = new Map<string, number>();
  const perNight = new Map<string, number>();

  for (const r of rows) {
    // ⚠️ Deliberate asymmetry: a postponed game still counts toward a team's total, or a manager
    // could postpone it, trade it away, and end a game short with every check green.
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

/** `null` when neither count moved, else the first difference, with both numbers. */
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
