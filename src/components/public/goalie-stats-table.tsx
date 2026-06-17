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
import type { GoalieStat } from "@/lib/queries/stats";

type SortCol = "gp" | "wins" | "losses" | "ties" | "ga" | "so" | "gaa";
type SortDir = "asc" | "desc";

function sortRows(rows: GoalieStat[], col: SortCol, dir: SortDir): GoalieStat[] {
  return [...rows].sort((a, b) => {
    const nullFallback = dir === "desc" ? -Infinity : Infinity;
    const av = a[col] !== null && a[col] !== undefined ? (a[col] as number) : nullFallback;
    const bv = b[col] !== null && b[col] !== undefined ? (b[col] as number) : nullFallback;
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

export function GoalieStatsTable({ rows }: { rows: GoalieStat[] }) {
  const [sortCol, setSortCol] = useState<SortCol>("gaa");
  const [sortDir, setSortDir] = useState<SortDir>("asc");

  function handleSort(col: SortCol) {
    if (col === sortCol) {
      setSortDir((d) => (d === "desc" ? "asc" : "desc"));
    } else {
      setSortCol(col);
      // GAA sorts ascending by default (lower is better); everything else descending
      setSortDir(col === "gaa" ? "asc" : "desc");
    }
  }

  const sorted = sortRows(rows, sortCol, sortDir);

  return (
    <div className="overflow-hidden rounded-lg border">
      <Table>
        <TableHeader>
          <TableRow className="bg-muted/40">
            <TableHead>Goalie</TableHead>
            <TableHead className="hidden sm:table-cell">Team</TableHead>
            <SortHead label="GP" col="gp" active={sortCol} dir={sortDir} onSort={handleSort} className="text-center" />
            <SortHead label="W" col="wins" active={sortCol} dir={sortDir} onSort={handleSort} className="text-center" />
            <SortHead label="L" col="losses" active={sortCol} dir={sortDir} onSort={handleSort} className="text-center" />
            <SortHead label="T" col="ties" active={sortCol} dir={sortDir} onSort={handleSort} className="text-center" />
            <SortHead label="GA" col="ga" active={sortCol} dir={sortDir} onSort={handleSort} className="text-center" />
            <SortHead label="SO" col="so" active={sortCol} dir={sortDir} onSort={handleSort} className="text-center" />
            <SortHead label="GAA" col="gaa" active={sortCol} dir={sortDir} onSort={handleSort} className="text-center" />
          </TableRow>
        </TableHeader>
        <TableBody>
          {sorted.map((r) => (
            <TableRow key={`${r.player_id}-${r.team_id}`}>
              <TableCell className="font-medium">
                <Link href={`/players/${r.player_id}`} className="hover:underline">
                  {r.first_name} {r.last_name}
                </Link>
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
