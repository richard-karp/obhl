import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { requireUser } from "@/lib/auth/guards";
import { isLeagueMember } from "@/lib/auth/membership";
import { resolveLeagueBySlug } from "@/lib/league/current";
import { createClient } from "@/utils/supabase/server";
import { getManageContext } from "@/lib/queries/season";
import { getSchedule } from "@/lib/queries/schedule";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { TeamLogo } from "@/components/shared/team-logo";
import { EmptyState } from "@/components/shared/empty-state";
import { SeasonSwitcher } from "@/components/manage/season-switcher";
import { formatGameDateTime } from "@/lib/format";

function ActionCard({
  href,
  title,
  description,
}: {
  href: string;
  title: string;
  description: string;
}) {
  return (
    <Link href={href}>
      <Card className="hover:border-primary h-full transition-colors">
        <CardHeader>
          <CardTitle className="text-base">{title}</CardTitle>
        </CardHeader>
        <CardContent className="text-muted-foreground text-sm">
          {description}
        </CardContent>
      </Card>
    </Link>
  );
}

export default async function DashboardPage({
  params,
  searchParams,
}: {
  params: Promise<{ league: string }>;
  searchParams: Promise<{ season?: string }>;
}) {
  const { league: leagueParam } = await params;
  const { season: seasonParam } = await searchParams;
  const user = await requireUser();
  // The league alone first, so a request that is about to be refused does not
  // also pay for the season lookup. `resolveLeagueBySlug` is cache()-wrapped,
  // so `getManageContext` below reuses this answer.
  const league = await resolveLeagueBySlug(leagueParam);
  if (!league) notFound();
  // Membership, not role, decides which leagues a staff account can open. The
  // check is on a *roled* account only: an account with no role yet belongs to
  // no league either, and refusing it here would make the explanation below —
  // the one page that tells someone why nothing works — unreachable. It renders
  // no league data, so there is nothing for it to leak.
  if (user.role && !(await isLeagueMember(user.id, league.id))) redirect("/");
  const ctx = await getManageContext(leagueParam, seasonParam);
  // The resolved slug, not the URL's — links stay canonical from /OBHL.
  const leagueSlug = ctx.league.slug;
  const seasonLabel = ctx.season?.name ?? "No seasons yet";

  if (!user.role) {
    return (
      <EmptyState
        title="Your account has no role yet"
        description={`Signed in as ${user.email}. A league manager needs to assign you a role before you can manage anything.`}
      />
    );
  }

  return (
    <div className="space-y-6">
      {/*
        The switcher sits on this row rather than in the brand bar — see the
        note on `SeasonSwitcher`, and `MAX_INLINE_LINKS` in `manage-nav.tsx`.
      */}
      <div className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
        <div className="space-y-1">
          <h1 className="text-2xl font-bold tracking-tight">Manage</h1>
          <p className="text-muted-foreground text-sm">
            {user.email} · {seasonLabel}
          </p>
        </div>
        <SeasonSwitcher ctx={ctx} />
      </div>

      {user.role === "league_manager" ? (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <ActionCard
            href={`/${leagueSlug}/people`}
            title="People & Roles"
            description="Create staff accounts and assign manager, captain, or scorekeeper roles."
          />
          <ActionCard
            href={`/${leagueSlug}/seasons`}
            title="Seasons"
            description="Create seasons, set the active one, and enroll teams (carry forward)."
          />
          <ActionCard
            href={`/${leagueSlug}/teams`}
            title="Teams"
            description="Add players to teams and set numbers, positions, and captains."
          />
          <ActionCard
            href={`/${leagueSlug}/schedule`}
            title="Games"
            description="Browse the schedule and open the scoresheet for any game."
          />
        </div>
      ) : null}

      {user.role === "scorekeeper" ? (
        <div className="grid gap-4 sm:grid-cols-2">
          <ActionCard
            href={`/${leagueSlug}/schedule`}
            title="Score Games"
            description="Open a game to set rosters, record goals and penalties, and finalize."
          />
        </div>
      ) : null}

      {/*
        Keyed on the player link, not on the role. A person can be a manager
        *and* captain a team — manager write access is a superset of a
        captain's, so that needs no multi-role model, only for the captain
        surface to stop being gated on `role === "captain"`. The panel resolves
        its own team and renders nothing when there isn't one.
      */}
      <CaptainPanel
        userId={user.id}
        seasonId={ctx.season?.id ?? null}
        leagueSlug={ctx.league.slug}
        explainWhenAbsent={user.role === "captain"}
      />
    </div>
  );
}

