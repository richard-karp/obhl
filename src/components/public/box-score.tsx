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
import type { getGameBoxScore, BoxLine, BoxGoalie } from "@/lib/queries/games";

type Box = NonNullable<Awaited<ReturnType<typeof getGameBoxScore>>>;

function TeamScore({
  team,
  score,
  winner,
}: {
  team: {
    name: string;
    color: string | null;
    logo_path: string | null;
    logo_text_color: string | null;
  } | null;
  score: number;
  winner: boolean;
}) {
  return (
    <div className="flex flex-1 flex-col items-center gap-2">
      <TeamLogo
        name={team?.name ?? "TBD"}
        color={team?.color}
        logoPath={team?.logo_path}
        textColor={team?.logo_text_color}
        className="size-10 text-sm"
      />
      <span className="text-center text-sm font-medium">
        {team?.name ?? "TBD"}
      </span>
      <span
        className={cn(
          "text-4xl font-bold tabular-nums",
          !winner && "text-muted-foreground",
        )}
      >
        {score}
      </span>
    </div>
  );
}

/**
 * Who was in net, under the team's skaters.
 *
 * ⛔ THE TWO "NO LINE" CASES READ DIFFERENTLY ON PURPOSE. A substitute goalie
 * is a complete answer that carries no individual record (`0015`); nobody
 * having entered anything is a gap. Four of the six team-sides in the
 * maintainer's first three production games are the second kind, and this
 * string is how they find out — so it has to say "nobody recorded this", not
 * show a blank or a `—` that reads as a zero.
 */
function GoalieLineRow({ goalie }: { goalie: BoxGoalie }) {
  if (goalie.kind === "sub") {
    return (
      <p className="text-muted-foreground px-3 py-2 text-xs">
        Substitute goalie — no individual stats.
      </p>
    );
  }
  if (goalie.kind === "none") {
    return (
      <p className="text-muted-foreground px-3 py-2 text-xs">
        No goalie recorded.
      </p>
    );
  }
  return (
    <div className="flex items-center gap-3 px-3 py-2 text-sm">
      <span className="text-muted-foreground w-8 shrink-0 text-center tabular-nums">
        {goalie.number ?? "—"}
      </span>
      <span className="flex-1 truncate font-medium">{goalie.name}</span>
      <span className="text-muted-foreground tabular-nums">GA {goalie.ga}</span>
      {goalie.shutout ? <span className="font-semibold">SO</span> : null}
      <span className="w-4 text-center font-bold">{goalie.outcome}</span>
    </div>
  );
}

function TeamLines({
  team,
  lines,
  goalie,
}: {
  team: { id: string; name: string } | null | undefined;
  lines: BoxLine[];
  goalie: BoxGoalie;
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
                <TableCell className="text-center tabular-nums">
                  {r.goals}
                </TableCell>
                <TableCell className="text-center tabular-nums">
                  {r.assists}
                </TableCell>
                <TableCell className="text-center tabular-nums">
                  {r.pim}
                </TableCell>
              </TableRow>
            ))}
            <TableRow className="bg-muted/20 font-semibold">
              <TableCell />
              <TableCell className="text-muted-foreground text-xs uppercase">
                Total
              </TableCell>
              <TableCell className="text-center tabular-nums">
                {totals.g}
              </TableCell>
              <TableCell className="text-center tabular-nums">
                {totals.a}
              </TableCell>
              <TableCell className="text-center tabular-nums">
                {totals.pim}
              </TableCell>
            </TableRow>
          </TableBody>
        </Table>
        <div className="bg-muted/10 border-t">
          <p className="text-muted-foreground px-3 pt-2 text-[0.7rem] font-semibold uppercase">
            Goalie
          </p>
          <GoalieLineRow goalie={goalie} />
        </div>
      </div>
    </div>
  );
}

export function BoxScore({ box }: { box: Box }) {
  const { game, lines, goalies } = box;
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
        <TeamLines team={away} lines={lines} goalie={goalies.away} />
        <TeamLines team={home} lines={lines} goalie={goalies.home} />
      </section>
    </div>
  );
}
