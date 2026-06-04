import Link from "next/link";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { TeamLogo } from "@/components/shared/team-logo";
import type { SkaterStat } from "@/lib/queries/stats";

export function SkaterStatsTable({
  rows,
  showRank = true,
}: {
  rows: SkaterStat[];
  showRank?: boolean;
}) {
  return (
    <div className="overflow-hidden rounded-lg border">
      <Table>
        <TableHeader>
          <TableRow className="bg-muted/40">
            {showRank ? <TableHead className="w-10 text-center">#</TableHead> : null}
            <TableHead>Player</TableHead>
            <TableHead className="hidden sm:table-cell">Team</TableHead>
            <TableHead className="text-center">GP</TableHead>
            <TableHead className="text-center">G</TableHead>
            <TableHead className="text-center">A</TableHead>
            <TableHead className="text-center font-semibold">PTS</TableHead>
            <TableHead className="text-center">P/G</TableHead>
            <TableHead className="text-center">PIM</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((r, i) => (
            <TableRow key={`${r.player_id}-${r.team_id}`}>
              {showRank ? (
                <TableCell className="text-muted-foreground text-center">
                  {i + 1}
                </TableCell>
              ) : null}
              <TableCell className="font-medium">
                {r.first_name} {r.last_name}
                {r.jersey_number != null ? (
                  <span className="text-muted-foreground ml-1 text-xs">
                    #{r.jersey_number}
                  </span>
                ) : null}
              </TableCell>
              <TableCell className="hidden sm:table-cell">
                <Link
                  href={`/teams/${r.team_slug}`}
                  className="flex items-center gap-2 hover:underline"
                >
                  <TeamLogo name={r.team_name ?? ""} color={r.team_color} />
                  <span className="text-muted-foreground text-sm">
                    {r.team_name}
                  </span>
                </Link>
              </TableCell>
              <TableCell className="text-center">{r.gp ?? 0}</TableCell>
              <TableCell className="text-center">{r.g ?? 0}</TableCell>
              <TableCell className="text-center">{r.a ?? 0}</TableCell>
              <TableCell className="text-center font-bold">{r.pts ?? 0}</TableCell>
              <TableCell className="text-muted-foreground text-center tabular-nums">
                {r.gp ? ((r.pts ?? 0) / r.gp).toFixed(2) : "—"}
              </TableCell>
              <TableCell className="text-center">{r.pim ?? 0}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
