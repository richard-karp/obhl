import { getSchedule } from "@/lib/queries/schedule";
import { buildScheduleCsv, type CsvGame } from "@/lib/export/csv";
import { isExportableFixture } from "@/lib/export/fixtures";
import { isUuid } from "@/lib/db/uuid";
import { publicLeagueOfSeason } from "@/lib/league/current";

/** The season's fixtures as a spreadsheet. One-time download, not a feed. */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ seasonId: string }> },
) {
  const { seasonId } = await params;
  // Without this a malformed id makes Postgres reject the comparison,
  // `getSchedule` logs and returns [], and the caller downloads a header-only
  // file that looks like a real but empty season.
  if (!isUuid(seasonId)) return new Response("Not found", { status: 404 });

  const [games, league] = await Promise.all([
    getSchedule(seasonId),
    publicLeagueOfSeason(seasonId),
  ]);
  // ⚠️ The comment above describes a header-only file that "looks like a real
  // but empty season" and calls it worth a 404 — and an unknown-but-well-formed
  // id produced exactly that, with a 200 on it, until this line. Same guard,
  // same reason, one case later. See the sibling `.ics` route for why a null
  // league covers both "no such season" and "not yours to read".
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
      "Content-Disposition": `attachment; filename="${league?.slug ?? "schedule"}-schedule.csv"`,
    },
  });
}
