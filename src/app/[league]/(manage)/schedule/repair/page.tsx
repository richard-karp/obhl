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

// ⛔ Not part of generate, which refuses once `season_is_started`: repair must keep working, as an UPDATE
// by id through `writeGames`, never an upsert (`RUNBOOK.md` → Schedule edits and exports).
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

  // Read past RLS, matching the actions: otherwise a season public reads don't cover shows "no published
  // schedule" here while `previewScheduleRepair` sees it fine.
  const admin = createAdminClient();
  const [teams, nights] = await Promise.all([
    getEnrolledTeams(ctx.season.id, { client: admin }),
    getSeasonNights(ctx.season.id, { client: admin }),
  ]);

  const openNights = nights.nights.filter((n) => !n.locked);

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

      {/* ⛔ Before the "no published schedule" arm, which is what a failed read would otherwise
          render — telling a manager their season has no schedule because we could not read it. */}
      {nights.readFailed ? (
        <EmptyState
          title="Couldn't load this season's schedule"
          description="Something went wrong reading its game nights — this is not the same as there being none. Reload, and try again."
        />
      ) : nights.nights.length === 0 ? (
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
            // The ice times this night actually runs, which the pin resolves against server-side. A postponed
            // game has no time, so it shows the planner's placeholder and the slot indexes line up.
            times: n.games.map((g) =>
              g.scheduledAt ? leagueTimeKey(g.scheduledAt) : "--:--",
            ),
          }))}
        />
      )}
    </div>
  );
}
