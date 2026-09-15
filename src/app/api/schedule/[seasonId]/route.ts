import { type NextRequest } from "next/server";
import { getSchedule } from "@/lib/queries/schedule";
import { getEnrolledTeamBySlug } from "@/lib/queries/teams";
import { buildIcs, type IcsGame } from "@/lib/export/ics";
import { isExportableFixture } from "@/lib/export/fixtures";
import { exportFilename } from "@/lib/export/filename";
import { isUuid } from "@/lib/db/uuid";
import { publicLeagueOfSeason } from "@/lib/league/current";

/** One-time calendar download of a season, or of one team's games with `?team=<slug>`. */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ seasonId: string }> },
) {
  const { seasonId } = await params;
  if (!isUuid(seasonId)) return new Response("Not found", { status: 404 });

  // ⛔ An unresolved slug is a 404, never "no filter", tested `=== null` since a bare `?team=` is `""`
  // (`RUNBOOK.md` → Schedule edits and exports). The sibling `.csv` route does the same.
  const teamSlug = request.nextUrl.searchParams.get("team");
  const team =
    teamSlug === null ? null : await getEnrolledTeamBySlug(seasonId, teamSlug);
  if (teamSlug !== null && !team)
    return new Response("Not found", { status: 404 });

  const [schedule, league] = await Promise.all([
    getSchedule(seasonId, { teamId: team?.id }),
    publicLeagueOfSeason(seasonId),
  ]);
  // ⛔ BEFORE the `!league` check: `publicLeagueOfSeason` is null for a failed read too, so a
  // league-first order would report 404 whenever both reads fail — exactly the case this exists
  // for. The games read is the PAYLOAD, and a payload that failed must not serialise as a valid
  // empty file; the league read is an identity lookup, where 404 already means three things
  // (`RUNBOOK.md` → Schedule edits and exports).
  if (schedule.readFailed) {
    return new Response("Schedule temporarily unavailable", {
      status: 503,
      headers: { "Cache-Control": "no-store" },
    });
  }
  // ⚠️ Null for both "no such season" and "not yours to read", on purpose: through the RLS client a
  // staged league's own members still get their export (0042/0043).
  if (!league) return new Response("Not found", { status: 404 });
  const ics = buildIcs(
    schedule.games
      .filter((g) => isExportableFixture(g.status))
      .map((g): IcsGame => ({
        id: g.id,
        scheduled_at: g.scheduled_at,
        status: g.status,
        home: g.home_team?.name ?? "Home",
        away: g.away_team?.name ?? "Away",
        home_goals: g.home_goals,
        away_goals: g.away_goals,
      })),
    // ⚠️ The team belongs in the calendar's name and the filename: otherwise a filtered file lands in
    // a calendar app indistinguishable from the full season.
    team ? `${league.name} — ${team.name} Schedule` : `${league.name} Schedule`,
  );

  return new Response(ics, {
    headers: {
      "Content-Type": "text/calendar; charset=utf-8",
      "Content-Disposition": `attachment; filename="${exportFilename(league.slug, team?.slug, "ics")}"`,
    },
  });
}
