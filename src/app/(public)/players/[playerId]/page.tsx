import { notFound } from "next/navigation";
import Link from "next/link";
import { getActiveContext } from "@/lib/queries/season";
import {
  getPlayerBio,
  getPlayerSkaterStats,
  getPlayerGoalieStats,
  getPlayerGameLog,
  getPlayerStatsByOpponent,
} from "@/lib/queries/players";
import { TeamLogo } from "@/components/shared/team-logo";
import { PageHeader } from "@/components/shared/page-header";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { EmptyState } from "@/components/shared/empty-state";
import { NoSeason } from "@/components/public/no-season";
import { PlayerGameChart } from "@/components/public/player-game-chart";
import { formatGameDate } from "@/lib/format";

const POS: Record<string, string> = { F: "Forward", D: "Defense", G: "Goalie" };

export default async function PlayerProfilePage({
  params,
}: {
  params: Promise<{ playerId: string }>;
}) {
  const { playerId } = await params;
  const ctx = await getActiveContext();
  if (!ctx?.season) return <NoSeason />;

  const bio = await getPlayerBio(playerId, ctx.season.id);
  if (!bio) notFound();

  const isGoalie = bio.position === "G";

  const [skaterStats, goalieStats, gameLog, byOpponent] = await Promise.all([
    !isGoalie ? getPlayerSkaterStats(playerId, ctx.season.id) : Promise.resolve(null),
    isGoalie ? getPlayerGoalieStats(playerId, ctx.season.id) : Promise.resolve(null),
    !isGoalie ? getPlayerGameLog(playerId, ctx.season.id, 10) : Promise.resolve([]),
    !isGoalie ? getPlayerStatsByOpponent(playerId, ctx.season.id) : Promise.resolve([]),
  ]);

  const fullName = `${bio.first_name} ${bio.last_name}`;

  return (
    <div className="space-y-6">
      <PageHeader title={fullName} description={ctx.season.name} />

      {/* Bio card */}
      <Card>
        <CardContent className="pt-6">
          <div className="flex flex-wrap items-center gap-4">
            <Link href={`/teams/${bio.team_slug}`}>
              <TeamLogo
                name={bio.team_name}
                color={bio.team_color}
                logoPath={bio.team_logo_path}
                className="size-12 text-base"
              />
            </Link>
            <div className="space-y-1">
              <div className="flex flex-wrap items-center gap-2">
                <Link href={`/teams/${bio.team_slug}`} className="font-semibold hover:underline">
                  {bio.team_name}
                </Link>
                {bio.jersey_number != null && (
                  <span className="text-muted-foreground text-sm">#{bio.jersey_number}</span>
                )}
                <span className="text-muted-foreground text-sm">{POS[bio.position] ?? bio.position}</span>
              </div>
              <div className="flex flex-wrap gap-1.5">
                {bio.is_captain && (
                  <Badge variant="secondary" className="px-1.5 py-0 text-[0.65rem]">
                    Captain
                  </Badge>
                )}
                {bio.is_rookie && (
                  <Badge variant="outline" className="px-1.5 py-0 text-[0.65rem]">
                    Rookie
                  </Badge>
                )}
                {bio.is_suspended && (
                  <Badge variant="destructive" className="px-1.5 py-0 text-[0.65rem]">
                    Suspended
                  </Badge>
                )}
                {bio.injury_notes && (
                  <Badge variant="destructive" className="px-1.5 py-0 text-[0.65rem]">
                    Injured
                  </Badge>
                )}
              </div>
              {bio.injury_notes && (
                <p className="text-muted-foreground text-sm">{bio.injury_notes}</p>
              )}
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Season stats */}
      {!isGoalie && skaterStats && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">{ctx.season.name} Stats</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-5 gap-4 text-center">
              {[
                { label: "GP", value: skaterStats.gp ?? 0 },
                { label: "G", value: skaterStats.g ?? 0 },
                { label: "A", value: skaterStats.a ?? 0 },
                { label: "PTS", value: skaterStats.pts ?? 0 },
                { label: "PIM", value: skaterStats.pim ?? 0 },
              ].map(({ label, value }) => (
                <div key={label}>
                  <div className="text-2xl font-bold">{value}</div>
                  <div className="text-muted-foreground text-xs">{label}</div>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      {isGoalie && goalieStats && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">{ctx.season.name} Stats</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-4 gap-4 text-center sm:grid-cols-7">
              {[
                { label: "GP", value: goalieStats.gp ?? 0 },
                { label: "W", value: goalieStats.wins ?? 0 },
                { label: "L", value: goalieStats.losses ?? 0 },
                { label: "T", value: goalieStats.ties ?? 0 },
                { label: "GA", value: goalieStats.ga ?? 0 },
                { label: "SO", value: goalieStats.so ?? 0 },
                { label: "GAA", value: goalieStats.gaa ?? "—" },
              ].map(({ label, value }) => (
                <div key={label}>
                  <div className="text-2xl font-bold">{value}</div>
                  <div className="text-muted-foreground text-xs">{label}</div>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      {/* G+A chart across last 10 games */}
      {!isGoalie && gameLog.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Goals &amp; Assists — Last {gameLog.length} Games</CardTitle>
          </CardHeader>
          <CardContent>
            <PlayerGameChart games={gameLog} />
          </CardContent>
        </Card>
      )}

      {/* Last 10 games */}
      {!isGoalie && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Last 10 Games</CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            {gameLog.length === 0 ? (
              <div className="px-6 pb-6">
                <EmptyState title="No games played yet" />
              </div>
            ) : (
              <div className="overflow-hidden rounded-b-lg">
                <Table>
                  <TableHeader>
                    <TableRow className="bg-muted/40">
                      <TableHead>Date</TableHead>
                      <TableHead>Opponent</TableHead>
                      <TableHead className="text-center">Result</TableHead>
                      <TableHead className="text-center">G</TableHead>
                      <TableHead className="text-center">A</TableHead>
                      <TableHead className="text-center font-semibold">PTS</TableHead>
                      <TableHead className="text-center">PIM</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {gameLog.map((row) => {
                      const won = row.team_goals > row.opp_goals;
                      const lost = row.team_goals < row.opp_goals;
                      return (
                        <TableRow key={row.game_id}>
                          <TableCell className="text-muted-foreground text-sm whitespace-nowrap">
                            {formatGameDate(row.date)}
                          </TableCell>
                          <TableCell>
                            <Link
                              href={`/teams/${row.opponent_slug}`}
                              className="flex items-center gap-2 hover:underline"
                            >
                              <TeamLogo
                                name={row.opponent_name}
                                color={row.opponent_color}
                              />
                              <span className="text-sm">{row.opponent_name}</span>
                            </Link>
                          </TableCell>
                          <TableCell className="text-center text-sm">
                            <span
                              className={
                                won
                                  ? "text-green-600 font-semibold"
                                  : lost
                                    ? "text-red-600"
                                    : "text-muted-foreground"
                              }
                            >
                              {row.team_goals}–{row.opp_goals}
                            </span>
                          </TableCell>
                          <TableCell className="text-center">{row.goals}</TableCell>
                          <TableCell className="text-center">{row.assists}</TableCell>
                          <TableCell className="text-center font-bold">{row.pts}</TableCell>
                          <TableCell className="text-center">{row.pim}</TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {/* Stats vs each opponent */}
      {!isGoalie && byOpponent.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Stats by Opponent</CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            <div className="overflow-hidden rounded-b-lg">
              <Table>
                <TableHeader>
                  <TableRow className="bg-muted/40">
                    <TableHead>Team</TableHead>
                    <TableHead className="text-center">GP</TableHead>
                    <TableHead className="text-center">G</TableHead>
                    <TableHead className="text-center">A</TableHead>
                    <TableHead className="text-center font-semibold">PTS</TableHead>
                    <TableHead className="text-center">PIM</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {byOpponent.map((row) => (
                    <TableRow key={row.opponent_id}>
                      <TableCell>
                        <Link
                          href={`/teams/${row.opponent_slug}`}
                          className="flex items-center gap-2 hover:underline"
                        >
                          <TeamLogo name={row.opponent_name} color={row.opponent_color} />
                          <span className="text-sm">{row.opponent_name}</span>
                        </Link>
                      </TableCell>
                      <TableCell className="text-center">{row.gp}</TableCell>
                      <TableCell className="text-center">{row.g}</TableCell>
                      <TableCell className="text-center">{row.a}</TableCell>
                      <TableCell className="text-center font-bold">{row.pts}</TableCell>
                      <TableCell className="text-center">{row.pim}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
