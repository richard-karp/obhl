import { NextResponse, type NextRequest } from "next/server";
import { createAdminClient } from "@/utils/supabase/admin";
import { finalizeGameById } from "@/lib/games/finalize";
import { isAuthorizedCron, nightWindow } from "@/lib/games/close-night";

// ⛔ Finalizes through `finalizeGameById`, not SQL: a `pg_cron` version would be a second
// definition of "complete", and there is one write path (`RUNBOOK.md` → Schedule edits and exports).

// ⛔ 300 s is Vercel Hobby's ceiling. Hobby crons run once a day, up to 59 min late but never early,
// so `0 6 * * *` stays past league midnight in both DST states (`RUNBOOK.md` → Closing the night).
export const maxDuration = 300;

export async function GET(request: NextRequest) {
  // ⛔ Without `CRON_SECRET` this is a public endpoint that finalizes games; it fails closed. The check
  // and the window live in `close-night.ts`, not inline, so `close-night.test.ts` can cover them.
  if (
    !isAuthorizedCron(
      request.headers.get("authorization"),
      process.env.CRON_SECRET,
    )
  ) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const admin = createAdminClient();
  const { from, to } = nightWindow();

  const { data: stale, error } = await admin
    .from("games")
    .select("id")
    // ⛔ `in_progress` only, never `scheduled`: finalizing a game nobody scored invents a 0-0 result.
    .eq("status", "in_progress")
    .eq("is_draft", false)
    // ⛔ The night that just ended, and only it: unbounded, a game a manager reopened is re-finalized
    // by the next sweep. A game open longer is for a manager to see, never to finalize silently.
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
  // Serial, not `Promise.all`: each finalize writes an audit row and could contend on the same rows.
  for (const id of ids) {
    try {
      // ⛔ The admin client: as `anon` the UPDATE silently matches nothing and a false audit entry
      // lands (`RUNBOOK.md` → Closing the night). The actor is null: a sweep is not a person.
      await finalizeGameById(id, null, admin);
      closed.push(id);
    } catch (e) {
      // One bad game must not leave the rest open until tomorrow's run.
      console.error("close-night: finalize failed", id, e);
      failed.push(id);
    }
  }

  // ⚠️ All-failed must not be a 200: Vercel's cron monitoring watches the status. The window is in
  // the body for the cron log, and so `05-scoring-night` reads it instead of copying the arithmetic.
  return NextResponse.json(
    { closed: closed.length, failed: failed.length, from, to },
    { status: failed.length > 0 && closed.length === 0 ? 500 : 200 },
  );
}
