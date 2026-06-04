import { TeamLogo } from "@/components/shared/team-logo";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { cn } from "@/lib/utils";
import type { getGameBoxScore, BoxLine } from "@/lib/queries/games";

type Box = NonNullable<Awaited<ReturnType<typeof getGameBoxScore>>>;

function TeamScore({
  team,
  score,
  winner,
}: {
  team: { name: string; color: string | null } | null;
  score: number;
  winner: boolean;
}) {
  return (
    <div className="flex flex-1 flex-col items-center gap-2">
      <TeamLogo name={team?.name ?? "TBD"} color={team?.color} className="size-10 text-sm" />
      <span className="text-center text-sm font-medium">{team?.name ?? "TBD"}</span>
      <span className={cn("text-4xl font-bold tabular-nums", !winner && "text-muted-foreground")}>
        {score}
      </span>
    </div>
  );
}

function TeamLines({
  team,
  lines,
}: {
  team: { id: string; name: string } | null | undefined;
  lines: BoxLine[];
}) {
  const rows = lines
    .filter((l) => l.team_id === team?.id)
    .sort((a, b) => (a.number ?? 999) - (b.number ?? 999));
  const totals = rows.reduce(
    (t, r) => ({ g: t.g + r.goals, a: t.a + r.assists, pim: t.pim + r.pim }),
    { g: 0, a: 0, pim: 0 },
  );

  return (
    <div className="space-y-2">
      <p className="text-muted-foreground text-xs font-medium">{team?.name}</p>
      <div className="overflow-hidden rounded-lg border">
        <Table>
          <TableHeader>
            <TableRow className="bg-muted/40">
              <TableHead className="w-12 text-center">#</TableHead>
              <TableHead>Player</TableHead>
              <TableHead className="text-center">G</TableHead>
              <TableHead className="text-center">A</TableHead>
              <TableHead className="text-center">PIM</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((r, i) => (
              <TableRow key={`${team?.id}-${i}`}>
                <TableCell className="text-muted-foreground text-center tabular-nums">
                  {r.number ?? "—"}
                </TableCell>
                <TableCell className="font-medium">{r.name}</TableCell>
                <TableCell className="text-center tabular-nums">{r.goals}</TableCell>
                <TableCell className="text-center tabular-nums">{r.assists}</TableCell>
                <TableCell className="text-center tabular-nums">{r.pim}</TableCell>
              </TableRow>
            ))}
            <TableRow className="bg-muted/20 font-semibold">
              <TableCell />
              <TableCell className="text-muted-foreground text-xs uppercase">
                Total
              </TableCell>
              <TableCell className="text-center tabular-nums">{totals.g}</TableCell>
              <TableCell className="text-center tabular-nums">{totals.a}</TableCell>
              <TableCell className="text-center tabular-nums">{totals.pim}</TableCell>
            </TableRow>
          </TableBody>
        </Table>
      </div>
    </div>
  );
}

export function BoxScore({ box }: { box: Box }) {
  const { game, lines } = box;
  const home = game.home_team;
  const away = game.away_team;
  const homeWin = game.home_goals > game.away_goals;
  const awayWin = game.away_goals > game.home_goals;

  return (
    <div className="space-y-8">
      {/* Score header */}
      <div className="flex items-center justify-center gap-6 rounded-xl border p-6">
        <TeamScore team={away} score={game.away_goals} winner={awayWin} />
        <span className="text-muted-foreground text-sm font-medium">FINAL</span>
        <TeamScore team={home} score={game.home_goals} winner={homeWin} />
      </div>

      {/* Player stat lines */}
      <section className="grid gap-6 sm:grid-cols-2">
        <TeamLines team={away} lines={lines} />
        <TeamLines team={home} lines={lines} />
      </section>
    </div>
  );
}
