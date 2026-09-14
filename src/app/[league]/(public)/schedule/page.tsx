import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { resolveLeagueBySlug } from "@/lib/league/current";
import { getActiveContext, getManageContext } from "@/lib/queries/season";
import {
  getSchedule,
  getSeasonNights,
  type GameWithTeams,
} from "@/lib/queries/schedule";
import { getEnrolledTeams } from "@/lib/queries/teams";
import { canManageLeague, canScoreLeague } from "@/lib/auth/guards";
import { isPastGame } from "@/lib/games/open-past";
import Link from "next/link";
import { ScheduleFilter } from "@/components/public/schedule-filter";
import {
  ScheduleViews,
  resolveScheduleView,
} from "@/components/public/schedule-views";
import { GameRow } from "@/components/public/game-row";
import { Button } from "@/components/ui/button";
import { PageHeader } from "@/components/shared/page-header";
import { EmptyState } from "@/components/shared/empty-state";
import { NoSeason } from "@/components/public/no-season";
import { SeasonSwitcher } from "@/components/manage/season-switcher";
import {
  formatLongDate,
  isOnLeagueDate,
  leagueDateKey,
  leagueTimeKey,
  leagueToday,
} from "@/lib/format";
import {
  ScheduleEditPanel,
  type EditableGame,
} from "@/components/manage/schedule-edit-panel";
import { RescheduleNightForm } from "@/components/manage/reschedule-night-form";

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

// ⛔ Only games whose button says "Score": a game is cancelled in advance, so a blanket future check takes
// its "Manage" (restore) button away. ⚠️ League date keys, not timestamps, like `isPast` below.
function isUnplayedFutureFixture(
  game: Pick<GameWithTeams, "status" | "scheduled_at">,
  today: string,
): boolean {
  if (game.status !== "scheduled" && game.status !== "in_progress") {
    return false;
  }
  return !!game.scheduled_at && leagueDateKey(game.scheduled_at) > today;
}

