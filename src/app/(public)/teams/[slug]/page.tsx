import { notFound } from "next/navigation";
import { getActiveContext } from "@/lib/queries/season";
import { getTeamBySlug } from "@/lib/queries/teams";
import {
  TeamPlayerTable,
  type TeamPlayerRow,
} from "@/components/public/team-player-table";
import { GoalieStatsTable } from "@/components/public/goalie-stats-table";
import { GameRow } from "@/components/public/game-row";
import { TeamLogo } from "@/components/shared/team-logo";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { EmptyState } from "@/components/shared/empty-state";
import { NoSeason } from "@/components/public/no-season";

export default async function TeamPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const ctx = await getActiveContext();
  if (!ctx?.season) return <NoSeason />;

  const detail = await getTeamBySlug(ctx.league.id, ctx.season.id, slug);
  if (!detail) notFound();

  let w = 0;
  let l = 0;
  let t = 0;
  for (const g of detail.games) {
    if (g.status !== "final") continue;
    const isHome = g.home_team?.id === detail.team.id;
    const us = isHome ? g.home_goals : g.away_goals;
    const them = isHome ? g.away_goals : g.home_goals;
    if (us > them) w++;
    else if (us < them) l++;
    else t++;
  }

  // Combined roster + skater stats (one team, so position replaces team).
  const statByPlayer = new Map(detail.skaters.map((s) => [s.player_id, s]));
  const inRoster = new Set(detail.roster.map((r) => r.player_id));
  const players: TeamPlayerRow[] = detail.roster.map((r) => {
    const s = statByPlayer.get(r.player_id);
    return {
      player_id: r.player_id,
      number: r.jersey_number,
      name: `${r.first_name} ${r.last_name}`,
      position: r.position,
      is_captain: r.is_captain,
      gp: s?.gp ?? 0,
      g: s?.g ?? 0,
      a: s?.a ?? 0,
      pts: s?.pts ?? 0,
      pim: s?.pim ?? 0,
    };
  });
  // Include anyone with stats who isn't on the current roster (rare).
  for (const s of detail.skaters) {
    if (!s.player_id || inRoster.has(s.player_id)) continue;
    players.push({
      player_id: s.player_id,
      number: s.jersey_number,
      name: `${s.first_name ?? ""} ${s.last_name ?? ""}`.trim(),
      position: s.position ?? "F",
      is_captain: false,
      gp: s.gp ?? 0,
      g: s.g ?? 0,
      a: s.a ?? 0,
      pts: s.pts ?? 0,
      pim: s.pim ?? 0,
    });
  }
  players.sort(
    (a, b) => b.pts - a.pts || (a.number ?? 999) - (b.number ?? 999),
  );

  return (
    <div className="space-y-6">
      <div
        className="flex items-center gap-4 border-b pb-4"
        style={{ borderColor: detail.team.color ?? undefined }}
      >
        <TeamLogo
          name={detail.team.name}
          color={detail.team.color}
          logoPath={detail.team.logo_path}
          className="size-12 text-base"
        />
        <div>
          <h1 className="text-2xl font-bold tracking-tight">{detail.team.name}</h1>
          <p className="text-muted-foreground text-sm">
            {w}-{l}-{t} · {ctx.season.name}
          </p>
        </div>
      </div>

      <Tabs defaultValue="roster" className="space-y-4">
        <TabsList>
          <TabsTrigger value="roster">Roster &amp; Stats</TabsTrigger>
          <TabsTrigger value="schedule">Schedule</TabsTrigger>
        </TabsList>

        <TabsContent value="roster" className="space-y-6">
          {players.length === 0 ? (
            <EmptyState title="No players on the roster yet" />
          ) : (
            <TeamPlayerTable rows={players} />
          )}
          {detail.goalies.length > 0 ? (
            <div className="space-y-2">
              <h2 className="text-muted-foreground text-sm font-semibold">
                Goaltending
              </h2>
              <GoalieStatsTable rows={detail.goalies} />
            </div>
          ) : null}
        </TabsContent>

        <TabsContent value="schedule" className="space-y-2">
          <a
            href={`/api/schedule/team/${detail.team.id}/feed.ics`}
            className="text-primary inline-block text-sm hover:underline"
          >
            Add to calendar (.ics) →
          </a>
          {detail.games.length === 0 ? (
            <EmptyState title="No games scheduled" />
          ) : (
            detail.games.map((g) => <GameRow key={g.id} game={g} />)
          )}
        </TabsContent>
      </Tabs>
    </div>
  );
}
