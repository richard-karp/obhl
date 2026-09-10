import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { resolveLeagueBySlug } from "@/lib/league/current";
import { getActiveContext, getManageContext } from "@/lib/queries/season";
import { getSchedule, type GameWithTeams } from "@/lib/queries/schedule";
import { getEnrolledTeams } from "@/lib/queries/teams";
import { canManageLeague, canScoreLeague } from "@/lib/auth/guards";
import Link from "next/link";
import { ScheduleFilter } from "@/components/public/schedule-filter";
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
  canManage,
  today,
}: {
  groups: ReturnType<typeof groupByDate>;
  league: string;
  /** Draw a Score button per game. See `canScoreLeague` — it is not a guard. */
  canScore: boolean;
  /**
   * Whether the viewer is a MANAGER, which decides whether the button appears on
   * games that are not today. Managers keep every button; a scorekeeper only
   * gets tonight's, because the scoresheet now refuses them any other date.
   */
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
                // ⛔ NOT JUST `canScore`. The scoresheet refuses a scorekeeper
                // any game that is not today, so drawing the button on a game
                // 120 days old would offer a control whose only outcome is a
                // bounce back to `/manage/tonight`. A button that cannot work is
                // worse than no button: it reads as a broken page rather than as
                // a boundary. Managers are unaffected — they have no day limit.
                scoreHref={
                  canScore &&
                  (canManage || isOnLeagueDate(g.scheduled_at, today))
                    ? `/${league}/games/${g.id}/score`
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

  // The same filter the list above is built from, handed to the export routes.
  // Derived from `selected` rather than the raw `team` param so an unknown slug
  // — which leaves the list unfiltered — cannot make the buttons ask for a team
  // the season does not hold and turn a download into a 404.
  const exportQuery = selected
    ? `?team=${encodeURIComponent(selected.slug)}`
    : "";

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

  // ⛔ `canManageLeague`, NOT `canScore`. This page is shared — see the note in
  // the header about the one-off button that was deliberately kept off it,
  // because `canScore` admits scorekeepers, who cannot reach the builder. The
  // edit panel is the same trap: drawing it on `canScore` would offer two of
  // three entitled roles a control their own guard refuses.
  const canManage = await canManageLeague(resolved.id);
  // Resolved once for the whole render: three `GroupedGames` ask, and the answer
  // cannot change mid-render.
  const today = leagueToday();
  const editable: EditableGame[] = canManage
    ? games
        // ⛔ `=== "scheduled"`, not `!== "final"`. Cancelled games keep their date,
        // so the looser test offered them here while the write path refused
        // them — a picker full of choices that always failed. Postponed games
        // have no date and were already excluded.
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
          `/manage/score`'s header also held a "Schedule a one-off game" button,
          and it is deliberately NOT carried here. `canScore` admits
          scorekeepers, who cannot reach the builder at all, so drawing it on
          this shared page would offer two of the three entitled roles a control
          their own guard refuses. It stays where it belongs and is still
          reachable: the Schedule Builder page links to it twice.
        */}
        {/*
          ⚠️ BOTH DOWNLOADS CARRY THE TEAM FILTER, and they must keep carrying
          it. Until they did, the list narrowed to the selected team and the two
          buttons kept pointing at the bare season, so "pick a team, download"
          returned all six teams' games — and the .ics dropped a whole season
          into a calendar someone had filtered a single team out of.

          The rule these replaced said the export was "always the full season"
          because a filtered file could not show which state produced it. That
          objection is answered rather than ignored: the routes put the team in
          the filename and in the calendar's name, so the file says whose
          schedule it is without the page being present to explain it. Restoring
          the unfiltered link would reopen the bug; dropping the naming would
          reopen the objection.
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
                The other two in-season tools, reachable from where a manager
                actually looks at games. ⚠️ They are NOT removed from the
                builder: its locked card names them as the things still
                possible once generate/replace/remove are gone, which is the
                one place that message belongs. Reachable from both, hidden in
                neither.
              */}
              <p className="text-muted-foreground text-sm">
                Bigger changes:{" "}
                <Link
                  href={`/${slug}/schedule-builder/repair`}
                  className="text-foreground font-medium underline"
                >
                  repair the schedule
                </Link>{" "}
                to even out the nights still to come, or{" "}
                <Link
                  href={`/${slug}/schedule-builder/one-off`}
                  className="text-foreground font-medium underline"
                >
                  schedule a one-off game
                </Link>{" "}
                for a final or semifinal.
              </p>
            </div>
          ) : null}

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

          {resultGroups.length > 0 ? (
            <section className="space-y-4">
              <h2 className="text-lg font-bold tracking-tight">
                Recent Results
              </h2>
              <GroupedGames
                groups={resultGroups}
                league={slug}
                canScore={canScore}
                canManage={canManage}
                today={today}
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
                canManage={canManage}
                today={today}
              />
            </section>
          ) : null}
        </div>
      )}
    </div>
  );
}
