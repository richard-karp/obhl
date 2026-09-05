import Link from "next/link";
import { Button } from "@/components/ui/button";
import { TeamLogo } from "@/components/shared/team-logo";
import { GameStatusBadge } from "@/components/shared/game-status-badge";
import { Badge } from "@/components/ui/badge";
import {
  formatGameDate,
  formatGameDateTime,
  formatGameTime,
} from "@/lib/format";
import { cn } from "@/lib/utils";
import type { GameWithTeams } from "@/lib/queries/schedule";

function TeamLine({
  team,
  score,
  winner,
  showScore,
}: {
  team: GameWithTeams["home_team"];
  score: number;
  winner: boolean;
  showScore: boolean;
}) {
  return (
    <div className="flex items-center justify-between gap-2">
      <span className="flex min-w-0 items-center gap-2">
        <TeamLogo name={team?.name ?? "TBD"} color={team?.color} />
        <span className={cn("truncate", winner && "font-semibold")}>
          {team?.name ?? "TBD"}
        </span>
      </span>
      {showScore ? (
        <span
          className={cn(
            "tabular-nums",
            winner ? "font-bold" : "text-muted-foreground",
          )}
        >
          {score}
        </span>
      ) : null}
    </div>
  );
}

/**
 * The word on the button, which is the only thing that changes with status: a
 * finished game is being corrected, a cancelled or postponed one is being
 * managed back into shape, and everything else is being scored. Lifted verbatim
 * from the `/manage/score` table this row absorbed.
 */
function scoreLabel(status: GameWithTeams["status"]) {
  if (status === "final") return "Edit";
  if (status === "cancelled" || status === "postponed") return "Manage";
  return "Score";
}

export function GameRow({
  game,
  league,
  /**
   * Where this game's scoresheet is, for a viewer entitled to open one. Absent
   * for everybody else, which is every anonymous visitor — the row is then
   * exactly what it was before this page absorbed the scorekeeper's list.
   *
   * ⛔ A href, not a boolean: the button has to sit OUTSIDE the row's own link,
   * or a finished game nests one anchor inside another. That is invalid HTML,
   * and browsers recover from it by splitting the outer link — which would have
   * broken the box-score link this row has always had.
   */
  scoreHref,
}: {
  game: GameWithTeams;
  league: string;
  scoreHref?: string;
}) {
  const final = game.status === "final";
  const homeWin = final && game.home_goals > game.away_goals;
  const awayWin = final && game.away_goals > game.home_goals;

  const body = (
    <div className="hover:bg-muted/40 flex items-center gap-3 rounded-lg border p-3 transition-colors">
      <div className="text-muted-foreground w-16 shrink-0 text-xs">
        <div>{formatGameDate(game.scheduled_at)}</div>
        <div>{formatGameTime(game.scheduled_at)}</div>
      </div>
      <div className="min-w-0 flex-1 space-y-1 text-sm">
        {game.label ? (
          <Badge className="mb-0.5 px-1.5 py-0 text-[0.65rem] uppercase">
            {game.label}
          </Badge>
        ) : null}
        <TeamLine
          team={game.away_team}
          score={game.away_goals}
          winner={awayWin}
          showScore={final}
        />
        <TeamLine
          team={game.home_team}
          score={game.home_goals}
          winner={homeWin}
          showScore={final}
        />
        {game.postponed_from ? (
          // Postponing clears the date, so without this the game reads only as
          // "TBD" and when it was meant to be played is invisible.
          <p className="text-muted-foreground text-xs">
            Postponed from {formatGameDateTime(game.postponed_from)}
          </p>
        ) : null}
      </div>
      <GameStatusBadge status={game.status} />
    </div>
  );

  const row = final ? (
    <Link href={`/${league}/games/${game.id}`} className="block">
      {body}
    </Link>
  ) : (
    body
  );

  if (!scoreHref) return row;

  return (
    <div className="flex items-center gap-2">
      <div className="min-w-0 flex-1">{row}</div>
      <Button
        asChild
        size="sm"
        variant={
          game.status === "scheduled" || game.status === "in_progress"
            ? "default"
            : "outline"
        }
      >
        <Link href={scoreHref}>{scoreLabel(game.status)}</Link>
      </Button>
    </div>
  );
}