function GroupedGames({
  groups,
  league,
  canScore,
  canManage,
  today,
}: {
  groups: ReturnType<typeof groupByDate>;
  league: string;
  /** Draw a Score button per game. See `canScoreLeague` — it is not a guard. */
  canScore: boolean;
  /** A manager's button covers today and the past; a scorekeeper's, today. ⛔ Neither gets an unplayed game. */
  canManage: boolean;
  /** Tonight, in the league zone, resolved once per render. */
  today: string;
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
                // ⛔ Not just `canScore`: the scoresheet bounces a scorekeeper from any game not today.
                // ⛔ Never an unplayed fixture, for anyone; "Manage" is exempt (`isUnplayedFutureFixture`).
                scoreHref={
                  canScore && !isUnplayedFutureFixture(g, today)
                    ? canManage || isOnLeagueDate(g.scheduled_at, today)
                      ? `/${league}/games/${g.id}/score`
                      : undefined
                    : undefined
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
  searchParams: Promise<{ team?: string; season?: string; view?: string }>;
}) {
  const { league: leagueParam } = await params;
  const { team, season: seasonParam, view: viewParam } = await searchParams;
  const view = resolveScheduleView(viewParam);

  // ⚠️ Staff may name a season through `getManageContext` (imported seasons start inactive). `?season=`
  // is read only after `canScoreLeague`, so a visitor cannot reach an unpublished season by guessing.
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

  // Built from `selected`, not the raw `team` param: an unknown slug leaves the list unfiltered, and must
  // not make the export buttons ask for a team the season lacks and turn a download into a 404.
  const exportQuery = selected
    ? `?team=${encodeURIComponent(selected.slug)}`
    : "";

  // ⛔ Rebuilt from `selected` too: a view link passing an unknown slug would claim a filter the list
  // lacks. `season` is copied through for staff pinned to a season by the switcher.
  const viewQuery = new URLSearchParams();
  if (selected) viewQuery.set("team", selected.slug);
  if (manageCtx && seasonParam) viewQuery.set("season", seasonParam);

  const today = leagueToday();

  // ⚠️ The league's calendar date, not `Date.parse(...) < Date.now()`: a 21:40 game is still tonight's at
  // 22:00, while its scoresheet is being filled in.
  const isPast = (g: GameWithTeams) => isPastGame(g, today);

  // ⛔ Upcoming is future-or-today, not merely "not final", or an unscored game sits under Upcoming for
  // the rest of the season.
  const upcoming = games.filter(
    (g) => g.status !== "final" && g.status !== "cancelled" && !isPast(g),
  );
  // ⛔ Played and still without a result, shown to everyone and first: the only part anyone must act on.
  // Cancelled is excluded; it has its own section.
  const awaitingScore = games.filter(
    (g) => g.status !== "final" && g.status !== "cancelled" && isPast(g),
  );
  const results = games.filter((g) => g.status === "final").reverse();
  const awaitingGroups = groupByDate(awaitingScore).reverse();
  const upcomingGroups = groupByDate(upcoming);
  const resultGroups = groupByDate(results);

  // ⛔ Cancelled games are in neither group above, and this list is the only route to `restoreGame`.
  // Shown only to someone who can act on them.
  const cancelled = canScore
    ? groupByDate(games.filter((g) => g.status === "cancelled"))
    : [];

  // ⛔ `canManageLeague`, not `canScore`: `canScore` admits scorekeepers, so an edit panel drawn on it
  // would offer them a control their own guard refuses.
  const canManage = await canManageLeague(resolved.id);
  // ⛔ The await is gated, not just the JSX: most traffic is anonymous and must not pay for this read.
  const openNights = canManage
    ? (await getSeasonNights(ctx.season.id)).filter((n) => !n.locked)
    : [];
  const editable: EditableGame[] = canManage
    ? games
        // ⛔ `=== "scheduled"`, not `!== "final"`: cancelled games keep their date, and the write path
        // refuses them. Postponed games have no date.
        .filter((g) => g.status === "scheduled" && g.scheduled_at)
        .map((g) => ({
          id: g.id,
          label: `${g.away_team?.name ?? "?"} @ ${g.home_team?.name ?? "?"} — ${formatLongDate(g.scheduled_at!)}`,
          night: leagueDateKey(g.scheduled_at!),
          localAt: `${leagueDateKey(g.scheduled_at!)}T${leagueTimeKey(g.scheduled_at!)}`,
          homeId: g.home_team?.id ?? "",
          awayId: g.away_team?.id ?? "",
          homeName: g.home_team?.name ?? "?",
          awayName: g.away_team?.name ?? "?",
        }))
    : [];

  return (
    <div className="space-y-8">
      <PageHeader title="Schedule" description={ctx.season.name}>
        {/* Staff only — a visitor has one season and nothing to switch to. */}
        {manageCtx ? <SeasonSwitcher ctx={manageCtx} /> : null}
        <ScheduleFilter teams={teams} value={selected?.slug} />
        {/*
          No one-off button here: `canScore` admits scorekeepers, who cannot reach the builder.
        */}
        {/*
          ⚠️ Both downloads must carry the team filter, or "pick a team, download" returns every team's
          games; the routes name the team in the file (`RUNBOOK.md` → Schedule edits and exports).
        */}
        <Button asChild variant="outline" size="sm">
          <Link href={`/api/schedule/${ctx.season.id}${exportQuery}`}>
            Download .ics
          </Link>
        </Button>
        <Button asChild variant="outline" size="sm">
          <Link
            href={`/api/schedule/${ctx.season.id}/schedule.csv${exportQuery}`}
          >
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
          {canManage ? (
            <div className="space-y-3">
              <ScheduleEditPanel
                games={editable}
                teams={teams.map((t) => ({ id: t.id, name: t.name }))}
              />
              {/*
                ⛔ Moving a night belongs here: once `season_is_started`, this page is a manager's whole surface.
                ⚠️ Gated on the season having games, not movable ones: the form explains when none are left.
              */}
              <div className="space-y-2 rounded-lg border p-3">
                <h3 className="text-sm font-semibold">Move a game night</h3>
                <RescheduleNightForm
                  seasonId={ctx.season.id}
                  nights={openNights.map((n) => ({
                    date: n.date,
                    games: n.games.length,
                  }))}
                  // Server-side in the league's zone: the browser's clock is a day off for anyone travelling.
                  minDate={today}
                  maxDate={ctx.season.ends_on ?? null}
                />
              </div>

              {/*
                ⚠️ Also linked from the builder's locked card, which names them as what is still possible.
              */}
              <p className="text-muted-foreground text-sm">
                Bigger changes:{" "}
                <Link
                  href={`/${slug}/schedule/repair`}
                  className="text-foreground font-medium underline"
                >
                  repair the schedule
                </Link>{" "}
                to even out the nights still to come, or{" "}
                <Link
                  href={`/${slug}/schedule/one-off`}
                  className="text-foreground font-medium underline"
                >
                  schedule a one-off game
                </Link>{" "}
                for a final or semifinal.
              </p>
            </div>
          ) : null}

          {/*
            ⛔ The view row stays below the manager block: those tools act on the season, not on the list
            showing, and inside a view they would hide behind a link.
          */}
          <ScheduleViews
            league={slug}
            current={view}
            awaitingCount={awaitingScore.length}
            query={viewQuery.toString()}
          />

          {/*
            ⛔ `resolveScheduleView` does not know the count, so `pending` must survive being empty (a stale
            link): an empty state, where an absent section would read as a broken page.
          */}
          {view === "pending" ? (
            <section className="space-y-4">
              <h2 className="text-lg font-bold tracking-tight">Pending</h2>
              {awaitingGroups.length === 0 ? (
                <EmptyState title="Every game played has a result" />
              ) : (
                <>
                  <p className="text-muted-foreground text-sm">
                    {awaitingScore.length} game
                    {awaitingScore.length === 1 ? "" : "s"} played with no
                    result recorded yet.
                  </p>
                  {/* Most recent first: the night just gone is the one being
                      chased, and an older one is a bigger problem the further
                      down it sits. */}
                  <GroupedGames
                    groups={awaitingGroups}
                    league={slug}
                    canScore={canScore}
                    canManage={canManage}
                    today={today}
                  />
                </>
              )}
            </section>
          ) : null}

          {view === "upcoming" ? (
            <>
              <section className="space-y-4">
                <h2 className="text-lg font-bold tracking-tight">Upcoming</h2>
                {upcomingGroups.length === 0 ? (
                  <EmptyState title="No upcoming games" />
                ) : (
                  <GroupedGames
                    groups={upcomingGroups}
                    league={slug}
                    canScore={canScore}
                    canManage={canManage}
                    today={today}
                  />
                )}
              </section>

              {/*
                ⛔ Cancelled belongs with Upcoming, not Results: it has no result, and this section is the
                only route to `restoreGame`.
              */}
              {cancelled.length > 0 ? (
                <section className="space-y-4">
                  <h2 className="text-lg font-bold tracking-tight">
                    Cancelled
                  </h2>
                  <GroupedGames
                    groups={cancelled}
                    league={slug}
                    canScore={canScore}
                    canManage={canManage}
                    today={today}
                  />
                </section>
              ) : null}
            </>
          ) : null}

          {view === "results" ? (
            <section className="space-y-4">
              <h2 className="text-lg font-bold tracking-tight">Results</h2>
              {resultGroups.length === 0 ? (
                <EmptyState title="No games played yet" />
              ) : (
                <GroupedGames
                  groups={resultGroups}
                  league={slug}
                  canScore={canScore}
                  canManage={canManage}
                  today={today}
                />
              )}
            </section>
          ) : null}
        </div>
      )}
    </div>
  );
}
