import Link from "next/link";
import { requireLeagueManager } from "@/lib/auth/guards";
import { createAdminClient } from "@/utils/supabase/admin";
import { getActiveContext } from "@/lib/queries/season";
import { getEnrolledTeams } from "@/lib/queries/teams";
import { getSeasonNights } from "@/lib/queries/schedule";
import { OneOffGameForm } from "@/components/manage/one-off-game-form";
import { PageHeader } from "@/components/shared/page-header";
import { EmptyState } from "@/components/shared/empty-state";
import { Button } from "@/components/ui/button";

/**
 * Mid-season one-off games — a tournament final or semifinals dropped into a
 * night that's already scheduled, with the rest of the season repaired around
 * it. Deliberately not part of the schedule builder: that page is pre-season
 * (draft → review → publish), while this only makes sense once games are live.
 */
export default async function OneOffGamePage({
  params,
}: {
  params: Promise<{ league: string }>;
}) {
  const { league: leagueParam } = await params;
  const ctx = await getActiveContext(leagueParam);
  await requireLeagueManager(ctx.league.id);
  // The resolved slug, not the URL's — links stay canonical from /OBHL.
  const leagueSlug = ctx.league.slug;
  if (!ctx.season) {
    return (
      <div className="space-y-4">
        <EmptyState
          title="No active season"
          description="Set a season active before scheduling a one-off game."
        />
        <div className="text-center">
          <Button asChild size="sm">
            <Link href={`/${leagueSlug}/manage/seasons`}>Go to Seasons</Link>
          </Button>
        </div>
      </div>
    );
  }

  // Read past RLS, matching the actions this page submits to. Otherwise a
  // season the public-read policies don't cover renders the "no published
  // schedule" empty state here while `previewOneOffGame` sees the schedule fine.
  const admin = createAdminClient();
  const [teams, nights] = await Promise.all([
    getEnrolledTeams(ctx.season.id, { client: admin }),
    getSeasonNights(ctx.season.id, { client: admin }),
  ]);

  const openNights = nights.filter((n) => !n.locked);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Schedule a one-off game"
        description={`${ctx.season.name} · tournament final or semifinals, mid-season`}
      >
        <Button asChild size="sm" variant="outline">
          <Link href={`/${leagueSlug}/manage/schedule-builder`}>Schedule Builder</Link>
        </Button>
      </PageHeader>

      {nights.length === 0 ? (
        <EmptyState
          title="No published schedule"
          description="Generate and publish a schedule first — a one-off game takes over a game on a night that's already scheduled."
        />
      ) : openNights.length === 0 ? (
        <EmptyState
          title="No nights left to use"
          description="Every remaining game night has already been played or is in the past."
        />
      ) : (
        <OneOffGameForm
          seasonId={ctx.season.id}
          teams={teams.map((t) => ({ id: t.id, name: t.name }))}
          nights={openNights.map((n) => ({
            date: n.date,
            teamIds: n.games.flatMap((g) => [g.homeTeamId, g.awayTeamId]),
            games: n.games.length,
          }))}
        />
      )}
    </div>
  );
}
