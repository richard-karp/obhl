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

  // Named for the league; the event UIDs stay untouched, since they are subscription identity.
  const [schedule, league] = await Promise.all([
    getTeamFeedGames(teamId),
    publicLeagueOfTeam(teamId),
  ]);
  // ⛔ BEFORE the `!league` check, not after. `publicLeagueOfTeam` returns null for "no such
  // team", "not yours" AND "the read failed", so a league-first order reports 404 whenever both
  // reads fail — and the 503 would be unreachable in the case it exists for.
  //
  // ⛔ AND `no-store`. The success path below caches for an hour; serving a blip under that
  // header is what turns one bad second into an hour of empty calendar in a subscriber's client.
  if (schedule.readFailed) {
    return new Response("Schedule temporarily unavailable", {
      status: 503,
      headers: { "Cache-Control": "no-store" },
    });
  }
  // ⚠️ A subscription, and still a 404: a permanently empty calendar looks like a season with no games
  // left. Null covers "not yours to read" too; staged leagues' members keep their feed (0042/0043).
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
    league ? `${league.name} — Team Schedule` : "Team Schedule",
  );

  return new Response(ics, {
    headers: {
      "Content-Type": "text/calendar; charset=utf-8",
      "Cache-Control": "public, max-age=3600",
    },
  });
}
