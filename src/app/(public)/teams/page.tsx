import type { Metadata } from "next";
import Link from "next/link";
import { getActiveContext } from "@/lib/queries/season";
import { getEnrolledTeams } from "@/lib/queries/teams";
import { TeamLogo } from "@/components/shared/team-logo";
import { Card, CardContent } from "@/components/ui/card";
import { PageHeader } from "@/components/shared/page-header";
import { EmptyState } from "@/components/shared/empty-state";
import { NoSeason } from "@/components/public/no-season";

export const metadata: Metadata = { title: "Teams" };

export default async function TeamsPage() {
  const ctx = await getActiveContext();
  if (!ctx?.season) return <NoSeason />;
  const teams = await getEnrolledTeams(ctx.season.id);

  return (
    <div className="space-y-6">
      <PageHeader title="Teams" description={ctx.season.name} />
      {teams.length === 0 ? (
        <EmptyState title="No teams enrolled yet" />
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {teams.map((t) => (
            <Link key={t.id} href={`/teams/${t.slug}`}>
              <Card className="hover:border-primary transition-colors">
                <CardContent className="flex items-center gap-3 p-4">
                  <TeamLogo
                    name={t.name}
                    color={t.color}
                    logoPath={t.logo_path}
                    className="size-10 text-sm"
                  />
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
