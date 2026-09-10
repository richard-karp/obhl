import { NextResponse, type NextRequest } from "next/server";
import { createAdminClient } from "@/utils/supabase/admin";
import { finalizeGameById } from "@/lib/games/finalize";
import { isAuthorizedCron, nightWindow } from "@/lib/games/close-night";

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
 * Vercel crons are UTC.
 *
 * ⛔ AND THE HOBBY PLAN ONLY PROMISES THE HOUR, NOT THE MINUTE. Vercel documents
 * Hobby cron precision as "per-hour (±59 min)": a job set to `0 6 * * *` fires
 * anywhere in 06:00-06:59 UTC. The drift is FORWARD — it never fires early — so
 * the sweep still cannot start before the night it is closing has ended. That is
 * load-bearing: a schedule set nearer local midnight would have had no such
 * margin. Hobby also caps crons at ONCE PER DAY; a more frequent expression
 * fails deployment outright.
 */
// ⚠️ 300 IS THE HOBBY CEILING, NOT AN ARBITRARY NUMBER. Vercel's function limits
// give Hobby "300s default and maximum" under Fluid compute; Pro can go to 800.
// A review round flagged this as a deploy-breaking 60s overrun — that limit is
// historical and no longer applies. Checked against the docs on 2026-09-10 rather
// than taken on either party's word.
export const maxDuration = 300;

export async function GET(request: NextRequest) {
  // ⛔ Vercel sends `Authorization: Bearer $CRON_SECRET`. Without this check the
  // route is a public endpoint that finalizes games — anyone could close a night
  // early, mid-game. Fails CLOSED when the secret is unset, so a misconfigured
  // deploy does nothing rather than exposing it.
  // ⛔ THE COMPARISON LIVES IN `isAuthorizedCron`, NOT HERE, FOR THE SAME REASON
  // THE WINDOW DOES: it had a bug (`String.length` in front of a byte-length
  // `timingSafeEqual`, so a header with any byte >= 0x80 raised a 500 instead of
  // returning a 401) and nothing but a hand-run script could have caught it.
  // `close-night.test.ts` now kills that version with no server and no database.
  if (
    !isAuthorizedCron(
      request.headers.get("authorization"),
      process.env.CRON_SECRET,
    )
  ) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const admin = createAdminClient();
  // Everything that started before today's league day began. Uses the same
  // `leagueDayStart` the scorekeeper's own page filters with, so "the day" means
  // one thing across the feature.
  // ⛔ THE WINDOW LIVES IN `nightWindow`, NOT HERE, SO IT CAN BE TESTED. This was
  // inline date arithmetic, which meant the route's most important property — that
  // it closes ONE night and cannot reach a game a manager reopened — had no
  // coverage but a script run by hand. `close-night.test.ts` now kills the
  // unbounded version in 14ms with no database.
  const { from, to } = nightWindow();

  const { data: stale, error } = await admin
    .from("games")
    .select("id")
    .eq("status", "in_progress")
    .eq("is_draft", false)
    // ⛔ BOUNDED AT BOTH ENDS — THE NIGHT THAT JUST ENDED, AND ONLY THAT NIGHT.
    //
    // An earlier version had no lower bound and so selected EVERY `in_progress`
    // game ever recorded. That is not a stale-data nuisance, it silently undoes
    // the app's only undo: `reopenGameById` puts a past-dated game back to
    // `in_progress`, and it has two callers — the scoresheet's Reopen button and
    // `audit.ts`'s revert of a wrong `finalize_game`. A manager who corrected a
    // mistaken finalize would find it re-finalized by the next 06:00 sweep, with
    // a fresh audit entry attributed to nobody. The documented way to fix a bad
    // finalize would have survived less than a day.
    //
    // ⚠️ THE COST OF THE BOUND, STATED: a game left open for MORE than one night
    // is never swept. That is deliberate — closing a game days later would
    // recompute standings from a half-entered roster with no one watching. A
    // backlog is a thing to surface to a manager, not to silently finalize.
    .gte("scheduled_at", from)
    .lt("scheduled_at", to)
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

  // ⚠️ A run where everything failed must not report 200: Vercel's cron
  // monitoring watches the status, and a silent nightly failure is exactly what
  // this job exists to prevent elsewhere.
  // ⚠️ THE WINDOW IS IN THE RESPONSE ON PURPOSE. Vercel's cron log shows the body,
  // so a run that closed nothing says WHICH night it looked at rather than leaving
  // you to guess between "no stale games" and "the window is wrong". It is also
  // what lets `verify-close-night.mjs` place its fixture inside the real window
  // instead of keeping a second copy of this date arithmetic — the copy would be
  // free to drift from the code it is meant to be checking.
  return NextResponse.json(
    { closed: closed.length, failed: failed.length, from, to },
    { status: failed.length > 0 && closed.length === 0 ? 500 : 200 },
  );
}
