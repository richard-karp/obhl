import Link from "next/link";
import { TeamLogo } from "@/components/shared/team-logo";
import { GameStatusBadge } from "@/components/shared/game-status-badge";
import { Badge } from "@/components/ui/badge";
import { formatGameDate, formatGameTime } from "@/lib/format";
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

export function GameRow({ game }: { game: GameWithTeams }) {
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
      </div>
      <GameStatusBadge status={game.status} />
    </div>
  );

  return final ? (
    <Link href={`/games/${game.id}`} className="block">
      {body}
    </Link>
  ) : (
    body
  );
}
