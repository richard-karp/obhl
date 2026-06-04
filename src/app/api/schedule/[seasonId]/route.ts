import { createClient } from "@/utils/supabase/server";
import { buildIcs, type IcsGame } from "@/lib/schedule/ics";

/* eslint-disable @typescript-eslint/no-explicit-any */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ seasonId: string }> },
) {
  const { seasonId } = await params;
  const supabase = await createClient();
  const { data: games } = await supabase
    .from("games")
    .select(
      `id, scheduled_at, status, home_goals, away_goals,
       home:teams!games_home_team_id_fkey(name),
       away:teams!games_away_team_id_fkey(name)`,
    )
    .eq("season_id", seasonId)
    .eq("is_draft", false)
    .order("scheduled_at", { ascending: true });

  const ics = buildIcs(
    (games ?? []).map(
      (g: any): IcsGame => ({
        id: g.id,
        scheduled_at: g.scheduled_at,
        status: g.status,
        home: g.home?.name ?? "Home",
        away: g.away?.name ?? "Away",
        home_goals: g.home_goals,
        away_goals: g.away_goals,
      }),
    ),
    "OBHL Schedule",
  );

  return new Response(ics, {
    headers: {
      "Content-Type": "text/calendar; charset=utf-8",
      "Content-Disposition": 'attachment; filename="obhl-schedule.ics"',
    },
  });
}
