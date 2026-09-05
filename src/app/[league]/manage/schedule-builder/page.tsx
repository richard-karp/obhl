import { notFound } from "next/navigation";
import Link from "next/link";
import { requireLeagueManager } from "@/lib/auth/guards";
import { createAdminClient } from "@/utils/supabase/admin";
import { resolveLeagueBySlug } from "@/lib/league/current";
import { getManageContext } from "@/lib/queries/season";
import { ScheduleBuilderPanel } from "@/components/manage/schedule-builder-panel";
import { PageHeader } from "@/components/shared/page-header";
import { EmptyState } from "@/components/shared/empty-state";
import { Button } from "@/components/ui/button";
import { SeasonSwitcher } from "@/components/manage/season-switcher";

export default async function ScheduleBuilderPage({
  params,
  searchParams,
}: {
  params: Promise<{ league: string }>;
  searchParams: Promise<{ season?: string }>;
}) {
  const { league: leagueParam } = await params;
  const { season: seasonParam } = await searchParams;
  // League, then GUARD, then context — `getManageContext` reads every season on
  // the ADMIN client, so it must not run for a request about to be refused.
  // `resolveLeagueBySlug` is cache()-wrapped, so the context reuses it free.
  const league = await resolveLeagueBySlug(leagueParam);
  if (!league) notFound();
  await requireLeagueManager(league.id);
  const ctx = await getManageContext(leagueParam, seasonParam);
  // The resolved slug, not the URL's — links stay canonical from /OBHL.
  const leagueSlug = ctx.league.slug;
  // A season no longer has to be ACTIVE to be built here — the switcher beside
  // the heading picks one. Only a league with no seasons at all is left with
  // nothing to build.
  if (!ctx.season) {
    return (
      <div className="space-y-4">
        <EmptyState
          title="No seasons yet"
          description="Create a season first, then build its schedule here or from its setup page."
        />
        <div className="text-center">
          <Button asChild size="sm">
            <Link href={`/${leagueSlug}/manage/seasons`}>Go to Seasons</Link>
          </Button>
        </div>
      </div>
    );
  }

  const admin = createAdminClient();
  const { count } = await admin
    .from("season_teams")
    .select("*", { count: "exact", head: true })
    .eq("season_id", ctx.season.id);

  return (
    <div className="space-y-6">
      {/*
        The season name is no longer suffixed "(active)": the season shown here
        is whichever one the switcher points at, and only some of them are. The
        switcher marks the active one in its own options instead.
      */}
      <PageHeader
        title="Schedule Builder"
        description={`${ctx.season.name} · ${count ?? 0} teams enrolled`}
      >
        <SeasonSwitcher ctx={ctx} />
      </PageHeader>
      <ScheduleBuilderPanel seasonId={ctx.season.id} league={leagueSlug} />
    </div>
  );
}
