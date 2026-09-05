import { getSchedule } from "@/lib/queries/schedule";
import { buildIcs, type IcsGame } from "@/lib/export/ics";
import { isExportableFixture } from "@/lib/export/fixtures";
import { isUuid } from "@/lib/db/uuid";
import { publicLeagueOfSeason } from "@/lib/league/current";

/** The season's schedule as a one-time calendar download. */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ seasonId: string }> },
) {
  const { seasonId } = await params;
  if (!isUuid(seasonId)) return new Response("Not found", { status: 404 });

  // The calendar's name and the download's filename are the league's, not the
  // instance's. `buildIcs` already takes the name as an argument — only this
  // route hardcoded it, so every league's feed announced itself as OBHL's.
  const [games, league] = await Promise.all([
    getSchedule(seasonId),
    publicLeagueOfSeason(seasonId),
  ]);
  const ics = buildIcs(
    games
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
    league ? `${league.name} Schedule` : "Schedule",
  );

  return new Response(ics, {
    headers: {
      "Content-Type": "text/calendar; charset=utf-8",
      "Content-Disposition": `attachment; filename="${league?.slug ?? "schedule"}-schedule.ics"`,
    },
  });
}
