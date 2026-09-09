import { type NextRequest } from "next/server";
import { getSchedule } from "@/lib/queries/schedule";
import { getEnrolledTeamBySlug } from "@/lib/queries/teams";
import { buildIcs, type IcsGame } from "@/lib/export/ics";
import { isExportableFixture } from "@/lib/export/fixtures";
import { exportFilename } from "@/lib/export/filename";
import { isUuid } from "@/lib/db/uuid";
import { publicLeagueOfSeason } from "@/lib/league/current";

/**
 * The season's schedule as a one-time calendar download, or one team's if
 * `?team=<slug>` names an enrolled one.
 *
 * The parameter mirrors the schedule page's own `?team=`, so the button is a
 * mechanical copy of the URL the visitor is already looking at.
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ seasonId: string }> },
) {
  const { seasonId } = await params;
  if (!isUuid(seasonId)) return new Response("Not found", { status: 404 });

  // ⛔ AN UNRESOLVED SLUG IS A 404, NOT "no filter". Falling back to the season
  // is the bug this parameter was added to fix: the caller asked for one team
  // and would silently receive every one. Resolved through `season_teams`, so a
  // team of another season or another league is as absent as one that was never
  // real. See the sibling `.csv` route, which does the same.
  //
  // ⚠️ `=== null`, NOT falsiness. `get` answers `""` for a bare `?team=` and
  // `null` only when the parameter is absent, so a truthiness test read an empty
  // one as "no team asked for" and exported the whole season under a 200 — the
  // exact failure above, reachable by typing the URL. Nothing this app renders
  // produces `?team=`, so treating it as a caller error costs no real link.
  const teamSlug = request.nextUrl.searchParams.get("team");
  const team =
    teamSlug === null ? null : await getEnrolledTeamBySlug(seasonId, teamSlug);
  if (teamSlug !== null && !team)
    return new Response("Not found", { status: 404 });

  // The calendar's name and the download's filename are the league's, not the
  // instance's. `buildIcs` already takes the name as an argument — only this
  // route hardcoded it, so every league's feed announced itself as OBHL's.
  const [games, league] = await Promise.all([
    getSchedule(seasonId, { teamId: team?.id }),
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
    // ⚠️ The team belongs in the calendar's NAME and the filename, and this is
    // what makes a filtered download honest. The old button always exported the
    // season precisely because a filtered file could not say so — it landed in a
    // calendar app indistinguishable from the full one. Naming it removes that
    // objection; dropping the name would bring it back.
    team ? `${league.name} — ${team.name} Schedule` : `${league.name} Schedule`,
  );

  return new Response(ics, {
    headers: {
      "Content-Type": "text/calendar; charset=utf-8",
      "Content-Disposition": `attachment; filename="${exportFilename(league.slug, team?.slug, "ics")}"`,
    },
  });
}
