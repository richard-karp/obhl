import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { resolveLeagueBySlug } from "@/lib/league/current";
import { getActiveContext, getManageContext } from "@/lib/queries/season";
import { canManageLeague } from "@/lib/auth/guards";
import { getEnrolledTeams } from "@/lib/queries/teams";
import { TeamLogo } from "@/components/shared/team-logo";
import { Card, CardContent } from "@/components/ui/card";
import { PageHeader } from "@/components/shared/page-header";
import { EmptyState } from "@/components/shared/empty-state";
import { NoSeason } from "@/components/public/no-season";
import { SeasonSwitcher } from "@/components/manage/season-switcher";

export const metadata: Metadata = { title: "Teams" };

export default async function TeamsPage({
  params,
  searchParams,
}: {
  params: Promise<{ league: string }>;
  searchParams: Promise<{ season?: string }>;
}) {
  const { league: leagueParam } = await params;
  const { season: seasonParam } = await searchParams;
  // ⚠️ TWO SEASONS, ONE PAGE — see the team page for the whole reasoning. A
  // manager picks a season here and follows it into the team they open; the
  // public gets the active one, and the parameter is read only after
  // `canManageLeague` says yes.
  const resolved = await resolveLeagueBySlug(leagueParam);
  if (!resolved) notFound();
  const manageCtx = (await canManageLeague(resolved.id))
    ? await getManageContext(leagueParam, seasonParam)
    : null;
  const ctx = manageCtx ?? (await getActiveContext(leagueParam));
  if (!ctx.season) return <NoSeason />;
  const slug = ctx.league.slug;
  // This absorbed `/manage/rosters`, whose one substantive difference was that
  // it read on the ADMIN client, "so a season the public-read policies don't
  // cover shows its teams rather than coming back silently empty" — a staged
  // league being exactly that case.
  //
  // That read is NOT carried over, because it turns out not to be needed:
  // 0032's "manager write teams"/"manager write season_teams" are `for all`
  // using `manages_league`, so a manager reads their own staged league's teams
  // through their own session. Measured, not assumed — reverting to this line
  // leaves the staged-league assertion in `15-league-routing.spec.ts` green,
  // which is what that assertion is now here to keep true.
  const teams = await getEnrolledTeams(ctx.season.id);

  return (
    <div className="space-y-6">
      <PageHeader title="Teams" description={ctx.season.name}>
        {/* Staff only — a visitor has one season and nothing to switch to. */}
        {manageCtx ? <SeasonSwitcher ctx={manageCtx} /> : null}
      </PageHeader>
      {teams.length === 0 ? (
        <EmptyState title="No teams enrolled yet" />
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {teams.map((t) => (
            <Link key={t.id} href={`/${slug}/teams/${t.slug}`}>
              <Card className="hover:border-primary transition-colors">
                <CardContent className="flex items-center gap-3 p-4">
                  <TeamLogo
                    name={t.name}
                    color={t.color}
                    logoPath={t.logo_path}
                    textColor={t.logo_text_color}
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