async function CaptainPanel({
  userId,
  seasonId,
  leagueSlug,
  explainWhenAbsent,
}: {
  userId: string;
  seasonId: string | null;
  leagueSlug: string;
  /**
   * Whether "you captain nothing here" is worth saying. For an account whose
   * role IS captain it is the whole page, so it gets an explanation; for a
   * manager who happens not to captain a team it is just noise, so the panel
   * renders nothing at all.
   */
  explainWhenAbsent: boolean;
}) {
  const supabase = await createClient();
  const { data: profile } = await supabase
    .from("profiles")
    .select("player_id")
    .eq("id", userId)
    .maybeSingle();

  if (!profile?.player_id) {
    return explainWhenAbsent ? (
      <EmptyState
        title="No player linked"
        description="Your captain account isn't linked to a player yet. Ask a league manager to link you."
      />
    ) : null;
  }

  let team: {
    id: string;
    name: string;
    slug: string;
    color: string | null;
  } | null = null;
  if (seasonId) {
    const { data } = await supabase
      .from("team_players")
      .select("team_id, teams!team_players_team_id_fkey(id, name, slug, color)")
      .eq("player_id", profile.player_id)
      .eq("is_captain", true)
      .eq("season_id", seasonId)
      // The team they captain NOW. Also what keeps `maybeSingle()` honest: a
      // captain who changed teams mid-season matches their old row too.
      .is("left_on", null)
      .maybeSingle();
    team =
      (data?.teams as unknown as {
        id: string;
        name: string;
        slug: string;
        color: string | null;
      }) ?? null;
  }

  if (!team) {
    return explainWhenAbsent ? (
      <EmptyState
        title="No team to captain this season"
        description="You don't captain a team in the season shown above. Switch season or league in the header if your team is elsewhere."
      />
    ) : null;
  }

  const games = (await getSchedule(seasonId!, { teamId: team.id })).filter(
    (g) => g.status !== "final" && g.status !== "cancelled",
  );

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center gap-2">
          <TeamLogo name={team.name} color={team.color} />
          <CardTitle className="text-base">
            You captain the {team.name}
          </CardTitle>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-muted-foreground text-sm">
          Open a game to set your dressed lineup. Rosters lock once the game is
          finalized.
        </p>
        {games.length === 0 ? (
          <p className="text-muted-foreground text-sm">No upcoming games.</p>
        ) : (
          <div className="divide-y rounded-lg border">
            {games.map((g) => {
              const opp =
                g.home_team?.id === team!.id ? g.away_team : g.home_team;
              const homeAway = g.home_team?.id === team!.id ? "vs" : "@";
              return (
                <div
                  key={g.id}
                  className="flex items-center justify-between gap-3 px-3 py-2"
                >
                  <span className="flex items-center gap-2 text-sm">
                    <span className="text-muted-foreground w-32 shrink-0 text-xs">
                      {formatGameDateTime(g.scheduled_at)}
                    </span>
                    <span className="text-muted-foreground">{homeAway}</span>
                    <TeamLogo name={opp?.name ?? "TBD"} color={opp?.color} />
                    <span className="font-medium">{opp?.name ?? "TBD"}</span>
                  </span>
                  <Button asChild size="sm">
                    <Link href={`/${leagueSlug}/games/${g.id}/score`}>
                      Set lineup
                    </Link>
                  </Button>
                </div>
              );
            })}
          </div>
        )}
        <Link
          href={`/${leagueSlug}/teams/${team.slug}`}
          className="text-primary inline-block text-sm hover:underline"
        >
          View team page →
        </Link>
      </CardContent>
    </Card>
  );
}
