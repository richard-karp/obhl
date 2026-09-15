import { type NextRequest } from "next/server";
import { getSchedule } from "@/lib/queries/schedule";
import { getEnrolledTeamBySlug } from "@/lib/queries/teams";
import { buildScheduleCsv, type CsvGame } from "@/lib/export/csv";
import { isExportableFixture } from "@/lib/export/fixtures";
import { exportFilename } from "@/lib/export/filename";
import { isUuid } from "@/lib/db/uuid";
import { publicLeagueOfSeason } from "@/lib/league/current";

/** One-time spreadsheet download of a season, or of one team's games with `?team=<slug>`. */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ seasonId: string }> },
) {
  const { seasonId } = await params;
  // A malformed id would otherwise download a header-only file that looks like an empty season.
  if (!isUuid(seasonId)) return new Response("Not found", { status: 404 });

  // ⛔ An unresolved slug is a 404, never "no filter", tested `=== null` since a bare `?team=` is `""`
  // (`RUNBOOK.md` → Schedule edits and exports). The sibling `.ics` route does the same.
  const teamSlug = request.nextUrl.searchParams.get("team");
  const team =
    teamSlug === null ? null : await getEnrolledTeamBySlug(seasonId, teamSlug);
  if (teamSlug !== null && !team)
    return new Response("Not found", { status: 404 });

  const [games, league] = await Promise.all([
    getSchedule(seasonId, { teamId: team?.id }),
    publicLeagueOfSeason(seasonId),
  ]);
  // ⚠️ A well-formed unknown id is a 404 too. A null league covers both "no such season" and "not
  // yours to read"; see the sibling `.ics` route.
  if (!league) return new Response("Not found", { status: 404 });
  const csv = buildScheduleCsv(
    games
      .filter((g) => isExportableFixture(g.status))
      .map((g): CsvGame => ({
        scheduled_at: g.scheduled_at,
        home: g.home_team?.name ?? "Home",
        away: g.away_team?.name ?? "Away",
      })),
  );

  return new Response(csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      // No CSV column names the team, so the filename is the only place a filtered file says whose.
      "Content-Disposition": `attachment; filename="${exportFilename(league.slug, team?.slug, "csv")}"`,
    },
  });
}
