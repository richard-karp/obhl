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
  // A well-formed id for a season nobody can read is as much a 404 as a
  // malformed one, and until this line it was a 200 carrying an empty calendar
  // named "Schedule" — the generic fallback below is the tell. The lookup is
  // already being made for the calendar's name, so this costs no extra query.
  //
  // ⚠️ `league` is null for BOTH "no such season" and "you may not see it", and
  // that is the wanted behaviour rather than a conflation to tidy up: it reads
  // through the ordinary RLS client, so a staged league's own members still get
  // their export (0042/0043) while everyone else gets the same answer they get
  // for an id that was never real.
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
    league ? `${league.name} Schedule` : "Schedule",
  );

  return new Response(ics, {
    headers: {
      "Content-Type": "text/calendar; charset=utf-8",
      "Content-Disposition": `attachment; filename="${league?.slug ?? "schedule"}-schedule.ics"`,
    },
  });
}
