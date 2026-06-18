import { notFound } from "next/navigation";
import { requireManager } from "@/lib/auth/guards";
import { createAdminClient } from "@/utils/supabase/admin";
import {
  setActiveSeason,
  carryForwardEnrollment,
  unenrollTeam,
  generateLeagueSummary,
} from "@/lib/actions/seasons";
import { AddTeamForm } from "@/components/manage/add-team-form";
import { ScheduleBuilderPanel } from "@/components/manage/schedule-builder-panel";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { TeamLogo } from "@/components/shared/team-logo";
import { PageHeader } from "@/components/shared/page-header";
import { EmptyState } from "@/components/shared/empty-state";
import { formatLongDate } from "@/lib/format";

/* eslint-disable @typescript-eslint/no-explicit-any */
function StepChip({
  n,
  label,
  detail,
  done,
}: {
  n: number;
  label: string;
  detail: string;
  done: boolean;
}) {
  return (
    <div className="flex items-center gap-2 rounded-lg border px-3 py-2">
      <span
        className={
          done
            ? "bg-primary text-primary-foreground flex size-6 items-center justify-center rounded-full text-xs font-bold"
            : "bg-muted text-muted-foreground flex size-6 items-center justify-center rounded-full text-xs font-bold"
        }
      >
        {done ? "✓" : n}
      </span>
      <div className="leading-tight">
        <div className="text-sm font-medium">{label}</div>
        <div className="text-muted-foreground text-xs">{detail}</div>
      </div>
    </div>
  );
}

export default async function SeasonSetupPage({
  params,
}: {
  params: Promise<{ seasonId: string }>;
}) {
  await requireManager();
  const { seasonId } = await params;
  const admin = createAdminClient();

  const { data: season } = await admin
    .from("seasons")
    .select("id, name, league_id, is_active, starts_on, ends_on, ai_summary")
    .eq("id", seasonId)
    .maybeSingle();
  if (!season) notFound();

  const [{ data: enrolled }, { data: captains }, { count: publishedCount }] =
    await Promise.all([
      admin
        .from("season_teams")
        .select("team_id, teams!season_teams_team_id_fkey(id, name, color)")
        .eq("season_id", seasonId),
      admin
        .from("team_players")
        .select(
          "team_id, players!team_players_player_id_fkey(first_name, last_name)",
        )
        .eq("season_id", seasonId)
        .eq("is_captain", true),
      admin
        .from("games")
        .select("*", { count: "exact", head: true })
        .eq("season_id", seasonId)
        .eq("is_draft", false),
    ]);

  const captainOf = new Map<string, string>();
  for (const c of (captains ?? []) as any[]) {
    captainOf.set(
      c.team_id,
      `${c.players?.first_name ?? ""} ${c.players?.last_name ?? ""}`.trim(),
    );
  }
  const teams = ((enrolled ?? []) as any[])
    .map((r) => r.teams)
    .filter(Boolean)
    .sort((a: any, b: any) => a.name.localeCompare(b.name));
  const teamCount = teams.length;
  const published = publishedCount ?? 0;

  return (
    <div className="space-y-6">
      <PageHeader
        title={`Season setup — ${season.name}`}
        description={
          season.starts_on
            ? `${formatLongDate(season.starts_on)} – ${formatLongDate(season.ends_on)}`
            : "No dates set"
        }
      >
        {season.is_active ? (
          <Badge>Active</Badge>
        ) : (
          <form action={setActiveSeason}>
            <input type="hidden" name="id" value={seasonId} />
            <Button type="submit" size="sm" variant="secondary">
              Set active
            </Button>
          </form>
        )}
      </PageHeader>

      <div className="grid gap-3 sm:grid-cols-3">
        <StepChip n={1} label="Season created" detail={season.name} done />
        <StepChip
          n={2}
          label="Teams"
          detail={teamCount ? `${teamCount} enrolled` : "Add teams below"}
          done={teamCount > 0}
        />
        <StepChip
          n={3}
          label="Schedule"
          detail={
            published
              ? `${published} games scheduled`
              : teamCount < 2
                ? "Add teams first"
                : "Build it below"
          }
          done={published > 0}
        />
      </div>

      {/* Step 2 — teams */}
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between gap-2">
            <CardTitle className="text-base">Teams</CardTitle>
            <form action={carryForwardEnrollment}>
              <input type="hidden" name="season_id" value={seasonId} />
              <Button type="submit" variant="outline" size="sm">
                Same teams as last season
              </Button>
            </form>
          </div>
        </CardHeader>
        <CardContent className="space-y-5">
          <AddTeamForm seasonId={seasonId} />

          {teams.length === 0 ? (
            <EmptyState
              title="No teams yet"
              description="Add teams above, or carry forward last season's teams."
            />
          ) : (
            <div className="overflow-hidden rounded-lg border">
              <Table>
                <TableHeader>
                  <TableRow className="bg-muted/40">
                    <TableHead>Team</TableHead>
                    <TableHead>Captain</TableHead>
                    <TableHead className="text-right">Enrollment</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {teams.map((t: any) => (
                    <TableRow key={t.id}>
                      <TableCell>
                        <span className="flex items-center gap-2 font-medium">
                          <TeamLogo name={t.name} color={t.color} />
                          {t.name}
                        </span>
                      </TableCell>
                      <TableCell className="text-muted-foreground">
                        {captainOf.get(t.id) || "—"}
                      </TableCell>
                      <TableCell className="text-right">
                        <form action={unenrollTeam} className="inline">
                          <input type="hidden" name="season_id" value={seasonId} />
                          <input type="hidden" name="team_id" value={t.id} />
                          <Button type="submit" variant="ghost" size="sm">
                            Remove
                          </Button>
                        </form>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>

      {/* League summary */}
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between gap-2">
            <CardTitle className="text-base">League Summary</CardTitle>
            <form action={generateLeagueSummary}>
              <input type="hidden" name="season_id" value={seasonId} />
              <Button type="submit" variant="outline" size="sm">
                {season.ai_summary ? "Regenerate" : "Generate"}
              </Button>
            </form>
          </div>
        </CardHeader>
        <CardContent>
          {season.ai_summary ? (
            <p className="text-muted-foreground text-sm leading-relaxed italic">
              &ldquo;{season.ai_summary}&rdquo;
            </p>
          ) : (
            <p className="text-muted-foreground text-sm">
              No summary yet. Click Generate to create an AI-written league update.
            </p>
          )}
        </CardContent>
      </Card>

      {/* Step 3 — schedule (gated on having teams) */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Schedule</CardTitle>
        </CardHeader>
        <CardContent>
          {teamCount < 2 ? (
            <EmptyState
              title="Add teams to build the schedule"
              description="Enroll at least two teams above, then the schedule builder appears here."
            />
          ) : (
            <ScheduleBuilderPanel seasonId={seasonId} />
          )}
        </CardContent>
      </Card>
    </div>
  );
}
/* eslint-enable @typescript-eslint/no-explicit-any */
