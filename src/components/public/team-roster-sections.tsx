import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { NightBadge } from "@/components/shared/night-badge";

export type SectionSkater = {
  player_id: string;
  number: number | null;
  name: string;
  is_captain: boolean;
  night: number | null;
  gp: number;
  g: number;
  a: number;
  pts: number;
  pim: number;
};

export type SectionGoalie = SectionSkater & {
  wins: number;
  losses: number;
  ties: number;
  ga: number;
  so: number;
  gaa: number | null;
};

// ⛔ Every player appears exactly once: the Goalies section carries both column sets. ⚠️ `GoalieStatsTable` is
// the separate league-wide `/stats` table.
function sortRows<T extends { pts: number; number: number | null }>(
  rows: T[],
): T[] {
  // Points first, then jersey, per section: the order the maintainer asked for.
  return [...rows].sort(
    (a, b) => b.pts - a.pts || (a.number ?? 999) - (b.number ?? 999),
  );
}

function NameCell({
  name,
  isCaptain,
  night,
}: {
  name: string;
  isCaptain: boolean;
  /** `null` unless the caller's season plays more than one night — see `showNight`. */
  night: number | null;
}) {
  return (
    <TableCell className="font-medium">
      {name}
      <NightBadge night={night} />
      {isCaptain ? (
        <Badge variant="secondary" className="ml-2 px-1.5 py-0 text-[0.65rem]">
          C
        </Badge>
      ) : null}
    </TableCell>
  );
}

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    // A region per section so a screen-reader user — and the e2e — can address
    // one of the three rather than "the table".
    <section aria-label={title} className="space-y-2">
      <h2 className="text-muted-foreground text-sm font-semibold">{title}</h2>
      {/* ⚠️ THE SCROLLER IS NOT DECORATION. The Goalies table is the widest in
          the app; at 390px it cannot fit however many columns are hidden. */}
      <div className="overflow-x-auto rounded-lg border">
        <Table>{children}</Table>
      </div>
    </section>
  );
}

export function TeamRosterSections({
  forwards,
  defence,
  goalies,
  showNight,
}: {
  forwards: SectionSkater[];
  defence: SectionSkater[];
  goalies: SectionGoalie[];
  /** Only when the season plays more than one night — see `hasMultipleNights`. */
  showNight: boolean;
}) {
  const skaterSection = (title: string, rows: SectionSkater[]) =>
    rows.length === 0 ? null : (
      <Section key={title} title={title}>
        <TableHeader>
          <TableRow className="bg-muted/40">
            <TableHead className="w-12 text-center">#</TableHead>
            <TableHead>Player</TableHead>
            <TableHead className="text-center">GP</TableHead>
            <TableHead className="text-center">G</TableHead>
            <TableHead className="text-center">A</TableHead>
            <TableHead className="text-center font-semibold">PTS</TableHead>
            <TableHead className="text-center">P/G</TableHead>
            <TableHead className="text-center">PIM</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {sortRows(rows).map((r) => (
            <TableRow key={r.player_id}>
              <TableCell className="text-muted-foreground text-center tabular-nums">
                {r.number ?? "—"}
              </TableCell>
              <NameCell
                name={r.name}
                isCaptain={r.is_captain}
                night={showNight ? r.night : null}
              />
              <TableCell className="text-center tabular-nums">{r.gp}</TableCell>
              <TableCell className="text-center tabular-nums">{r.g}</TableCell>
              <TableCell className="text-center tabular-nums">{r.a}</TableCell>
              <TableCell className="text-center font-bold tabular-nums">
                {r.pts}
              </TableCell>
              <TableCell className="text-muted-foreground text-center tabular-nums">
                {r.gp ? (r.pts / r.gp).toFixed(2) : "—"}
              </TableCell>
              <TableCell className="text-center tabular-nums">
                {r.pim}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Section>
    );

  return (
    <div className="space-y-6">
      {skaterSection("Forwards", forwards)}
      {skaterSection("Defence", defence)}

      {goalies.length === 0 ? null : (
        <Section title="Goalies">
          <TableHeader>
            <TableRow className="bg-muted/40">
              <TableHead className="w-12 text-center">#</TableHead>
              <TableHead>Goalie</TableHead>
              <TableHead className="text-center">GP</TableHead>
              {/* ⚠️ Six columns drop below `sm`: twelve can't fit 390px, and the kept ones are
                  games, goals against, average and the scoring line. */}
              <TableHead className="hidden text-center sm:table-cell">
                W
              </TableHead>
              <TableHead className="hidden text-center sm:table-cell">
                L
              </TableHead>
              <TableHead className="hidden text-center sm:table-cell">
                T
              </TableHead>
              <TableHead className="text-center">GA</TableHead>
              <TableHead className="hidden text-center sm:table-cell">
                SO
              </TableHead>
              <TableHead className="text-center font-semibold">GAA</TableHead>
              <TableHead className="hidden text-center sm:table-cell">
                G
              </TableHead>
              <TableHead className="hidden text-center sm:table-cell">
                A
              </TableHead>
              <TableHead className="text-center">PTS</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {sortRows(goalies).map((r) => (
              <TableRow key={r.player_id}>
                <TableCell className="text-muted-foreground text-center tabular-nums">
                  {r.number ?? "—"}
                </TableCell>
                <NameCell
                  name={r.name}
                  isCaptain={r.is_captain}
                  night={showNight ? r.night : null}
                />
                <TableCell className="text-center tabular-nums">
                  {r.gp}
                </TableCell>
                <TableCell className="hidden text-center tabular-nums sm:table-cell">
                  {r.wins}
                </TableCell>
                <TableCell className="hidden text-center tabular-nums sm:table-cell">
                  {r.losses}
                </TableCell>
                <TableCell className="hidden text-center tabular-nums sm:table-cell">
                  {r.ties}
                </TableCell>
                <TableCell className="text-center tabular-nums">
                  {r.ga}
                </TableCell>
                <TableCell className="hidden text-center tabular-nums sm:table-cell">
                  {r.so}
                </TableCell>
                <TableCell className="text-center font-bold tabular-nums">
                  {r.gaa === null ? "—" : r.gaa.toFixed(2)}
                </TableCell>
                <TableCell className="hidden text-center tabular-nums sm:table-cell">
                  {r.g}
                </TableCell>
                <TableCell className="hidden text-center tabular-nums sm:table-cell">
                  {r.a}
                </TableCell>
                <TableCell className="text-center tabular-nums">
                  {r.pts}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Section>
      )}
    </div>
  );
}
