import type { Metadata } from "next";
import { getActiveContext } from "@/lib/queries/season";
import { getSkaterLeaders, getGoalieLeaders } from "@/lib/queries/stats";
import { SkaterStatsTable } from "@/components/public/skater-stats-table";
import { GoalieStatsTable } from "@/components/public/goalie-stats-table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { PageHeader } from "@/components/shared/page-header";
import { EmptyState } from "@/components/shared/empty-state";
import { NoSeason } from "@/components/public/no-season";

export const metadata: Metadata = { title: "Stats" };

export default async function StatsPage() {
  const ctx = await getActiveContext();
  if (!ctx?.season) return <NoSeason />;

  const [skaters, goalies] = await Promise.all([
    getSkaterLeaders(ctx.season.id),
    getGoalieLeaders(ctx.season.id),
  ]);

  return (
    <div className="space-y-6">
      <PageHeader title="Statistics" description={ctx.season.name} />
      <Tabs defaultValue="skaters" className="space-y-4">
        <TabsList>
          <TabsTrigger value="skaters">Skaters</TabsTrigger>
          <TabsTrigger value="goalies">Goalies</TabsTrigger>
        </TabsList>
        <TabsContent value="skaters">
          {skaters.length === 0 ? (
            <EmptyState title="No skater stats yet" />
          ) : (
            <SkaterStatsTable rows={skaters} />
          )}
        </TabsContent>
        <TabsContent value="goalies">
          {goalies.length === 0 ? (
            <EmptyState title="No goalie stats yet" />
          ) : (
            <GoalieStatsTable rows={goalies} />
          )}
        </TabsContent>
      </Tabs>
    </div>
  );
}
