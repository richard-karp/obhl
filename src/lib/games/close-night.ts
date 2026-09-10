import { timingSafeEqual } from "node:crypto";
import { leagueDayStart, leagueToday } from "@/lib/format";

/** A half-open range of UTC instants: `[from, to)`. */
export type NightWindow = { from: string; to: string };

/**
 * The league night that has just ended, as a half-open range of UTC instants.
 *
 * ⛔ THE LOWER BOUND IS NOT AN OPTIMISATION — IT IS THE FIX FOR THIS ROUTE'S
 * WORST BUG. Selecting `in_progress` games with only an upper bound matches every
 * such game ever recorded, and `reopenGameById` puts a PAST-dated game back into
 * exactly that state. It has two callers: the scoresheet's Reopen button, and
 * `audit.ts`'s revert of a wrong `finalize_game`. Unbounded, the sweep
 * re-finalized whatever a manager had just corrected — so the app's only undo for
 * a bad finalize survived less than a day, and left a fresh audit entry
 * attributed to nobody.
 *
 * ⚠️ THE COST, STATED: a game left open for MORE than one night is never swept.
 * That is deliberate. Finalizing a game days later recomputes standings from a
 * half-entered roster with nobody watching; a backlog is something to show a
 * manager, not to close silently.
 *
 * ⚠️ Both ends come from `leagueDayStart`, so a DST night is 23 or 25 hours as it
 * should be. A window built from one offset would clip the fall-back hour — the
 * hour a 9:40pm game sits in.
 *
 * ⚠️ `now` is a parameter so this is testable without touching the clock, matching
 * `leagueToday`. Hobby cron precision is per-hour (`0 6 * * *` fires anywhere in
 * 06:00-06:59 UTC), and the window must not move with that drift — it is derived
 * from the league DATE, not from the firing time.
 */
export function nightWindow(now: Date = new Date()): NightWindow {
  const today = leagueToday(now);
  // Noon anchors the arithmetic away from both DST transitions, so stepping back
  // a day cannot land on a missing or doubled hour.
  const d = new Date(`${today}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  const yesterday = d.toISOString().slice(0, 10);

  return { from: leagueDayStart(yesterday), to: leagueDayStart(today) };
}

/**
 * Does this `Authorization` header carry the cron secret?
 *
 * ⛔ FAILS CLOSED ON AN UNSET SECRET. A deploy that forgets `CRON_SECRET` must do
 * nothing at all, rather than leave a route that finalizes games open to anyone
 * who finds the path. The visible symptom is a silent daily 401.
 *
 * ⛔ THE LENGTH GUARD COMPARES BYTES, NOT CHARACTERS, AND THAT IS THE BUG THIS
 * FUNCTION EXISTS TO STOP REPEATING. `timingSafeEqual` THROWS when its inputs
 * differ in byte length, so the guard in front of it must measure the same thing.
 * An earlier version used `String.length` — UTF-16 code units — so a header
 * containing any byte >= 0x80 (an accented character, say) could match on string
 * length, differ on byte length, and make the comparison raise: an unhandled 500
 * where a 401 belonged, on an internet-reachable endpoint.
 *
 * Constant-time once the lengths agree, so the comparison cannot leak the secret
 * a byte at a time. Low practical risk over HTTPS with a random secret; it costs
 * two lines.
 */
export function isAuthorizedCron(
  header: string | null,
  secret: string | undefined,
): boolean {
  if (!secret) return false;
  const offered = Buffer.from(header ?? "");
  const expected = Buffer.from(`Bearer ${secret}`);
  return (
    offered.length === expected.length && timingSafeEqual(offered, expected)
  );
}
