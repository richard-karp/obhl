import { notFound } from "next/navigation";
import { requireLeagueRole } from "@/lib/auth/guards";
import { createClient } from "@/utils/supabase/server";
import { resolveLeagueBySlug } from "@/lib/league/current";
import {
  ScoreBoard,
  type ScoreBoardData,
  type TeamBoard,
  type DressedLine,
} from "@/components/manage/score-board";
import {
  cancelGame,
  postponeGame,
  restoreGame,
  rescheduleGame,
  generateGameRecap,
} from "@/lib/actions/games";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { GameStatusBadge } from "@/components/shared/game-status-badge";
import { PageHeader } from "@/components/shared/page-header";
import { formatGameDateTime, leagueWeekday } from "@/lib/format";

/* eslint-disable @typescript-eslint/no-explicit-any */
const byNumber = (a: { number: number | null }, b: { number: number | null }) =>
  (a.number ?? 999) - (b.number ?? 999);

export default async function ScoreGamePage({
  params,
}: {
  params: Promise<{ league: string; gameId: string }>;
}) {
  const { league: leagueSlug, gameId } = await params;
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
       ai_recap,
       home_team:teams!games_home_team_id_fkey(id, name, color),
       away_team:teams!games_away_team_id_fkey(id, name, color)`,
    )
    .eq("id", gameId)
    .maybeSingle();
  // The id says nothing about which league it belongs to, so the slug in the
  // URL is the only claim of ownership — enforce it rather than trust it.
  if (!game || game.season.league_id !== league.id) notFound();

  const homeT = game.home_team as any;
  const awayT = game.away_team as any;

  // Which day's goalie defaults apply, in the league zone like everything else.
  const gameDay = leagueWeekday(game.scheduled_at);

  // Scorekeepers identify players by number only — no names are fetched.
  const [{ data: roster }, { data: dressed }, { data: goalieDays }] =
    await Promise.all([
      supabase
        .from("team_players")
        .select(
          "player_id, team_id, jersey_number, position, is_default_goalie",
        )
        .eq("season_id", game.season_id)
        .in("team_id", [homeT.id, awayT.id])
        // Only players still on these teams can be dressed for this game.
        .is("left_on", null)
        .order("jersey_number", { ascending: true }),
      supabase
        .from("game_rosters")
        .select("id, player_id, team_id, goals, assists, pim, is_substitute")
        .eq("game_id", gameId),
      supabase
        .from("team_goalie_days")
        .select("team_id, player_id")
        .eq("season_id", game.season_id)
        .in("team_id", [homeT.id, awayT.id])
        .eq("day_of_week", gameDay),
    ]);

  const numberOf = new Map<string, number | null>();
  for (const r of roster ?? []) numberOf.set(r.player_id, r.jersey_number);

  // Derived from the player link, not from `role === "captain"`. A person can
  // be a manager and captain a team at once; keyed on the role, promoting a
  // captain to manager silently took their captain surface away.
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
      // A transfer clears is_captain on the old row, and 0038 makes RLS agree,
      // but this read has its own reason to filter: without it a captain who
      // moved teams matches two rows and `maybeSingle()` returns an error and
      // no team, silently taking the scoresheet away from a real captain.
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
    const rosterChecks = (roster ?? [])
      .filter((r) => r.team_id === t.id)
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
        isDefault: !!(r as any).is_default_goalie,
      }))
      .sort(byNumber);
    const dayGoalie = (goalieDays ?? []).find((d: any) => d.team_id === t.id);
    const defaultGoalie = goalies.find((g) => g.isDefault);
    const suggestedGoalieId =
      dayGoalie?.player_id ?? defaultGoalie?.playerId ?? null;
    return {
      id: t.id,
      side,
      name: t.name,
      color: t.color,
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
  // One board for a captain who cannot score, both for anyone who can. Manager
  // write access is a superset of a captain's, so a manager who also captains a
  // team still gets the whole sheet.
  const boards =
    !canScore && captainTeamId
      ? allBoards.filter((b) => b.id === captainTeamId)
      : allBoards;

  const data: ScoreBoardData = {
    gameId,
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

      {canManage && game.status === "final" && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">AI Game Recap</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {game.ai_recap ? (
              <p className="text-muted-foreground text-sm leading-relaxed italic">
                &ldquo;{game.ai_recap}&rdquo;
              </p>
            ) : (
              <p className="text-muted-foreground text-sm">
                No recap generated yet.
              </p>
            )}
            <form action={generateGameRecap}>
              <input type="hidden" name="game_id" value={gameId} />
              <Button type="submit" size="sm" variant="secondary">
                {game.ai_recap ? "Regenerate Recap" : "Generate Recap"}
              </Button>
            </form>
          </CardContent>
        </Card>
      )}

      {canScore && game.status !== "final" ? (
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

            <form
              action={rescheduleGame}
              className="flex flex-wrap items-end gap-2"
            >
              <input type="hidden" name="game_id" value={gameId} />
              <div className="space-y-1">
                <Label htmlFor="scheduled_at">Reschedule to</Label>
                <Input
                  id="scheduled_at"
                  name="scheduled_at"
                  type="datetime-local"
                  className="w-56"
                />
              </div>
              <Button type="submit" size="sm" variant="secondary">
                Reschedule
              </Button>
            </form>
            <p className="text-muted-foreground text-xs">
              Cancelled games drop out of the schedule and standings. Postponed
              games show as TBD until you reschedule them.
            </p>
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}
/* eslint-enable @typescript-eslint/no-explicit-any */
