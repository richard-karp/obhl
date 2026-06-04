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
import type { RankedStanding } from "@/lib/queries/standings";

function diff(n: number) {
  return n > 0 ? `+${n}` : `${n}`;
}

export function StandingsTable({ rows }: { rows: RankedStanding[] }) {
  return (
    <div className="overflow-hidden rounded-lg border">
      <Table>
        <TableHeader>
          <TableRow className="bg-muted/40">
            <TableHead className="w-10 text-center">#</TableHead>
            <TableHead>Team</TableHead>
            <TableHead className="text-center">GP</TableHead>
            <TableHead className="text-center">W</TableHead>
            <TableHead className="text-center">L</TableHead>
            <TableHead className="text-center">T</TableHead>
            <TableHead className="hidden text-center sm:table-cell">GF</TableHead>
            <TableHead className="hidden text-center sm:table-cell">GA</TableHead>
            <TableHead className="text-center">DIFF</TableHead>
            <TableHead className="text-center font-semibold">PTS</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((r) => (
            <TableRow key={r.teamId}>
              <TableCell className="text-muted-foreground text-center">
                {r.rank}
              </TableCell>
              <TableCell>
                <Link
                  href={`/teams/${r.team_slug}`}
                  className="flex items-center gap-2 font-medium hover:underline"
                >
                  <TeamLogo name={r.team_name ?? ""} color={r.team_color} />
                  {r.team_name}
                </Link>
              </TableCell>
              <TableCell className="text-center">{r.gp ?? 0}</TableCell>
              <TableCell className="text-center">{r.wins ?? 0}</TableCell>
              <TableCell className="text-center">{r.losses ?? 0}</TableCell>
              <TableCell className="text-center">{r.ties ?? 0}</TableCell>
              <TableCell className="hidden text-center sm:table-cell">
                {r.gf ?? 0}
              </TableCell>
              <TableCell className="hidden text-center sm:table-cell">
                {r.ga ?? 0}
              </TableCell>
              <TableCell className="text-muted-foreground text-center">
                {diff(r.gd ?? 0)}
              </TableCell>
              <TableCell className="text-center font-bold">
                {r.points ?? 0}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
