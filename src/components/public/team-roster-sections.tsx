import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { NIGHT_LABEL } from "@/lib/season/nights";

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

/**
 * A team's roster the way a hockey roster reads: forwards, defence, goalies.
 *
 * ⛔ EVERY PLAYER APPEARS EXACTLY ONCE. This replaced one flat points-sorted
 * table plus a separate "Goaltending" block, which listed each goalie twice —
 * once near the bottom of the skater list with 0 points, once with their real
 * numbers. The Goalies section below carries BOTH sets of columns so nothing
 * is lost by the merge.
 *
 * ⚠️ `GoalieStatsTable` IS NOT THIS AND WAS NOT TOUCHED. `/stats` still uses
 * it for the league-wide, sortable goalie table; this one is team-scoped,
 * unsorted, and zero-fills.
 */
function sortRows<T extends { pts: number; number: number | null }>(
  rows: T[],
): T[] {
  // Points first, jersey second — the order the maintainer asked for, applied
  // per section rather than across the whole roster.
  return [...rows].sort(
    (a, b) => b.pts - a.pts || (a.number ?? 999) - (b.number ?? 999),
  );
}

function NightCell({ night }: { night: number | null }) {
  // ⚠️ A NIGHT OUTSIDE THE SEASON'S IS RENDERED, NOT HIDDEN — but the caller
  // decides whether this column exists at all. A season regenerated onto
  // fewer nights leaves assignments pointing at a night it no longer plays;
  // `—` says "nothing set" honestly and the stored value is left alone rather
  // than silently discarding a manager's work.
  return (
    <TableCell className="text-muted-foreground text-center">
      {night === null ? "—" : (NIGHT_LABEL[night] ?? "—")}
    </TableCell>
  );
}

function NameCell({ name, isCaptain }: { name: string; isCaptain: boolean }) {
  return (
    <TableCell className="font-medium">
      {name}
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
  showNight,
  children,
}: {
  title: string;
  showNight: boolean;
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
      {showNight ? null : null}
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
      <Section key={title} title={title} showNight={showNight}>
        <TableHeader>
          <TableRow className="bg-muted/40">
            <TableHead className="w-12 text-center">#</TableHead>
            <TableHead>Player</TableHead>
            {showNight ? (
              <TableHead className="text-center">Night</TableHead>
            ) : null}
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
              <NameCell name={r.name} isCaptain={r.is_captain} />
              {showNight ? <NightCell night={r.night} /> : null}
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
        <Section title="Goalies" showNight={showNight}>
          <TableHeader>
            <TableRow className="bg-muted/40">
              <TableHead className="w-12 text-center">#</TableHead>
              <TableHead>Goalie</TableHead>
              {showNight ? (
                <TableHead className="text-center">Night</TableHead>
              ) : null}
              <TableHead className="text-center">GP</TableHead>
              {/* ⚠️ SIX COLUMNS DROP BELOW `sm`. Thirteen will not fit 390px,
                  and the ones kept are the ones a reader scans for: games,
                  goals against, average, and the scoring line. */}
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
                <NameCell name={r.name} isCaptain={r.is_captain} />
                {showNight ? <NightCell night={r.night} /> : null}
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
