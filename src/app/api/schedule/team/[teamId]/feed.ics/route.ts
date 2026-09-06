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
  // ⚠️ THIS ONE IS A SUBSCRIPTION, AND THE 404 IS STILL THE RIGHT ANSWER.
  // A calendar app polls this URL for as long as anyone keeps it, so unlike the
  // season exports the change is visible to a real person: where they used to
  // get a valid, permanently empty calendar, they now get a feed error. That is
  // the honest outcome — the team is gone, and an empty calendar that never
  // says so is indistinguishable from a season with no games left.
  //
  // Same null as the sibling routes, covering both "no such team" and "not
  // yours to read", and read through the ordinary RLS client so a staged
  // league's own members keep their feed (0042/0043).
  if (!league) return new Response("Not found", { status: 404 });
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
    league ? `${league.name} — Team Schedule` : "Team Schedule",
  );

  return new Response(ics, {
    headers: {
      "Content-Type": "text/calendar; charset=utf-8",
      "Cache-Control": "public, max-age=3600",
    },
  });
}
