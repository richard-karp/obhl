import { getTeamFeedGames } from "@/lib/queries/schedule";
import { buildIcs, type IcsGame } from "@/lib/export/ics";
import { isExportableFixture } from "@/lib/export/fixtures";
import { isUuid } from "@/lib/db/uuid";
import { publicLeagueOfTeam } from "@/lib/league/current";

// Stable subscription feed for a team (webcal://…/feed.ics). Cacheable.
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ teamId: string }> },
) {
  const { teamId } = await params;
  // The helper re-checks this, but only the route can turn a bad id into a 404
  // rather than an empty feed.
  if (!isUuid(teamId)) return new Response("Not found", { status: 404 });

  // Named for the league, so a subscriber with feeds from two of them can tell
  // the calendars apart. The event UIDs are deliberately untouched — they are
  // subscription identity, and EXPORTS_HANDOFF §3 leans on their stability.
  const [games, league] = await Promise.all([
    getTeamFeedGames(teamId),
    publicLeagueOfTeam(teamId),
  ]);
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
    league ? `${league.name} — Team Schedule` : "Team Schedule",
  );

  return new Response(ics, {
    headers: {
      "Content-Type": "text/calendar; charset=utf-8",
      "Cache-Control": "public, max-age=3600",
    },
  });
}
