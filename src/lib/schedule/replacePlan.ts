import { countsFor, preserved } from "./balance";
import { editable, legalAfter, type GuardRow } from "./editGuards";

/**
 * Which games could absorb a team replacement, so that "replace B with C" stays
 * a trade.
 *
 * ⛔ THERE IS NO SUCH THING AS REPLACING A TEAM ON ITS OWN. Swap B out for C in
 * one game and B ends the season a game short while C ends it a game long —
 * permanently, and against the user's non-negotiable "every team plays the same
 * number of games". The only legal shape is a trade: C takes B's place here, and
 * B takes C's place in some other game.
 *
 * So the UI reads as a replacement and this is what makes it honest. The manager
 * picks who leaves and who arrives; this returns every game where the second
 * half of the trade works, and the action writes both rows at once. An empty
 * list is a refusal — never a single-row write with an apology.
 */
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
    // Belt and braces: a true trade cannot move a count, but the check is cheap
    // and it is the invariant the whole feature promises.
    return preserved(before, countsFor(after)) === null;
  });

  // Nearest first. A manager fixing one week wants the closest partner game —
  // the further away it sits, the more of the season the change ripples through.
  //
  // ⚠️ TIES ARE THE NORMAL CASE, NOT AN EDGE ONE. A schedule is a grid of game
  // nights, so a partner two weeks before and one two weeks after are exactly
  // as close. Falling back to input order there would make the list reorder
  // itself between reads for no reason the manager can see; earlier-first is
  // arbitrary but stable, and a stable list is what makes a picker usable.
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

/** The same row with `from` replaced by `to`, whichever side it sits on. */
export function swap(row: GuardRow, from: string, to: string): GuardRow {
  if (row.home_team_id === from) return { ...row, home_team_id: to };
  if (row.away_team_id === from) return { ...row, away_team_id: to };
  return row;
}
