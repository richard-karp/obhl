import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";

const POSITION_LABEL: Record<string, string> = {
  F: "Forward",
  D: "Defense",
  G: "Goalie",
};

export type TeamPlayerRow = {
  player_id: string;
  number: number | null;
  name: string;
  position: string;
  is_captain: boolean;
  gp: number;
  g: number;
  a: number;
  pts: number;
  pim: number;
};

/**
 * Combined roster + skater stats for a single team. Since every row is the same
 * team, the league-wide "Team" column is replaced with the player's position.
 */
export function TeamPlayerTable({ rows }: { rows: TeamPlayerRow[] }) {
  return (
    <div className="overflow-hidden rounded-lg border">
      <Table>
        <TableHeader>
          <TableRow className="bg-muted/40">
            <TableHead className="w-12 text-center">#</TableHead>
            <TableHead>Player</TableHead>
            <TableHead className="hidden sm:table-cell">Pos</TableHead>
            <TableHead className="text-center">GP</TableHead>
            <TableHead className="text-center">G</TableHead>
            <TableHead className="text-center">A</TableHead>
            <TableHead className="text-center font-semibold">PTS</TableHead>
            <TableHead className="text-center">P/G</TableHead>
            <TableHead className="text-center">PIM</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((r) => (
            <TableRow key={r.player_id}>
              <TableCell className="text-muted-foreground text-center tabular-nums">
                {r.number ?? "—"}
              </TableCell>
              <TableCell className="font-medium">
                {r.name}
                {r.is_captain ? (
                  <Badge variant="secondary" className="ml-2 px-1.5 py-0 text-[0.65rem]">
                    C
                  </Badge>
                ) : null}
              </TableCell>
              <TableCell className="text-muted-foreground hidden sm:table-cell">
                {POSITION_LABEL[r.position] ?? r.position}
              </TableCell>
              <TableCell className="text-center tabular-nums">{r.gp}</TableCell>
              <TableCell className="text-center tabular-nums">{r.g}</TableCell>
              <TableCell className="text-center tabular-nums">{r.a}</TableCell>
              <TableCell className="text-center font-bold tabular-nums">{r.pts}</TableCell>
              <TableCell className="text-muted-foreground text-center tabular-nums">
                {r.gp ? (r.pts / r.gp).toFixed(2) : "—"}
              </TableCell>
              <TableCell className="text-center tabular-nums">{r.pim}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
