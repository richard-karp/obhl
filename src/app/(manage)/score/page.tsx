import Link from "next/link";
import { requireRole } from "@/lib/auth/guards";
import { getActiveContext } from "@/lib/queries/season";
import { getSchedule } from "@/lib/queries/schedule";
import { GameStatusBadge } from "@/components/shared/game-status-badge";
import { TeamLogo } from "@/components/shared/team-logo";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Button } from "@/components/ui/button";
import { PageHeader } from "@/components/shared/page-header";
import { EmptyState } from "@/components/shared/empty-state";
import { formatGameDateTime } from "@/lib/format";

export default async function ScoreGamesPage() {
  await requireRole("scorekeeper", "league_manager");
  const ctx = await getActiveContext();
  if (!ctx?.season) {
    return <EmptyState title="No active season" />;
  }
  const games = await getSchedule(ctx.season.id);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Games"
        description="Open a game to set rosters, record scoring, and finalize."
      />
      {games.length === 0 ? (
        <EmptyState title="No games scheduled" />
      ) : (
        <div className="overflow-hidden rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow className="bg-muted/40">
                <TableHead>When</TableHead>
                <TableHead>Matchup</TableHead>
                <TableHead className="text-center">Score</TableHead>
                <TableHead></TableHead>
                <TableHead className="text-right"></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {games.map((g) => (
                <TableRow key={g.id}>
                  <TableCell className="text-muted-foreground text-sm">
                    {formatGameDateTime(g.scheduled_at)}
                  </TableCell>
                  <TableCell>
                    <span className="flex items-center gap-1.5 text-sm">
                      <TeamLogo name={g.away_team?.name ?? "TBD"} color={g.away_team?.color} />
                      {g.away_team?.name}
                      <span className="text-muted-foreground mx-1">@</span>
                      <TeamLogo name={g.home_team?.name ?? "TBD"} color={g.home_team?.color} />
                      {g.home_team?.name}
                    </span>
                  </TableCell>
                  <TableCell className="text-center tabular-nums">
                    {g.status === "final" ? `${g.away_goals}–${g.home_goals}` : "—"}
                  </TableCell>
                  <TableCell>
                    <GameStatusBadge status={g.status} />
                  </TableCell>
                  <TableCell className="text-right">
                    <Button
                      asChild
                      size="sm"
                      variant={g.status === "scheduled" || g.status === "in_progress" ? "default" : "outline"}
                    >
                      <Link href={`/score/${g.id}`}>
                        {g.status === "final"
                          ? "Edit"
                          : g.status === "cancelled" || g.status === "postponed"
                            ? "Manage"
                            : "Score"}
                      </Link>
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  );
}
