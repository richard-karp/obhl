import { notFound } from "next/navigation";
import { resolveLeagueBySlug } from "@/lib/league/current";
import { getActiveContext, getManageContext } from "@/lib/queries/season";
import { getTeamBySlug } from "@/lib/queries/teams";
import { seasonNightsFor } from "@/lib/queries/season";
import { hasMultipleNights } from "@/lib/season/nights";
import { canManageLeague } from "@/lib/auth/guards";
import { RosterEditor } from "@/components/manage/roster-editor";
import {
  TeamRosterSections,
  type SectionGoalie,
  type SectionSkater,
} from "@/components/public/team-roster-sections";
import { GameRow } from "@/components/public/game-row";
import { TeamLogo } from "@/components/shared/team-logo";
import { SeasonSwitcher } from "@/components/manage/season-switcher";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { EmptyState } from "@/components/shared/empty-state";
import { NoSeason } from "@/components/public/no-season";

// ⚠️ No manage tab, `?tab=manage` or edit toggle: by product decision a manager edits the page everyone
// sees. ⚠️ `?season=` is read only after `canManageLeague`, so a visitor can't reach a non-public season.
export default async function TeamPage({
  params,
  searchParams,
}: {
  params: Promise<{ league: string; slug: string }>;
  searchParams: Promise<{ season?: string }>;
}) {
  const { league: leagueParam, slug } = await params;
  const { season: seasonParam } = await searchParams;
  // League, then entitlement, then context: `getManageContext` reads every season on the admin client,
  // so it must not run for a viewer not entitled to it.
  const resolved = await resolveLeagueBySlug(leagueParam);
  if (!resolved) notFound();
  const canEdit = await canManageLeague(resolved.id);
  const manageCtx = canEdit
    ? await getManageContext(leagueParam, seasonParam)
    : null;
  const ctx = manageCtx ?? (await getActiveContext(leagueParam));
  // ⚠️ Only the public context reports a failed read; `getManageContext` gets the plain message.
  if (!ctx.season)
    return (
      <NoSeason
        readFailed={"seasonReadFailed" in ctx && ctx.seasonReadFailed}
      />
    );
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

  // ⛔ Built from the roster, left-joined to the stats: the stats views hold only final games, so a
  // section driven by them is empty for anyone not yet scored.
  const statByPlayer = new Map(detail.skaters.map((s) => [s.player_id, s]));
  const goalieByPlayer = new Map(detail.goalies.map((g) => [g.player_id, g]));
  const inRoster = new Set(detail.roster.map((r) => r.player_id));

  const nights = await seasonNightsFor(ctx.season);
  const showNight = hasMultipleNights(nights);

  const skaterRow = (r: {
    player_id: string;
    jersey_number: number | null;
    first_name: string;
    last_name: string;
    is_captain: boolean;
    night_of_week: number | null;
  }): SectionSkater => {
    const st = statByPlayer.get(r.player_id);
    return {
      player_id: r.player_id,
      number: r.jersey_number,
      name: `${r.first_name} ${r.last_name}`.trim(),
      is_captain: r.is_captain,
      night: r.night_of_week,
      gp: st?.gp ?? 0,
      g: st?.g ?? 0,
      a: st?.a ?? 0,
      pts: st?.pts ?? 0,
      pim: st?.pim ?? 0,
    };
  };

  const forwards: SectionSkater[] = [];
  const defence: SectionSkater[] = [];
  const goalies: SectionGoalie[] = [];
  for (const r of detail.roster) {
    const base = skaterRow(r);
    if (r.position === "G") {
      const g = goalieByPlayer.get(r.player_id);
      goalies.push({
        ...base,
        wins: g?.wins ?? 0,
        losses: g?.losses ?? 0,
        ties: g?.ties ?? 0,
        ga: g?.ga ?? 0,
        so: g?.so ?? 0,
        gaa: g?.gaa ?? null,
      });
    } else if (r.position === "D") {
      defence.push(base);
    } else {
      forwards.push(base);
    }
  }

  // Anyone with stats no longer on the roster: their points stay visible, with no night or captaincy.
  for (const st of detail.skaters) {
    if (!st.player_id || inRoster.has(st.player_id)) continue;
    const row: SectionSkater = {
      player_id: st.player_id,
      number: st.jersey_number,
      name: `${st.first_name ?? ""} ${st.last_name ?? ""}`.trim(),
      is_captain: false,
      night: null,
      gp: st.gp ?? 0,
      g: st.g ?? 0,
      a: st.a ?? 0,
      pts: st.pts ?? 0,
      pim: st.pim ?? 0,
    };
    if (st.position === "D") defence.push(row);
    else if (st.position === "G") {
      const g = goalieByPlayer.get(st.player_id);
      goalies.push({
        ...row,
        wins: g?.wins ?? 0,
        losses: g?.losses ?? 0,
        ties: g?.ties ?? 0,
        ga: g?.ga ?? 0,
        so: g?.so ?? 0,
        gaa: g?.gaa ?? null,
      });
    } else forwards.push(row);
  }

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
            {/* ⚠️ Derived from the games read: a failed read would show 0-0-0, a real record. */}
            {detail.gamesReadFailed ? "Record unavailable" : `${w}-${l}-${t}`} ·{" "}
            {ctx.season.name}
          </p>
        </div>
      </div>

      {/*
        Uncontrolled: both tabs are public content with no server work behind either; nothing reads the URL.
      */}
      <Tabs defaultValue="roster" className="space-y-4">
        <TabsList>
          <TabsTrigger value="roster">Roster &amp; Stats</TabsTrigger>
          <TabsTrigger value="schedule">Schedule</TabsTrigger>
        </TabsList>

        <TabsContent value="roster" className="space-y-6">
          {forwards.length + defence.length + goalies.length === 0 ? (
            <EmptyState title="No players on the roster yet" />
          ) : (
            <TeamRosterSections
              forwards={forwards}
              defence={defence}
              goalies={goalies}
              showNight={showNight}
            />
          )}
          {/*
            ⛔ No separate goaltending block: the Goalies section above carries both column sets, and
            `GoalieStatsTable` stays for `/stats`.
          */}

          {/*
            The roster appears twice on purpose: the season's scoring above, who is on the team and what
            can be done to them below.
          */}
          {canEdit ? (
            // A named landmark: it separates the editor's table from the public one above, and several e2e
            // specs scope `table tbody tr` to this region.
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
                  Beside the editor's heading, not the page header: it switches the season this section
                  edits, while the public tables above show the active one.
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
          {detail.gamesReadFailed ? (
            <EmptyState title="Couldn't load this team's schedule" />
          ) : detail.games.length === 0 ? (
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
