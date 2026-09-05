import { notFound } from "next/navigation";
import { resolveLeagueBySlug } from "@/lib/league/current";
import { getActiveContext, getManageContext } from "@/lib/queries/season";
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
import { SeasonSwitcher } from "@/components/manage/season-switcher";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { EmptyState } from "@/components/shared/empty-state";
import { NoSeason } from "@/components/public/no-season";

/**
 * A team — one URL, one page, for everybody.
 *
 * This absorbed `/manage/rosters/<uuid>`, which showed the same team to its
 * manager behind an id nobody could read or share. The public content is
 * unchanged and unconditional; a manager of THIS league sees that same page with
 * the roster editable underneath it.
 *
 * ⚠️ THERE IS NO MANAGE TAB AND NO `?tab=manage`, AND THAT IS THE POINT. Both
 * existed briefly and were removed on the product decision that a manager should
 * simply see their page and be able to edit it — not navigate to a second view
 * of the team they are already looking at. Anything that reintroduces a mode
 * here (a tab, a query parameter, an "edit" toggle) is reintroducing what was
 * deliberately taken out.
 *
 * ⚠️ The cost that mode was buying is real and is now paid: `RosterEditor` runs
 * four admin queries — one of them the whole `players` table, for the "add
 * someone who already plays elsewhere" picker — on every manager's view of any
 * team page in their league. It is bounded by the number of people in the
 * instance, not by the league, so it is the query to watch if that table grows.
 * Nobody else pays it: the block is behind `canManageLeague`, so an anonymous
 * visitor triggers none of it.
 *
 * ⚠️ The team is resolved by SLUG WITHIN THE LEAGUE, which is what makes the old
 * page's ownership check unnecessary rather than merely absent — see the note on
 * `RosterEditor`.
 *
 * ⚠️ TWO SEASONS, ONE PAGE. `is_active` means "what the public site shows" and
 * nothing else, and both importers create seasons inactive — so a manage surface
 * keyed on the active season cannot edit the season it just imported. That is why
 * the staff pages take `?season=`. This page serves both audiences, so it
 * resolves BOTH ways: `getManageContext` for a manager (their picked season, plus
 * the list the switcher offers), `getActiveContext` for everyone else. A visitor
 * therefore cannot reach a non-public season by guessing the query parameter —
 * the parameter is only read after `canManageLeague` says yes.
 */
export default async function TeamPage({
  params,
  searchParams,
}: {
  params: Promise<{ league: string; slug: string }>;
  searchParams: Promise<{ season?: string }>;
}) {
  const { league: leagueParam, slug } = await params;
  const { season: seasonParam } = await searchParams;
  // League, then the entitlement, then the context — the order the manage pages
  // use. `getManageContext` reads every season on the ADMIN client, so it must
  // not run for a viewer who is not entitled to it. `resolveLeagueBySlug` is
  // cache()-wrapped, so asking here costs the context below nothing.
  const resolved = await resolveLeagueBySlug(leagueParam);
  if (!resolved) notFound();
  const canEdit = await canManageLeague(resolved.id);
  const manageCtx = canEdit
    ? await getManageContext(leagueParam, seasonParam)
    : null;
  const ctx = manageCtx ?? (await getActiveContext(leagueParam));
  if (!ctx.season) return <NoSeason />;
  const league = ctx.league.slug;

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
          textColor={detail.team.logo_text_color}
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
        Uncontrolled: both tabs are public content that switches instantly on the
        client, with no server work behind either. Nothing here reads the URL,
        which is what removing the Manage tab bought back.
      */}
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
              <GoalieStatsTable rows={detail.goalies} league={league} />
            </div>
          ) : null}

          {/*
            The same tab, below the same tables a visitor sees — a manager reads
            their team's stats and then edits the roster without going anywhere.
            The roster appears twice on purpose: the table above is the season's
            scoring, the one below is who is on the team and what can be done to
            them, and they answer different questions.
          */}
          {canEdit ? (
            // A named landmark, not a bare div: it is the only thing separating
            // the editor's roster table from the public one directly above it,
            // for a screen-reader user and for the e2e suite alike — several
            // specs scope `table tbody tr` to this region, which they got for
            // free while the editor had a tab to itself.
            <section
              aria-labelledby="manage-roster"
              className="space-y-4 border-t pt-6"
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h2
                  id="manage-roster"
                  className="text-muted-foreground text-sm font-semibold"
                >
                  Manage roster
                </h2>
                {/*
                  Beside the editor's own heading, not in the page header: the
                  season it switches is the one this section edits, and the
                  public tables above are the active season's. Only a manager
                  sees it at all, so nothing changes for a visitor.
                */}
                {manageCtx ? <SeasonSwitcher ctx={manageCtx} /> : null}
              </div>
              <RosterEditor
                team={detail.team}
                season={ctx.season}
                leagueId={ctx.league.id}
              />
            </section>
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
      </Tabs>
    </div>
  );
}
