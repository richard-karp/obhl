import { timingSafeEqual } from "node:crypto";
import { leagueDayStart, leagueToday } from "@/lib/format";

/** A half-open range of UTC instants: `[from, to)`. */
export type NightWindow = { from: string; to: string };

/**
 * ⛔ The lower bound stops the sweep re-finalizing a past game a manager just reopened, the only
 * undo. A game open more than one night is left for a manager, not closed silently.
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
 * ⛔ Fails closed on an unset secret, so a deploy missing `CRON_SECRET` exposes nothing.
 * ⛔ The length guard compares bytes: `timingSafeEqual` throws on a byte-length mismatch.
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
