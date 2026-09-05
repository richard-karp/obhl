import { notFound } from "next/navigation";
import { getActiveContext } from "@/lib/queries/season";
import { getTeamBySlug } from "@/lib/queries/teams";
import { canManageLeague } from "@/lib/auth/guards";
import { RosterEditor } from "@/components/manage/roster-editor";
import {
  TeamPlayerTable,
  type TeamPlayerRow,
} from "@/components/public/team-player-table";
import { GoalieStatsTable } from "@/components/public/goalie-stats-table";
import { GameRow } from "@/components/public/game-row";
import { TeamLogo } from "@/components/shared/team-logo";
import { TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { TeamTabs } from "@/components/manage/team-tabs";
import { EmptyState } from "@/components/shared/empty-state";
import { NoSeason } from "@/components/public/no-season";

/**
 * A team — one URL, for everybody.
 *
 * This absorbed `/manage/rosters/<uuid>`, which showed the same team to its
 * manager behind an id nobody could read or share. The public content is
 * unchanged and unconditional; a manager of THIS league gets one more tab.
 *
 * ⚠️ The team is resolved by SLUG WITHIN THE LEAGUE, which is what makes the old
 * page's ownership check unnecessary rather than merely absent — see the note on
 * `RosterEditor`.
 */
export default async function TeamPage({
  params,
  searchParams,
}: {
  params: Promise<{ league: string; slug: string }>;
  // Next's own type is `string | string[] | undefined`; a repeated `?tab=` gives
  // the array. Narrowed at the comparison rather than lied about here.
  searchParams: Promise<{ tab?: string | string[] }>;
}) {
  const { league: leagueParam, slug } = await params;
  const ctx = await getActiveContext(leagueParam);
  if (!ctx.season) return <NoSeason />;
  const league = ctx.league.slug;

  const detail = await getTeamBySlug(ctx.league.id, ctx.season.id, slug);
  if (!detail) notFound();
  const canEdit = await canManageLeague(ctx.league.id);

  // ⛔ The tab has to be in the URL, and this is why: Radix unmounts inactive tab
  // content on the CLIENT, but the server renders every branch it is given. So a
  // `<TabsContent>` holding `RosterEditor` runs its four admin queries — one of
  // them over the whole `players` table — on every manager's casual look at a
  // team page, and serialises the result into the payload, whether or not anyone
  // opens the tab. Before the merge that cost was paid only by someone who
  // deliberately navigated to the editor's own URL.
  //
  // Deep-linking is the same mechanism seen from the other side: `?tab=manage`
  // is now a shareable address for the editor, which the uncontrolled Radix
  // state never was.
  const { tab } = await searchParams;
  const editing = canEdit && tab === "manage";

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
          <h1 className="text-2xl font-bold tracking-tight">
            {detail.team.name}
          </h1>
          <p className="text-muted-foreground text-sm">
            {w}-{l}-{t} · {ctx.season.name}
          </p>
        </div>
      </div>

      {/*
        Uncontrolled, so the two public tabs still switch instantly on the client
        the way they always have. Only Manage goes through the URL, because only
        Manage has server work behind it.
      */}
      <TeamTabs
        tab={editing ? "manage" : "roster"}
        baseHref={`/${league}/teams/${slug}`}
      >
        <TabsList>
          <TabsTrigger value="roster">Roster &amp; Stats</TabsTrigger>
          <TabsTrigger value="schedule">Schedule</TabsTrigger>
          {/*
            A tab rather than a section below the roster: the public content is
            what this page is, and the editing surface is a place a manager goes
            rather than a thing every visitor scrolls past. It is also what keeps
            the page from becoming the 500-line hybrid the design warned about —
            everything behind it lives in one component.
          */}
          {canEdit ? <TabsTrigger value="manage">Manage</TabsTrigger> : null}
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
              <GoalieStatsTable rows={detail.goalies} league={league} />
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
            detail.games.map((g) => (
              <GameRow key={g.id} game={g} league={league} />
            ))
          )}
        </TabsContent>

        {editing ? (
          <TabsContent value="manage">
            <RosterEditor team={detail.team} season={ctx.season} />
          </TabsContent>
        ) : null}
      </TeamTabs>
    </div>
  );
}
