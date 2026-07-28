import { getSchedule } from "@/lib/queries/schedule";
import { buildScheduleCsv, type CsvGame } from "@/lib/export/csv";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Cancelling or postponing a game changes only its status — `scheduled_at` keeps
// pointing at the original date. With no status column to show it, exporting
// these would assert a game happens on a date it does not.
const WITHHELD = new Set(["cancelled", "postponed"]);

/** The season's fixtures as a spreadsheet. One-time download, not a feed. */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ seasonId: string }> },
) {
  const { seasonId } = await params;
  // Without this a malformed id makes Postgres reject the comparison,
  // `getSchedule` logs and returns [], and the caller downloads a header-only
  // file that looks like a real but empty season.
  if (!UUID.test(seasonId)) return new Response("Not found", { status: 404 });

  const games = await getSchedule(seasonId);
  const csv = buildScheduleCsv(
    games
      .filter((g) => !WITHHELD.has(g.status))
      .map(
        (g): CsvGame => ({
          scheduled_at: g.scheduled_at,
          home: g.home_team?.name ?? "Home",
          away: g.away_team?.name ?? "Away",
        }),
      ),
  );

  return new Response(csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": 'attachment; filename="obhl-schedule.csv"',
    },
  });
}
