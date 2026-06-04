import type { Metadata } from "next";
import { getActiveContext } from "@/lib/queries/season";
import { getSchedule, type GameWithTeams } from "@/lib/queries/schedule";
import { getEnrolledTeams } from "@/lib/queries/teams";
import Link from "next/link";
import { ScheduleFilter } from "@/components/public/schedule-filter";
import { GameRow } from "@/components/public/game-row";
import { Button } from "@/components/ui/button";
import { PageHeader } from "@/components/shared/page-header";
import { EmptyState } from "@/components/shared/empty-state";
import { NoSeason } from "@/components/public/no-season";
import { formatLongDate, leagueDateKey } from "@/lib/format";

export const metadata: Metadata = { title: "Schedule" };

function groupByDate(games: GameWithTeams[]) {
  const groups: { key: string; label: string; games: GameWithTeams[] }[] = [];
  for (const g of games) {
    const key = g.scheduled_at ? leagueDateKey(g.scheduled_at) : "tbd";
    let last = groups[groups.length - 1];
    if (!last || last.key !== key) {
      last = {
        key,
        label: g.scheduled_at ? formatLongDate(g.scheduled_at) : "Date TBD",
        games: [],
      };
      groups.push(last);
    }
    last.games.push(g);
  }
  return groups;
}

function GroupedGames({
  groups,
}: {
  groups: ReturnType<typeof groupByDate>;
}) {
  return (
    <div className="space-y-6">
      {groups.map((group) => (
        <section key={group.key} className="space-y-2">
          <h3 className="text-muted-foreground text-sm font-semibold">
            {group.label}
          </h3>
          <div className="space-y-2">
            {group.games.map((g) => (
              <GameRow key={g.id} game={g} />
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}

export default async function SchedulePage({
  searchParams,
}: {
  searchParams: Promise<{ team?: string }>;
}) {
  const ctx = await getActiveContext();
  if (!ctx?.season) return <NoSeason />;
  const { team } = await searchParams;

  const teams = await getEnrolledTeams(ctx.season.id);
  const selected = team ? teams.find((t) => t.slug === team) : undefined;
  const games = await getSchedule(ctx.season.id, selected?.id);

  // Anchor on "now": upcoming games first (next up), then recent results
  // (most recently played first) — instead of opening at the season's start.
  const upcoming = games.filter(
    (g) => g.status !== "final" && g.status !== "cancelled",
  );
  const results = games.filter((g) => g.status === "final").reverse();
  const upcomingGroups = groupByDate(upcoming);
  const resultGroups = groupByDate(results);

  return (
    <div className="space-y-8">
      <PageHeader title="Schedule" description={ctx.season.name}>
        <ScheduleFilter teams={teams} value={selected?.slug} />
        <Button asChild variant="outline" size="sm">
          <Link href={`/api/schedule/${ctx.season.id}`}>Download .ics</Link>
        </Button>
      </PageHeader>

      {games.length === 0 ? (
        <EmptyState
          title="No games scheduled"
          description={
            selected
              ? `${selected.name} has no games yet.`
              : "The schedule hasn't been built yet."
          }
        />
      ) : (
        <div className="space-y-10">
          <section className="space-y-4">
            <h2 className="text-lg font-bold tracking-tight">Upcoming</h2>
            {upcomingGroups.length === 0 ? (
              <EmptyState title="No upcoming games" />
            ) : (
              <GroupedGames groups={upcomingGroups} />
            )}
          </section>

          {resultGroups.length > 0 ? (
            <section className="space-y-4">
              <h2 className="text-lg font-bold tracking-tight">Recent Results</h2>
              <GroupedGames groups={resultGroups} />
            </section>
          ) : null}
        </div>
      )}
    </div>
  );
}
