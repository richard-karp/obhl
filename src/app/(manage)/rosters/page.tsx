import Link from "next/link";
import { requireManager } from "@/lib/auth/guards";
import { getActiveContext } from "@/lib/queries/season";
import { getEnrolledTeams } from "@/lib/queries/teams";
import { TeamLogo } from "@/components/shared/team-logo";
import { Card, CardContent } from "@/components/ui/card";
import { PageHeader } from "@/components/shared/page-header";
import { EmptyState } from "@/components/shared/empty-state";

export default async function RostersPage() {
  await requireManager();
  const ctx = await getActiveContext();
  if (!ctx?.season) {
    return <EmptyState title="No active season" description="Create and activate a season first." />;
  }
  const teams = await getEnrolledTeams(ctx.season.id);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Rosters"
        description={`Pick a team to manage its ${ctx.season.name} roster.`}
      />
      {teams.length === 0 ? (
        <EmptyState
          title="No teams enrolled"
          description="Enroll teams for this season first."
        />
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {teams.map((t) => (
            <Link key={t.id} href={`/rosters/${t.id}`}>
              <Card className="hover:border-primary transition-colors">
                <CardContent className="flex items-center gap-3 p-4">
                  <TeamLogo name={t.name} color={t.color} className="size-10 text-sm" />
                  <span className="font-semibold">{t.name}</span>
                </CardContent>
              </Card>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
