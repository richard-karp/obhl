import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import type { RosterEntry } from "@/lib/queries/teams";

const POSITION_LABEL: Record<string, string> = {
  F: "Forward",
  D: "Defense",
  G: "Goalie",
};

export function RosterTable({ roster }: { roster: RosterEntry[] }) {
  return (
    <div className="overflow-hidden rounded-lg border">
      <Table>
        <TableHeader>
          <TableRow className="bg-muted/40">
            <TableHead className="w-12 text-center">#</TableHead>
            <TableHead>Player</TableHead>
            <TableHead>Position</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {roster.map((p) => (
            <TableRow key={p.player_id}>
              <TableCell className="text-muted-foreground text-center">
                {p.jersey_number ?? "—"}
              </TableCell>
              <TableCell className="font-medium">
                {p.first_name} {p.last_name}
                {p.is_captain ? (
                  <Badge variant="secondary" className="ml-2 px-1.5 py-0 text-[0.65rem]">
                    C
                  </Badge>
                ) : null}
              </TableCell>
              <TableCell className="text-muted-foreground">
                {POSITION_LABEL[p.position] ?? p.position}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
