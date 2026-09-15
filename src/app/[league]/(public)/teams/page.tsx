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
  // ⚠️ `?season=` is read only after `canManageLeague`; the public gets the active season.
  const resolved = await resolveLeagueBySlug(leagueParam);
  if (!resolved) notFound();
  const manageCtx = (await canManageLeague(resolved.id))
    ? await getManageContext(leagueParam, seasonParam)
    : null;
  const ctx = manageCtx ?? (await getActiveContext(leagueParam));
  // ⚠️ Only the public context reports a failed read; `getManageContext` gets the plain message.
  if (!ctx.season)
    return (
      <NoSeason
        readFailed={"seasonReadFailed" in ctx && ctx.seasonReadFailed}
      />
    );
  const slug = ctx.league.slug;
  // No admin client needed: 0032's `manages_league` policies let a manager read their own staged league's
  // teams, which `e2e/09-access.spec.ts` asserts.
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
