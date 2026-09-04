import Link from "next/link";
import { requireLeagueManager } from "@/lib/auth/guards";
import { createAdminClient } from "@/utils/supabase/admin";
import { getManageContext } from "@/lib/queries/season";
import { getEnrolledTeams } from "@/lib/queries/teams";
import { TeamLogo } from "@/components/shared/team-logo";
import { Card, CardContent } from "@/components/ui/card";
import { PageHeader } from "@/components/shared/page-header";
import { EmptyState } from "@/components/shared/empty-state";
import { SeasonSwitcher } from "@/components/manage/season-switcher";

export default async function RostersPage({
  params,
  searchParams,
}: {
  params: Promise<{ league: string }>;
  searchParams: Promise<{ season?: string }>;
}) {
  const { league: leagueParam } = await params;
  const { season: seasonParam } = await searchParams;
  const ctx = await getManageContext(leagueParam, seasonParam);
  await requireLeagueManager(ctx.league.id);
  // The resolved slug, not the URL's — links stay canonical from /OBHL.
  const leagueSlug = ctx.league.slug;
  // Not "no ACTIVE season" any more — a season nobody has activated is exactly
  // what this page now exists to edit. Only a league with no seasons at all is
  // left with nothing to show.
  if (!ctx.season) {
    return <EmptyState title="No seasons yet" description="Create a season first." />;
  }
  // Manager-only page: read past RLS, so a season the public-read policies
  // don't cover shows its teams rather than coming back silently empty.
  const teams = await getEnrolledTeams(ctx.season.id, {
    client: createAdminClient(),
  });

  return (
    <div className="space-y-6">
      <PageHeader
        title="Rosters"
        description={`Pick a team to manage its ${ctx.season.name} roster.`}
      >
        <SeasonSwitcher ctx={ctx} />
      </PageHeader>
      {teams.length === 0 ? (
        <EmptyState
          title="No teams enrolled"
          description="Enroll teams for this season first."
        />
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {teams.map((t) => (
            <Link key={t.id} href={`/${leagueSlug}/manage/rosters/${t.id}`}>
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
