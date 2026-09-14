import { countsFor, preserved } from "./balance";
import { editable, legalAfter, type GuardRow } from "./editGuards";

/** ⛔ No team is replaced on its own: that leaves one team a game short for good. This returns
 *  the games where the outgoing team can take the incoming one's place; empty is a refusal. */
export function candidatesFor(
  rows: GuardRow[],
  gameId: string,
  teamOut: string,
  teamIn: string,
): GuardRow[] {
  const target = rows.find((r) => r.id === gameId);
  if (!target) return [];
  if (editable(target)) return [];
  if (teamOut === teamIn) return [];
  if (target.home_team_id !== teamOut && target.away_team_id !== teamOut)
    return [];

  const before = countsFor(rows);

  const partners = rows.filter(
    (r) =>
      r.id !== gameId &&
      (r.home_team_id === teamIn || r.away_team_id === teamIn) &&
      !editable(r),
  );

  const ok = partners.filter((partner) => {
    const after = rows.map((r) => {
      if (r.id === target.id) return swap(r, teamOut, teamIn);
      if (r.id === partner.id) return swap(r, teamIn, teamOut);
      return r;
    });
    if (legalAfter(after)) return false;
    return preserved(before, countsFor(after)) === null;
  });

  // Nearest first. ⚠️ Ties are the normal case on a grid of nights: break them earlier-first,
  // or the picker reorders between reads.
  const anchor = target.scheduled_at ? Date.parse(target.scheduled_at) : 0;
  return ok.sort(
    (a, b) =>
      distance(a, anchor) - distance(b, anchor) || startsAt(a) - startsAt(b),
  );
}

function startsAt(r: GuardRow): number {
  return r.scheduled_at ? Date.parse(r.scheduled_at) : Number.MAX_SAFE_INTEGER;
}

function distance(r: GuardRow, anchor: number): number {
  if (!r.scheduled_at) return Number.MAX_SAFE_INTEGER;
  return Math.abs(Date.parse(r.scheduled_at) - anchor);
}

export function swap(row: GuardRow, from: string, to: string): GuardRow {
  if (row.home_team_id === from) return { ...row, home_team_id: to };
  if (row.away_team_id === from) return { ...row, away_team_id: to };
  return row;
}
