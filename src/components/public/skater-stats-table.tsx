"use client";

import { useState } from "react";
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

type SortCol = "gp" | "g" | "a" | "pts" | "pim" | "ppg";
type SortDir = "asc" | "desc";

function ppg(r: SkaterStat) {
  return r.gp ? (r.pts ?? 0) / r.gp : 0;
}

function sortRows(rows: SkaterStat[], col: SortCol, dir: SortDir): SkaterStat[] {
  return [...rows].sort((a, b) => {
    const av = col === "ppg" ? ppg(a) : ((a[col] ?? 0) as number);
    const bv = col === "ppg" ? ppg(b) : ((b[col] ?? 0) as number);
    return dir === "desc" ? bv - av : av - bv;
  });
}

function SortHead({
  label,
  col,
  active,
  dir,
  onSort,
  className,
}: {
  label: string;
  col: SortCol;
  active: SortCol;
  dir: SortDir;
  onSort: (col: SortCol) => void;
  className?: string;
}) {
  const isActive = col === active;
  return (
    <TableHead className={className}>
      <button
        onClick={() => onSort(col)}
        className="flex w-full cursor-pointer items-center justify-center gap-0.5 hover:text-foreground transition-colors"
      >
        <span className={isActive ? "font-semibold" : ""}>{label}</span>
        <span className="w-3 text-center text-xs">
          {isActive ? (dir === "desc" ? "↓" : "↑") : ""}
        </span>
      </button>
    </TableHead>
  );
}

export function SkaterStatsTable({
  rows,
  showRank = true,
}: {
  rows: SkaterStat[];
  showRank?: boolean;
}) {
  const [sortCol, setSortCol] = useState<SortCol>("pts");
  const [sortDir, setSortDir] = useState<SortDir>("desc");

  function handleSort(col: SortCol) {
    if (col === sortCol) {
      setSortDir((d) => (d === "desc" ? "asc" : "desc"));
    } else {
      setSortCol(col);
      setSortDir("desc");
    }
  }

  const sorted = sortRows(rows, sortCol, sortDir);

  return (
    <div className="overflow-hidden rounded-lg border">
      <Table>
        <TableHeader>
          <TableRow className="bg-muted/40">
            {showRank ? <TableHead className="w-10 text-center">#</TableHead> : null}
            <TableHead>Player</TableHead>
            <TableHead className="hidden sm:table-cell">Team</TableHead>
            <SortHead label="GP" col="gp" active={sortCol} dir={sortDir} onSort={handleSort} className="text-center" />
            <SortHead label="G" col="g" active={sortCol} dir={sortDir} onSort={handleSort} className="text-center" />
            <SortHead label="A" col="a" active={sortCol} dir={sortDir} onSort={handleSort} className="text-center" />
            <SortHead label="PTS" col="pts" active={sortCol} dir={sortDir} onSort={handleSort} className="text-center" />
            <SortHead label="P/G" col="ppg" active={sortCol} dir={sortDir} onSort={handleSort} className="text-center" />
            <SortHead label="PIM" col="pim" active={sortCol} dir={sortDir} onSort={handleSort} className="text-center" />
          </TableRow>
        </TableHeader>
        <TableBody>
          {sorted.map((r, i) => (
            <TableRow key={`${r.player_id}-${r.team_id}`}>
              {showRank ? (
                <TableCell className="text-muted-foreground text-center">
                  {i + 1}
                </TableCell>
              ) : null}
              <TableCell className="font-medium">
                <Link href={`/players/${r.player_id}`} className="hover:underline">
                  {r.first_name} {r.last_name}
                </Link>
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
