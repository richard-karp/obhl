import { notFound, redirect } from "next/navigation";
import { requireLeagueRole } from "@/lib/auth/guards";
import { createClient } from "@/utils/supabase/server";
import { resolveLeagueBySlug } from "@/lib/league/current";
import {
  ScoreBoard,
  type ScoreBoardData,
  type TeamBoard,
  type DressedLine,
} from "@/components/manage/score-board";
import { cancelGame, postponeGame, restoreGame } from "@/lib/actions/games";
import { RescheduleForm } from "@/components/manage/reschedule-form";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { GameStatusBadge } from "@/components/shared/game-status-badge";
import { PageHeader } from "@/components/shared/page-header";
import {
  formatGameDateTime,
  isOnLeagueDate,
  leagueToday,
  leagueWeekday,
} from "@/lib/format";
import { suggestGoalie } from "@/lib/goalie/suggest";
import { scoresheetProblems } from "@/lib/games/incomplete";

/* eslint-disable @typescript-eslint/no-explicit-any */
const byNumber = (a: { number: number | null }, b: { number: number | null }) =>
  (a.number ?? 999) - (b.number ?? 999);

export default async function ScoreGamePage({
  params,
  searchParams,
}: {
  params: Promise<{ league: string; gameId: string }>;
  /** `?incomplete=1` — `finalizeGame` bounced a sheet that is missing something. */
  searchParams: Promise<{ incomplete?: string }>;
}) {
  const { league: leagueSlug, gameId } = await params;
  const { incomplete } = await searchParams;
  const league = await resolveLeagueBySlug(leagueSlug);
  if (!league) notFound();
  const user = await requireLeagueRole(
    league.id,
    "captain",
    "scorekeeper",
    "league_manager",
  );
  const supabase = await createClient();

  const { data: game } = await supabase
    .from("games")
    .select(
      `id, status, scheduled_at, home_goals, away_goals, finalized_at, season_id,
       season:seasons!inner(league_id),
       home_goalie_id, away_goalie_id,
       home_goalie_is_sub, away_goalie_is_sub,
       home_empty_net_against, away_empty_net_against,
       home_team:teams!games_home_team_id_fkey(id, name, color, logo_path, logo_text_color),
       away_team:teams!games_away_team_id_fkey(id, name, color, logo_path, logo_text_color)`,
    )
    .eq("id", gameId)
    .maybeSingle();
  // The id says nothing about which league it belongs to, so the slug in the
  // URL is the only claim of ownership — enforce it rather than trust it.
  if (!game || game.season.league_id !== league.id) notFound();

  // ⛔ Only a scorekeeper is held to today (a manager is the after-midnight escape hatch), and only here:
  // no RLS half, on purpose (`RUNBOOK.md` → Access control → Scorekeeper day rule). To `/tonight`, not `/`.
  if (
    user.role === "scorekeeper" &&
    !isOnLeagueDate(game.scheduled_at, leagueToday())
  ) {
    redirect("/tonight");
  }

  const homeT = game.home_team as any;
  const awayT = game.away_team as any;

  // Which day's goalie defaults apply, in the league zone like everything else.
  const gameDay = leagueWeekday(game.scheduled_at);

  // Scorekeepers identify players by number only — no names are fetched.
  const [{ data: roster }, { data: dressed }] = await Promise.all([
    supabase
      .from("team_players")
      .select("player_id, team_id, jersey_number, position, night_of_week")
      .eq("season_id", game.season_id)
      .in("team_id", [homeT.id, awayT.id])
      // Only players still on these teams can be dressed for this game.
      .is("left_on", null)
      .order("jersey_number", { ascending: true }),
    supabase
      .from("game_rosters")
      .select("id, player_id, team_id, goals, assists, pim, is_substitute")
      .eq("game_id", gameId),
  ]);

  const numberOf = new Map<string, number | null>();
  for (const r of roster ?? []) numberOf.set(r.player_id, r.jersey_number);

  // From the player link, not `role === "captain"`: a manager can captain a team too, and keyed on the
  // role a promotion silently took their captain surface away.
  let captainTeamId: string | null = null;
  const { data: prof } = await supabase
    .from("profiles")
    .select("player_id")
    .eq("id", user.id)
    .maybeSingle();
  if (prof?.player_id) {
    const { data: tp } = await supabase
      .from("team_players")
      .select("team_id")
      .eq("player_id", prof.player_id)
      .eq("is_captain", true)
      .eq("season_id", game.season_id)
      // Without it a captain who moved teams matches two rows, and `maybeSingle()` errors and silently
      // takes the scoresheet away from a real captain.
      .is("left_on", null)
      .maybeSingle();
    captainTeamId = tp?.team_id ?? null;
  }

  const buildBoard = (t: any): TeamBoard => {
    const side: "home" | "away" = t.id === homeT.id ? "home" : "away";
    const dressedRows = (dressed ?? []).filter((d) => d.team_id === t.id);
    const dressedSet = new Set(dressedRows.map((d) => d.player_id));
    const lines: DressedLine[] = dressedRows
      .map((d) => ({
        rosterId: d.id,
        playerId: d.player_id,
        isSub: d.is_substitute,
        number: numberOf.get(d.player_id ?? "") ?? null,
        goals: d.goals ?? 0,
        assists: d.assists ?? 0,
        pim: d.pim ?? 0,
      }))
      .sort(byNumber);
    // ⛔ Skaters only: the goalie section and `setGoalie` own who is in net. `setLineup` excludes goalies to
    // match, or the next save deletes them; the two change only as a pair.
    const rosterChecks = (roster ?? [])
      .filter((r) => r.team_id === t.id && (r as any).position !== "G")
      .map((r) => ({
        playerId: r.player_id,
        number: r.jersey_number,
        dressed: dressedSet.has(r.player_id),
      }))
      .sort(byNumber);
    const goalies = (roster ?? [])
      .filter((r) => r.team_id === t.id && (r as any).position === "G")
      .map((r) => ({
        playerId: r.player_id,
        number: r.jersey_number,
        night: (r as any).night_of_week as number | null,
      }))
      .sort(byNumber);
    // ⛔ The rule lives in `suggestGoalie`, not here, where it is tested (two goalies sharing a night).
    const suggestedGoalieId = suggestGoalie(goalies, gameDay);
    return {
      id: t.id,
      side,
      name: t.name,
      color: t.color,
      logoPath: t.logo_path ?? null,
      logoTextColor: t.logo_text_color ?? null,
      dressed: lines,
      roster: rosterChecks,
      goalies,
      suggestedGoalieId,
      goalieId: side === "home" ? game.home_goalie_id : game.away_goalie_id,
      goalieIsSub:
        side === "home" ? game.home_goalie_is_sub : game.away_goalie_is_sub,
      emptyNetAgainst:
        side === "home"
          ? game.home_empty_net_against
          : game.away_empty_net_against,
    };
  };

  const canScore =
    user.role === "scorekeeper" || user.role === "league_manager";
  const canManage = user.role === "league_manager";
  const allBoards = [buildBoard(awayT), buildBoard(homeT)];
  const score = (b: TeamBoard) => b.dressed.reduce((s, l) => s + l.goals, 0);
  // One board for a captain who cannot score, both for anyone who can: a manager who captains gets the
  // whole sheet.
  const boards =
    !canScore && captainTeamId
      ? allBoards.filter((b) => b.id === captainTeamId)
      : allBoards;

  // ⛔ `finalizeGame` is the gate; this only explains it. This goalie pool (`left_on` null) must stay a
  // subset of the action's, or the action refuses while no banner shows: a loop.
  const problems =
    // ⚠️ Not once final: `?incomplete=1` survives the successful submit. `allBoards`: it is about the game.
    incomplete === "1" && game.status !== "final"
      ? scoresheetProblems(
          allBoards.map((b) => ({
            teamName: b.name,
            dressedCount: b.dressed.length,
            goalieId: b.goalieId,
            goalieIsSub: b.goalieIsSub,
            dressedGoalieIds: b.dressed
              .map((l) => l.playerId)
              .filter(
                (id): id is string =>
                  !!id && b.goalies.some((g) => g.playerId === id),
              ),
          })),
        )
      : [];

  const data: ScoreBoardData = {
    gameId,
    problems,
    status: game.status,
    finalized: !!game.finalized_at,
    awayName: awayT.name,
    homeName: homeT.name,
    awayId: awayT.id,
    homeId: homeT.id,
    awayScore: score(allBoards[0]),
    homeScore: score(allBoards[1]),
    boards,
    canScore,
    canManage,
    captainTeamId,
  };

  const isCancelledOrPostponed =
    game.status === "cancelled" || game.status === "postponed";

  return (
    <div className="space-y-6">
      <PageHeader
        title={`${awayT.name} @ ${homeT.name}`}
        description={formatGameDateTime(game.scheduled_at)}
      />
      <ScoreBoard data={data} />

      {/*
        ⛔ `canManage`, not `canScore`: cancel, postpone, restore and reschedule are the manager's alone
        (`games.ts`), and a scorekeeper shown them reads the refusal as a broken app.
      */}
      {canManage && game.status !== "final" ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Game status</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex flex-wrap items-center gap-2">
              <GameStatusBadge status={game.status} />
              {game.status !== "cancelled" ? (
                <form action={cancelGame}>
                  <input type="hidden" name="game_id" value={gameId} />
                  <Button type="submit" variant="outline" size="sm">
                    Cancel game
                  </Button>
                </form>
              ) : null}
              {game.status !== "postponed" ? (
                <form action={postponeGame}>
                  <input type="hidden" name="game_id" value={gameId} />
                  <Button type="submit" variant="outline" size="sm">
                    Postpone
                  </Button>
                </form>
              ) : null}
              {isCancelledOrPostponed ? (
                <form action={restoreGame}>
                  <input type="hidden" name="game_id" value={gameId} />
                  <Button type="submit" variant="secondary" size="sm">
                    Restore to scheduled
                  </Button>
                </form>
              ) : null}
            </div>

            <RescheduleForm gameId={gameId} />
            <p className="text-muted-foreground text-xs">
              Cancelled games drop out of the schedule and standings. Postponed
              games show as TBD until you reschedule them.
            </p>
            {/*
              States the rule before the refusal does: a scheduled game stays on its night (game counts per
              night never move); a postponed game has no night, so it may go anywhere.
            */}
            <p className="text-muted-foreground text-xs">
              {game.status === "postponed"
                ? "This game is postponed, so it can be rescheduled to any night."
                : "A scheduled game can only be moved to another time on the same night. To move it to a different night, trade nights with another game from the Games page."}
            </p>
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}
/* eslint-enable @typescript-eslint/no-explicit-any */
