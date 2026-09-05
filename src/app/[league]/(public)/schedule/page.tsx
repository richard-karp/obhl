import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { resolveLeagueBySlug } from "@/lib/league/current";
import { getActiveContext, getManageContext } from "@/lib/queries/season";
import { getSchedule, type GameWithTeams } from "@/lib/queries/schedule";
import { getEnrolledTeams } from "@/lib/queries/teams";
import { canScoreLeague } from "@/lib/auth/guards";
import Link from "next/link";
import { ScheduleFilter } from "@/components/public/schedule-filter";
import { GameRow } from "@/components/public/game-row";
import { Button } from "@/components/ui/button";
import { PageHeader } from "@/components/shared/page-header";
import { EmptyState } from "@/components/shared/empty-state";
import { NoSeason } from "@/components/public/no-season";
import { SeasonSwitcher } from "@/components/manage/season-switcher";
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
  league,
  canScore,
}: {
  groups: ReturnType<typeof groupByDate>;
  league: string;
  /** Draw a Score button per game. See `canScoreLeague` — it is not a guard. */
  canScore: boolean;
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
              <GameRow
                key={g.id}
                game={g}
                league={league}
                scoreHref={
                  canScore ? `/${league}/games/${g.id}/score` : undefined
                }
              />
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}

export default async function SchedulePage({
  params,
  searchParams,
}: {
  params: Promise<{ league: string }>;
  searchParams: Promise<{ team?: string; season?: string }>;
}) {
  const { league: leagueParam } = await params;
  const { team, season: seasonParam } = await searchParams;

  // This page absorbed `/manage/score`, which was the same games in a table
  // with a button on each row. The games are the same games; the button is the
  // only thing that was ever different.
  //
  // ⚠️ TWO SEASONS, ONE PAGE, the same split as the team page. `/manage/score`
  // gained a season switcher — `is_active` means "what the public site shows",
  // and both importers create seasons inactive, so a scorekeeper pinned to the
  // active season cannot work an imported one. That has to survive the merge:
  // staff resolve through `getManageContext` and may name a season, everyone
  // else gets the active one. The parameter is read only after `canScoreLeague`
  // says yes, so a visitor cannot reach an unpublished season by guessing it.
  const resolved = await resolveLeagueBySlug(leagueParam);
  if (!resolved) notFound();
  const canScore = await canScoreLeague(resolved.id);
  const manageCtx = canScore
    ? await getManageContext(leagueParam, seasonParam)
    : null;
  const ctx = manageCtx ?? (await getActiveContext(leagueParam));
  if (!ctx.season) return <NoSeason />;
  const slug = ctx.league.slug;
  const teams = await getEnrolledTeams(ctx.season.id);
  const selected = team ? teams.find((t) => t.slug === team) : undefined;
  const games = await getSchedule(ctx.season.id, { teamId: selected?.id });

  // Anchor on "now": upcoming games first (next up), then recent results
  // (most recently played first) — instead of opening at the season's start.
  const upcoming = games.filter(
    (g) => g.status !== "final" && g.status !== "cancelled",
  );
  const results = games.filter((g) => g.status === "final").reverse();
  const upcomingGroups = groupByDate(upcoming);
  const resultGroups = groupByDate(results);

  // ⛔ Cancelled games are in NEITHER group above — not upcoming, not final —
  // which is right for a visitor and was a regression for everyone else.
  // `/manage/score` listed `getSchedule()` unfiltered, so a manager found a
  // cancelled game there and clicked through to restore it. Absorbing that list
  // into this page removed the only route to `restoreGame` while leaving the
  // ability in place, and `game-row.tsx`'s `cancelled → "Manage"` label became
  // unreachable — the tell that the button had nothing left to sit on.
  //
  // Shown only to someone who can act on them: to a visitor a cancelled game is
  // noise, and acting on it is the whole reason this section exists.
  const cancelled = canScore
    ? groupByDate(games.filter((g) => g.status === "cancelled"))
    : [];

  return (
    <div className="space-y-8">
      <PageHeader title="Schedule" description={ctx.season.name}>
        {/* Staff only — a visitor has one season and nothing to switch to. */}
        {manageCtx ? <SeasonSwitcher ctx={manageCtx} /> : null}
        <ScheduleFilter teams={teams} value={selected?.slug} />
        {/*
          `/manage/score`'s header also held a "Schedule a one-off game" button,
          and it is deliberately NOT carried here. `canScore` admits
          scorekeepers, who cannot reach the builder at all, so drawing it on
          this shared page would offer two of the three entitled roles a control
          their own guard refuses. It stays where it belongs and is still
          reachable: the Schedule Builder page links to it twice.
        */}
        <Button asChild variant="outline" size="sm">
          <Link href={`/api/schedule/${ctx.season.id}`}>Download .ics</Link>
        </Button>
        {/* Always the full season — a filtered export would make the button's
            output depend on page state the downloaded file can't show. */}
        <Button asChild variant="outline" size="sm">
          <Link href={`/api/schedule/${ctx.season.id}/schedule.csv`}>
            Download .csv
          </Link>
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
              <GroupedGames
                groups={upcomingGroups}
                league={slug}
                canScore={canScore}
              />
            )}
          </section>

          {resultGroups.length > 0 ? (
            <section className="space-y-4">
              <h2 className="text-lg font-bold tracking-tight">
                Recent Results
              </h2>
              <GroupedGames
                groups={resultGroups}
                league={slug}
                canScore={canScore}
              />
            </section>
          ) : null}

          {cancelled.length > 0 ? (
            <section className="space-y-4">
              <h2 className="text-lg font-bold tracking-tight">Cancelled</h2>
              <GroupedGames
                groups={cancelled}
                league={slug}
                canScore={canScore}
              />
            </section>
          ) : null}
        </div>
      )}
    </div>
  );
}
