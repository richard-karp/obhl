import type { Metadata } from "next";
import { getActiveContext } from "@/lib/queries/season";
import { getStandings } from "@/lib/queries/standings";
import { StandingsTable } from "@/components/public/standings-table";
import { PageHeader } from "@/components/shared/page-header";
import { EmptyState } from "@/components/shared/empty-state";
import { NoSeason } from "@/components/public/no-season";

export const metadata: Metadata = { title: "Standings" };

export default async function StandingsPage() {
  const ctx = await getActiveContext();
  if (!ctx?.season) return <NoSeason />;
  const rows = await getStandings(ctx.season.id);

  return (
    <div className="space-y-6">
      <PageHeader title="Standings" description={ctx.season.name} />
      {rows.length === 0 ? (
        <EmptyState
          title="No teams enrolled yet"
          description="Teams will appear here once they're enrolled in the season."
        />
      ) : (
        <StandingsTable rows={rows} />
      )}
      <p className="text-muted-foreground text-xs">
        Tiebreakers: points, then wins, head-to-head, goal differential, goals
        for.
      </p>
    </div>
  );
}
