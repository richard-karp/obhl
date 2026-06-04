import Link from "next/link";
import { requireUser } from "@/lib/auth/guards";
import { createClient } from "@/utils/supabase/server";
import { getActiveContext } from "@/lib/queries/season";
import { getSchedule } from "@/lib/queries/schedule";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { TeamLogo } from "@/components/shared/team-logo";
import { EmptyState } from "@/components/shared/empty-state";
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

export default async function DashboardPage() {
  const user = await requireUser();
  const ctx = await getActiveContext();
  const seasonLabel = ctx?.season?.name ?? "No active season";

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
      <div className="space-y-1">
        <h1 className="text-2xl font-bold tracking-tight">Manage</h1>
        <p className="text-muted-foreground text-sm">
          {user.email} · {seasonLabel}
        </p>
      </div>

      {user.role === "league_manager" ? (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <ActionCard
            href="/people"
            title="People & Roles"
            description="Create staff accounts and assign manager, captain, or scorekeeper roles."
          />
          <ActionCard
            href="/seasons"
            title="Seasons"
            description="Create seasons, set the active one, and enroll teams (carry forward)."
          />
          <ActionCard
            href="/rosters"
            title="Rosters"
            description="Add players to teams and set numbers, positions, and captains."
          />
          <ActionCard
            href="/score"
            title="Games"
            description="Browse the schedule and open the scoresheet for any game."
          />
        </div>
      ) : null}

      {user.role === "scorekeeper" ? (
        <div className="grid gap-4 sm:grid-cols-2">
          <ActionCard
            href="/score"
            title="Score Games"
            description="Open a game to set rosters, record goals and penalties, and finalize."
          />
        </div>
      ) : null}

      {user.role === "captain" ? (
        <CaptainPanel userId={user.id} seasonId={ctx?.season?.id ?? null} />
      ) : null}
    </div>
  );
}

async function CaptainPanel({
  userId,
  seasonId,
}: {
  userId: string;
  seasonId: string | null;
}) {
  const supabase = await createClient();
  const { data: profile } = await supabase
    .from("profiles")
    .select("player_id")
    .eq("id", userId)
    .maybeSingle();

  if (!profile?.player_id) {
    return (
      <EmptyState
        title="No player linked"
        description="Your captain account isn't linked to a player yet. Ask a league manager to link you."
      />
    );
  }

  let team: { id: string; name: string; slug: string; color: string | null } | null =
    null;
  if (seasonId) {
    const { data } = await supabase
      .from("team_players")
      .select("team_id, teams!team_players_team_id_fkey(id, name, slug, color)")
      .eq("player_id", profile.player_id)
      .eq("is_captain", true)
      .eq("season_id", seasonId)
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
    return (
      <EmptyState
        title="No team to captain this season"
        description="You don't captain a team in the current league's active season. Switch leagues in the header if your team is elsewhere."
      />
    );
  }

  const games = (await getSchedule(seasonId!, team.id)).filter(
    (g) => g.status !== "final" && g.status !== "cancelled",
  );

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center gap-2">
          <TeamLogo name={team.name} color={team.color} />
          <CardTitle className="text-base">You captain the {team.name}</CardTitle>
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
                    <Link href={`/score/${g.id}`}>Set lineup</Link>
                  </Button>
                </div>
              );
            })}
          </div>
        )}
        <Link
          href={`/teams/${team.slug}`}
          className="text-primary inline-block text-sm hover:underline"
        >
          View team page →
        </Link>
      </CardContent>
    </Card>
  );
}
