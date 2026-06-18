import Link from "next/link";
import { getActiveContext } from "@/lib/queries/season";
import { getStandings } from "@/lib/queries/standings";
import { getSkaterLeaders } from "@/lib/queries/stats";
import { getUpcoming, getRecentResults } from "@/lib/queries/schedule";
import { getAnnouncements } from "@/lib/queries/announcements";
import { getLatestGameWithRecapData } from "@/lib/queries/games";
import { StandingsTable } from "@/components/public/standings-table";
import { GameRow } from "@/components/public/game-row";
import { TeamLogo } from "@/components/shared/team-logo";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { EmptyState } from "@/components/shared/empty-state";
import { NoSeason } from "@/components/public/no-season";
import { formatLongDate, formatGameDate } from "@/lib/format";

function SectionLink({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <Link href={href} className="text-primary text-sm font-medium hover:underline">
      {children}
    </Link>
  );
}

export default async function HomePage() {
  const ctx = await getActiveContext();
  if (!ctx?.season) return <NoSeason />;
  const { league, season } = ctx;

  const [standings, leaders, upcoming, recent, announcements, latestGame] =
    await Promise.all([
      getStandings(season.id),
      getSkaterLeaders(season.id, 8),
      getUpcoming(season.id, 5),
      getRecentResults(season.id, 5),
      getAnnouncements(league.id, 3),
      getLatestGameWithRecapData(season.id),
    ]);

  return (
    <div className="space-y-8">
      <section className="space-y-2">
        <h1 className="text-3xl font-bold tracking-tight sm:text-4xl">
          {league.name}
        </h1>
        <p className="text-muted-foreground">
          {season.name}
          {season.starts_on
            ? ` · ${formatLongDate(season.starts_on)} – ${formatLongDate(season.ends_on)}`
            : ""}
        </p>
      </section>

      {announcements.length > 0 ? (
        <Card>
          <CardHeader>
            <CardTitle>League Announcements</CardTitle>
          </CardHeader>
          <CardContent className="divide-y">
            {announcements.map((a) => (
              <div key={a.id} className="py-3 first:pt-0 last:pb-0">
                <div className="flex items-baseline justify-between gap-3">
                  <h3 className="font-semibold">{a.title}</h3>
                  <span className="text-muted-foreground shrink-0 text-xs">
                    {formatLongDate(a.published_at)}
                  </span>
                </div>
                <p className="text-muted-foreground mt-1 text-sm">{a.body}</p>
              </div>
            ))}
          </CardContent>
        </Card>
      ) : null}

      <div className="grid gap-6 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader>
            <div className="flex items-center justify-between">
              <CardTitle>Standings</CardTitle>
              <SectionLink href="/standings">Full table →</SectionLink>
            </div>
          </CardHeader>
          <CardContent>
            <StandingsTable rows={standings} />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <div className="flex items-center justify-between">
              <CardTitle>Points Leaders</CardTitle>
              <SectionLink href="/stats">All stats →</SectionLink>
            </div>
          </CardHeader>
          <CardContent className="space-y-0.5">
            {leaders.length === 0 ? (
              <EmptyState title="No stats yet" />
            ) : (
              leaders.map((p, i) => (
                <div
                  key={`${p.player_id}-${p.team_id}`}
                  className="hover:bg-muted/40 flex items-center gap-3 rounded-md px-2 py-1.5 text-sm"
                >
                  <span className="text-muted-foreground w-4 text-center text-xs">
                    {i + 1}
                  </span>
                  <TeamLogo name={p.team_name ?? ""} color={p.team_color} />
                  <span className="flex-1 truncate font-medium">
                    {p.first_name} {p.last_name}
                  </span>
                  <span className="font-bold tabular-nums">{p.pts ?? 0}</span>
                  <span className="text-muted-foreground text-xs">PTS</span>
                </div>
              ))
            )}
          </CardContent>
        </Card>
      </div>

      <div className="grid gap-6 md:grid-cols-2">
        <Card>
          <CardHeader>
            <div className="flex items-center justify-between">
              <CardTitle>Recent Results</CardTitle>
              <SectionLink href="/schedule">Schedule →</SectionLink>
            </div>
          </CardHeader>
          <CardContent className="space-y-2">
            {recent.length === 0 ? (
              <EmptyState title="No games played yet" />
            ) : (
              recent.map((g) => <GameRow key={g.id} game={g} />)
            )}
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Upcoming</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            {upcoming.length === 0 ? (
              <EmptyState title="No upcoming games" />
            ) : (
              upcoming.map((g) => <GameRow key={g.id} game={g} />)
            )}
          </CardContent>
        </Card>
      </div>

      {latestGame && latestGame.three_stars && latestGame.three_stars.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>
              3 Stars —{" "}
              <span className="text-muted-foreground font-normal text-sm">
                {latestGame.away_team_name} {latestGame.away_goals} –{" "}
                {latestGame.home_goals} {latestGame.home_team_name},{" "}
                {formatGameDate(latestGame.scheduled_at)}
              </span>
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="flex flex-wrap gap-6">
              {latestGame.three_stars.map((star, i) => (
                <Link
                  key={star.player_id}
                  href={`/players/${star.player_id}`}
                  className="hover:bg-muted/40 flex items-center gap-3 rounded-lg p-3 transition-colors"
                >
                  <span className="text-muted-foreground text-2xl font-bold tabular-nums w-6 text-center">
                    {i + 1}
                  </span>
                  <div>
                    <div className="font-semibold hover:underline">
                      {star.first_name} {star.last_name}
                    </div>
                    <div className="text-muted-foreground text-xs tabular-nums">
                      {star.g}G · {star.a}A · {star.pim}PIM
                    </div>
                  </div>
                </Link>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      {latestGame?.ai_recap && (
        <Card>
          <CardHeader>
            <CardTitle>Game Recap</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-muted-foreground text-sm leading-relaxed italic">
              &ldquo;{latestGame.ai_recap}&rdquo;
            </p>
          </CardContent>
        </Card>
      )}

      {season.ai_summary && (
        <Card>
          <CardHeader>
            <CardTitle>League Update</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-muted-foreground text-sm leading-relaxed italic">
              &ldquo;{season.ai_summary}&rdquo;
            </p>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
