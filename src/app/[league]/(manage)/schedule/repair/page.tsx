import { notFound } from "next/navigation";
import Link from "next/link";
import { requireLeagueManager } from "@/lib/auth/guards";
import { createAdminClient } from "@/utils/supabase/admin";
import { resolveLeagueBySlug } from "@/lib/league/current";
import { getManageContext } from "@/lib/queries/season";
import { getEnrolledTeams } from "@/lib/queries/teams";
import { getSeasonNights } from "@/lib/queries/schedule";
import { ScheduleRepairForm } from "@/components/manage/schedule-repair-form";
import { PageHeader } from "@/components/shared/page-header";
import { EmptyState } from "@/components/shared/empty-state";
import { Button } from "@/components/ui/button";
import { SeasonSwitcher } from "@/components/manage/season-switcher";
import { leagueTimeKey } from "@/lib/format";

/**
 * Repair a published schedule — with a team pinned to a night (item 3) or with
 * no pin at all (item 4).
 *
 * ⛔ Deliberately not part of the schedule builder's generate flow. Generate,
 * replace and remove all refuse permanently once `season_is_started` trips, and
 * this page is the one that has to keep working afterwards: it plans over the
 * unlocked nights and applies the plan as an in-place UPDATE of the rows that
 * change — never an upsert, which would re-create a deleted game as a live
 * fixture. See `applyGameWrites`.
 */
export default async function ScheduleRepairPage({
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
  const league = await resolveLeagueBySlug(leagueParam);
  if (!league) notFound();
  await requireLeagueManager(league.id);
  const ctx = await getManageContext(leagueParam, seasonParam);
  const leagueSlug = ctx.league.slug;
  if (!ctx.season) {
    return (
      <div className="space-y-4">
        <EmptyState
          title="No seasons yet"
          description="Create a season and publish its schedule before repairing it."
        />
        <div className="text-center">
          <Button asChild size="sm">
            <Link href={`/${leagueSlug}/seasons`}>Go to Seasons</Link>
          </Button>
        </div>
      </div>
    );
  }

  // Read past RLS, matching the actions this page submits to — otherwise a
  // season the public-read policies don't cover renders "no published schedule"
  // here while `previewScheduleRepair` sees the schedule fine.
  const admin = createAdminClient();
  const [teams, nights] = await Promise.all([
    getEnrolledTeams(ctx.season.id, { client: admin }),
    getSeasonNights(ctx.season.id, { client: admin }),
  ]);

  const openNights = nights.filter((n) => !n.locked);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Repair the schedule"
        description={`${ctx.season.name} · rearrange the nights still to come`}
      >
        <SeasonSwitcher ctx={ctx} />
        <Button asChild size="sm" variant="outline">
          <Link href={`/${leagueSlug}/schedule`}>Schedule</Link>
        </Button>
      </PageHeader>

      {nights.length === 0 ? (
        <EmptyState
          title="No published schedule"
          description="Generate and publish a schedule first — a repair rearranges games that already exist."
        />
      ) : openNights.length === 0 ? (
        <EmptyState
          title="No nights left to repair"
          description="Every remaining game night has already been played or is in the past."
        />
      ) : (
        <ScheduleRepairForm
          seasonId={ctx.season.id}
          teams={teams.map((t) => ({ id: t.id, name: t.name }))}
          nights={openNights.map((n) => ({
            date: n.date,
            // The ice times this night ACTUALLY runs, read off the published
            // games — the list the pin resolves against server-side. A
            // postponed game has no time of its own and shows the same
            // placeholder the planner uses, so the slot indexes line up.
            times: n.games.map((g) =>
              g.scheduledAt ? leagueTimeKey(g.scheduledAt) : "--:--",
            ),
          }))}
        />
      )}
    </div>
  );
}
