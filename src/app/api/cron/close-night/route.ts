import { timingSafeEqual } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";
import { createAdminClient } from "@/utils/supabase/admin";
import { finalizeGameById } from "@/lib/games/finalize";
import { leagueDayStart, leagueToday } from "@/lib/format";

/**
 * Closes the night: completes any game left `in_progress` after its day ended.
 *
 * ⛔ IT CALLS `finalizeGameById`, NOT SQL, AND THAT IS THE POINT. That function
 * is the single definition of what "complete" means — it recomputes the score
 * from `game_rosters` and writes the audit entry. A plpgsql version scheduled
 * with `pg_cron` would be a SECOND definition, free to drift from the one the
 * scoresheet uses, and this codebase already insists on one write path
 * (`EXPORTS_HANDOFF` §2). The cost is that this only runs while the app is
 * deployed; the benefit is that a game finalized by the sweep is byte-for-byte a
 * game finalized by a person.
 *
 * ⛔ `in_progress` ONLY — NEVER `scheduled`. `bumpStat` moves a game to
 * `in_progress` the moment anything is recorded, so `in_progress` means "somebody
 * scored this and did not finish". A `scheduled` game is one nobody touched, and
 * auto-finalizing it would invent a 0-0 result for a game that may simply not
 * have been played — inventing results is worse than leaving one open.
 *
 * ⚠️ THE ACTOR IS NULL, deliberately. `audit_log.user_id` is nullable
 * (`0021_audit_log.sql`) and the audit page already renders a null actor
 * (`audit/page.tsx:62,339`) — checked, not assumed. A system sweep is not a
 * person, and attributing it to the last scorekeeper would be a lie in the one
 * record that exists to say who did what.
 *
 * ⚠️ Scheduled at 06:00 UTC — 1am EST, 2am EDT. Safely past league midnight in
 * BOTH DST states, which a schedule pinned to local midnight cannot be, since
 * Vercel crons are UTC. The exact minute does not matter: the page guard already
 * locked the scorekeeper out at 00:00, so nothing can change between midnight
 * and the sweep. This is tidying, not enforcement.
 */
// ⚠️ The default function timeout is generous, but the FIRST run over an existing
// database can find far more stuck games than a normal night — each costing
// several round trips — and a timeout mid-loop leaves the rest for tomorrow with
// no resume. Raised, and the query is bounded below for the same reason.
export const maxDuration = 300;

export async function GET(request: NextRequest) {
  // ⛔ Vercel sends `Authorization: Bearer $CRON_SECRET`. Without this check the
  // route is a public endpoint that finalizes games — anyone could close a night
  // early, mid-game. Fails CLOSED when the secret is unset, so a misconfigured
  // deploy does nothing rather than exposing it.
  const secret = process.env.CRON_SECRET;
  const offered = request.headers.get("authorization") ?? "";
  const expected = `Bearer ${secret ?? ""}`;
  // Constant-time, so the comparison cannot leak the secret a byte at a time.
  // Low practical risk over HTTPS with a random secret; it is two lines.
  const ok =
    !!secret &&
    offered.length === expected.length &&
    timingSafeEqual(Buffer.from(offered), Buffer.from(expected));
  if (!ok) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const admin = createAdminClient();
  // Everything that started before today's league day began. Uses the same
  // `leagueDayStart` the scorekeeper's own page filters with, so "the day" means
  // one thing across the feature.
  const { data: stale, error } = await admin
    .from("games")
    .select("id")
    .eq("status", "in_progress")
    .eq("is_draft", false)
    .lt("scheduled_at", leagueDayStart(leagueToday()))
    // Bounded so one pathological night cannot run past the timeout and finish
    // nothing. Anything beyond this is closed by the next run.
    .limit(200);

  if (error) {
    console.error("close-night: read failed:", error.message);
    return NextResponse.json({ error: "read failed" }, { status: 500 });
  }

  const ids = (stale ?? []).map((g) => g.id);
  const closed: string[] = [];
  const failed: string[] = [];
  // Serial, not `Promise.all`: each finalize recomputes a score and writes an
  // audit row, and a night is a handful of games. A stampede here would buy
  // nothing and could contend on the same rows.
  for (const id of ids) {
    try {
      // ⛔ THE ADMIN CLIENT, EXPLICITLY. Without it every statement inside runs
      // as `anon`: the UPDATE matches zero rows and reports no error, the roster
      // read comes back empty (public reads expose rosters only for FINAL
      // games), and the sweep would file audit entries for finalizes that never
      // happened — while reporting success. Verified against the live stack.
      await finalizeGameById(id, null, admin);
      closed.push(id);
    } catch (e) {
      // One bad game must not abandon the rest — the others would stay open
      // until tomorrow's run, compounding.
      console.error("close-night: finalize failed", id, e);
      failed.push(id);
    }
  }

  return NextResponse.json({ closed: closed.length, failed: failed.length });
}
