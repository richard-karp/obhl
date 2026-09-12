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
import {
  cancelGame,
  postponeGame,
  restoreGame,
  generateGameRecap,
} from "@/lib/actions/games";
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
       ai_recap,
       home_team:teams!games_home_team_id_fkey(id, name, color, logo_path, logo_text_color),
       away_team:teams!games_away_team_id_fkey(id, name, color, logo_path, logo_text_color)`,
    )
    .eq("id", gameId)
    .maybeSingle();
  // The id says nothing about which league it belongs to, so the slug in the
  // URL is the only claim of ownership — enforce it rather than trust it.
  if (!game || game.season.league_id !== league.id) notFound();

  // ⛔ A SCOREKEEPER MAY ONLY OPEN TODAY'S GAMES.
  //
  // Managers and captains are untouched: a captain sets a dressed lineup from
  // their own dashboard, and a manager is the escape hatch for a game still
  // being entered after midnight — which the strict calendar day guarantees will
  // happen, given the last slot starts at 9:40pm.
  //
  // ⚠️ THIS IS AN APP-LEVEL RULE AND NOTHING BELOW IT ENFORCES THE SAME THING.
  // RLS still lets a scorekeeper's own session update any game in a league they
  // belong to, bounded by `0046`'s trigger to the scoring columns. So this
  // refuses the PAGE, not the write — deliberately, and recorded in
  // `ACCESS_CONTROL_HANDOFF.md` so nobody mistakes it for the usual
  // guard-plus-policy pair this codebase writes.
  //
  // ⚠️ Refused to `/tonight`, NOT to `/` like every other guard here.
  // This one fires at 12:01am on a game somebody was halfway through, and a
  // silent bounce to a league picker is indistinguishable from a broken app —
  // the same symptom that already cost this project a full round of
  // misdiagnosis. Their own page, with tonight's date in its header, at least
  // says what happened.
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
  //
  // ⛔ THE THIRD READ THAT USED TO BE HERE IS GONE WITH ITS TABLE (0049).
  // `team_goalie_days` was queried for this game's weekday to find the night's
  // starter; the night now rides on the roster row above, so the answer comes
  // out of data already in hand.
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
    // ⛔ SKATERS ONLY. The goalie is not a checkbox here — who is in net is
    // decided in the goalie section below, and `setGoalie` dresses whoever is
    // chosen. Leaving them in meant two controls owning one fact, and a
    // scorekeeper could dress a goalie who was not playing or vice versa.
    //
    // ⚠️ `setLineup` KNOWS ABOUT THIS. It reconciles the dressed set against
    // what the form submits, so goalies — now never submitted — would be deleted
    // on the next save. It excludes them explicitly; the two changes only work
    // as a pair.
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
    // ⛔ THE RULE LIVES IN `suggestGoalie`, NOT HERE, and it is tested there —
    // including the case this page cannot reach in a fixture, two goalies
    // sharing a night. It replaced `dayGoalie ?? defaultGoalie`, which read a
    // per-weekday table and a per-team flag that 0049 dropped.
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
  // One board for a captain who cannot score, both for anyone who can. Manager
  // write access is a superset of a captain's, so a manager who also captains a
  // team still gets the whole sheet.
  const boards =
    !canScore && captainTeamId
      ? allBoards.filter((b) => b.id === captainTeamId)
      : allBoards;

  /**
   * What `finalizeGame` refused over, recomputed for display.
   *
   * ⛔ THE ACTION IS THE GATE; THIS ONLY EXPLAINS IT. Both sides call
   * `scoresheetProblems`, so they share the RULE — but not its inputs, and the
   * difference is worth knowing rather than being asserted away:
   *
   * ⚠️ THE GOALIE POOL HERE IS SMALLER THAN THE ACTION'S. `roster` above is
   * read with `.is("left_on", null)` because the goalie BUTTONS must not offer
   * a departed player; `scoresheetGaps` applies no such filter, and neither
   * does `v_goalie_stats`, whose fallback joins `team_players` unfiltered. So a
   * team whose only dressed goalie has since left the roster counts for the
   * action and not for this page.
   *
   * ✅ The direction is the safe one, and only one direction is safe. This page
   * can only ever over-report, which at worst names a problem the action was
   * content with. The reverse — the action refusing while this page finds
   * nothing — would render no banner and no `confirm=1`, and the next press
   * would be refused again: a loop. That cannot happen while this set is a
   * subset of the action's, which is the invariant to preserve if either read
   * changes.
   *
   * ⚠️ `allBoards`, not `boards`. A captain sees only their own side, and the
   * warning is about the game.
   *
   * ⚠️ AND ONLY WHILE THE GAME IS NOT FINAL. Completing anyway does not fix the
   * problems, and the URL keeps `?incomplete=1` across the successful submit —
   * testing the problem list instead of the status would leave the banner up
   * for good on exactly the games it fired for.
   */
  const problems =
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

      {/*
        ⛔ `canManage`, NOT `canScore`. Changed 2026-09-07 with the guards in
        `games.ts`: cancel, postpone, restore and reschedule are the manager's
        alone now, and a scorekeeper who can still see the buttons would be
        reading a refusal as a broken app rather than a permission. The card is
        about whether a game HAPPENS; the scoresheet below is about what
        happened in it, and that stays the scorekeeper's.
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
              Says the rule BEFORE the refusal does. A scheduled game may only
              be retimed within its own night — moving it to another night would
              change that night's game count, which the schedule treats as
              non-negotiable. A postponed game has no night to stay on, so it
              may go anywhere.
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
