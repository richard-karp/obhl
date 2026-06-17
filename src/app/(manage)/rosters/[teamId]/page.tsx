import { notFound } from "next/navigation";
import { requireManager } from "@/lib/auth/guards";
import { createAdminClient } from "@/utils/supabase/admin";
import { getActiveContext } from "@/lib/queries/season";
import { AddPlayerForm } from "@/components/manage/add-player-form";
import { removeRosterPlayer, toggleCaptain, updatePlayerStatus } from "@/lib/actions/rosters";
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
import { PageHeader } from "@/components/shared/page-header";
import { EmptyState } from "@/components/shared/empty-state";
import { TeamLogo } from "@/components/shared/team-logo";
import { LogoUpload } from "@/components/manage/logo-upload";

const POS: Record<string, string> = { F: "Forward", D: "Defense", G: "Goalie" };

/* eslint-disable @typescript-eslint/no-explicit-any */
export default async function RosterEditorPage({
  params,
}: {
  params: Promise<{ teamId: string }>;
}) {
  await requireManager();
  const { teamId } = await params;
  const ctx = await getActiveContext();
  if (!ctx?.season) {
    return <EmptyState title="No active season" />;
  }

  const admin = createAdminClient();
  const { data: team } = await admin
    .from("teams")
    .select("id, name, color, league_id, logo_path")
    .eq("id", teamId)
    .maybeSingle();
  if (!team) notFound();

  const { data: roster } = await admin
    .from("team_players")
    .select(
      "id, player_id, jersey_number, position, is_captain, is_rookie, injury_notes, is_suspended, players!team_players_player_id_fkey(first_name, last_name)",
    )
    .eq("season_id", ctx.season.id)
    .eq("team_id", teamId)
    .order("jersey_number", { ascending: true });

  // Global people not already on this team's roster — for the shared-identity
  // "existing person" picker (reuse someone who plays in another league).
  const { data: allPeople } = await admin
    .from("players")
    .select("id, first_name, last_name")
    .order("last_name", { ascending: true });
  const onRoster = new Set((roster ?? []).map((r) => r.player_id));
  const people = (allPeople ?? [])
    .filter((p) => !onRoster.has(p.id))
    .map((p) => ({ id: p.id, name: `${p.first_name} ${p.last_name}` }));

  return (
    <div className="space-y-6">
      <PageHeader title={`${team.name} — Roster`} description={ctx.season.name} />

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Team logo</CardTitle>
        </CardHeader>
        <CardContent className="flex items-center gap-4">
          <TeamLogo
            name={team.name}
            color={team.color}
            logoPath={team.logo_path}
            className="size-12 text-base"
          />
          <LogoUpload teamId={team.id} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Add a player</CardTitle>
        </CardHeader>
        <CardContent>
          <AddPlayerForm
            seasonId={ctx.season.id}
            teamId={team.id}
            people={people}
          />
        </CardContent>
      </Card>

      {(roster ?? []).length === 0 ? (
        <EmptyState title="No players yet" description="Add players above." />
      ) : (
        <div className="overflow-hidden rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow className="bg-muted/40">
                <TableHead className="w-12 text-center">#</TableHead>
                <TableHead>Player</TableHead>
                <TableHead>Position</TableHead>
                <TableHead className="text-center">Status</TableHead>
                <TableHead className="text-right">Manage</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {(roster ?? []).map((r: any) => (
                <TableRow key={r.id}>
                  <TableCell className="text-muted-foreground text-center">
                    {r.jersey_number ?? "—"}
                  </TableCell>
                  <TableCell className="font-medium">
                    {r.players?.first_name} {r.players?.last_name}
                    {r.is_captain ? (
                      <Badge variant="secondary" className="ml-2 px-1.5 py-0 text-[0.65rem]">
                        C
                      </Badge>
                    ) : null}
                    {r.is_rookie ? (
                      <Badge variant="outline" className="ml-1 px-1.5 py-0 text-[0.65rem]">
                        R
                      </Badge>
                    ) : null}
                    {r.is_suspended ? (
                      <Badge variant="destructive" className="ml-1 px-1.5 py-0 text-[0.65rem]">
                        SUSP
                      </Badge>
                    ) : null}
                    {r.injury_notes ? (
                      <Badge variant="destructive" className="ml-1 px-1.5 py-0 text-[0.65rem]">
                        INJ
                      </Badge>
                    ) : null}
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {POS[r.position] ?? r.position}
                  </TableCell>
                  <TableCell>
                    <div className="flex flex-wrap items-center justify-center gap-1">
                      <form action={updatePlayerStatus}>
                        <input type="hidden" name="id" value={r.id} />
                        <input type="hidden" name="team_id" value={team.id} />
                        <input type="hidden" name="field" value="is_rookie" />
                        <input type="hidden" name="value" value={r.is_rookie ? "0" : "1"} />
                        <Button type="submit" variant="ghost" size="sm" className="h-7 px-2 text-xs">
                          {r.is_rookie ? "Unset Rookie" : "Rookie"}
                        </Button>
                      </form>
                      <form action={updatePlayerStatus}>
                        <input type="hidden" name="id" value={r.id} />
                        <input type="hidden" name="team_id" value={team.id} />
                        <input type="hidden" name="field" value="is_suspended" />
                        <input type="hidden" name="value" value={r.is_suspended ? "0" : "1"} />
                        <Button type="submit" variant="ghost" size="sm" className="h-7 px-2 text-xs">
                          {r.is_suspended ? "Lift Susp." : "Suspend"}
                        </Button>
                      </form>
                      <form action={updatePlayerStatus} className="flex items-center gap-1">
                        <input type="hidden" name="id" value={r.id} />
                        <input type="hidden" name="team_id" value={team.id} />
                        <input type="hidden" name="field" value="injury_notes" />
                        <input
                          name="value"
                          defaultValue={r.injury_notes ?? ""}
                          placeholder="Injury notes…"
                          className="h-7 w-28 rounded border px-2 text-xs"
                        />
                        <Button type="submit" variant="ghost" size="sm" className="h-7 px-2 text-xs">
                          Set
                        </Button>
                      </form>
                    </div>
                  </TableCell>
                  <TableCell>
                    <div className="flex items-center justify-end gap-2">
                      <form action={toggleCaptain}>
                        <input type="hidden" name="id" value={r.id} />
                        <input type="hidden" name="team_id" value={team.id} />
                        <input type="hidden" name="make" value={r.is_captain ? "0" : "1"} />
                        <Button type="submit" variant="ghost" size="sm">
                          {r.is_captain ? "Unset C" : "Make C"}
                        </Button>
                      </form>
                      <form action={removeRosterPlayer}>
                        <input type="hidden" name="id" value={r.id} />
                        <input type="hidden" name="team_id" value={team.id} />
                        <Button type="submit" variant="ghost" size="sm" className="text-destructive">
                          Remove
                        </Button>
                      </form>
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  );
}
/* eslint-enable @typescript-eslint/no-explicit-any */
