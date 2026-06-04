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
import type { GoalieStat } from "@/lib/queries/stats";

export function GoalieStatsTable({ rows }: { rows: GoalieStat[] }) {
  return (
    <div className="overflow-hidden rounded-lg border">
      <Table>
        <TableHeader>
          <TableRow className="bg-muted/40">
            <TableHead>Goalie</TableHead>
            <TableHead className="hidden sm:table-cell">Team</TableHead>
            <TableHead className="text-center">GP</TableHead>
            <TableHead className="text-center">W</TableHead>
            <TableHead className="text-center">L</TableHead>
            <TableHead className="text-center">T</TableHead>
            <TableHead className="text-center">GA</TableHead>
            <TableHead className="text-center">SO</TableHead>
            <TableHead className="text-center font-semibold">GAA</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((r) => (
            <TableRow key={`${r.player_id}-${r.team_id}`}>
              <TableCell className="font-medium">
                {r.first_name} {r.last_name}
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
              <TableCell className="text-center">{r.wins ?? 0}</TableCell>
              <TableCell className="text-center">{r.losses ?? 0}</TableCell>
              <TableCell className="text-center">{r.ties ?? 0}</TableCell>
              <TableCell className="text-center">{r.ga ?? 0}</TableCell>
              <TableCell className="text-center">{r.so ?? 0}</TableCell>
              <TableCell className="text-center font-bold">
                {r.gaa ?? "—"}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
