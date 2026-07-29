import { getTeamFeedGames } from "@/lib/queries/schedule";
import { buildIcs, type IcsGame } from "@/lib/export/ics";
import { isExportableFixture } from "@/lib/export/fixtures";
import { isUuid } from "@/lib/db/uuid";

// Stable subscription feed for a team (webcal://…/feed.ics). Cacheable.
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ teamId: string }> },
) {
  const { teamId } = await params;
  // The helper re-checks this, but only the route can turn a bad id into a 404
  // rather than an empty feed.
  if (!isUuid(teamId)) return new Response("Not found", { status: 404 });

  const games = await getTeamFeedGames(teamId);
  const ics = buildIcs(
    games
      .filter((g) => isExportableFixture(g.status))
      .map(
        (g): IcsGame => ({
          id: g.id,
          scheduled_at: g.scheduled_at,
          status: g.status,
          home: g.home_team?.name ?? "Home",
          away: g.away_team?.name ?? "Away",
          home_goals: g.home_goals,
          away_goals: g.away_goals,
        }),
      ),
    "OBHL Team Schedule",
  );

  return new Response(ics, {
    headers: {
      "Content-Type": "text/calendar; charset=utf-8",
      "Cache-Control": "public, max-age=3600",
    },
  });
}
