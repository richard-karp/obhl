import { createAdminClient } from "@/utils/supabase/admin";
import { AddPlayerForm } from "@/components/manage/add-player-form";
import { archivedPlayerIdsIn } from "@/lib/players/archive";
import { removeRosterPlayer } from "@/lib/actions/rosters";
import { PlayerEditDialog } from "@/components/manage/player-edit-dialog";
import { seasonNightsFor } from "@/lib/queries/season";
import { hasMultipleNights } from "@/lib/season/nights";
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
import { EmptyState } from "@/components/shared/empty-state";
import { NightBadge } from "@/components/shared/night-badge";
import { TeamLogo } from "@/components/shared/team-logo";
import { LogoUpload } from "@/components/manage/logo-upload";
import type { TeamRow } from "@/lib/queries/teams";
import type { Season } from "@/lib/queries/season";

/* eslint-disable @typescript-eslint/no-explicit-any */

// ⛔ No write path of its own: every control submits to `lib/actions/rosters.ts`, since a naive transfer
// destroyed goalie records silently (`0036`). ⚠️ Given a team id instead, it would need an ownership check.
export async function RosterEditor({
  team,
  season,
  leagueId,
}: {
  team: TeamRow;
  season: Season;
  leagueId: string;
}) {
  const admin = createAdminClient();
  const { data: roster } = await admin
    .from("team_players")
    .select(
      "id, player_id, jersey_number, position, is_captain, is_rookie, injury_notes, is_suspended, night_of_week, players!team_players_player_id_fkey(first_name, last_name)",
    )
    .eq("season_id", season.id)
    .eq("team_id", team.id)
    // The active roster: a departed row is history (0036) the stats views credit, not someone to line up.
    .is("left_on", null)
    .order("jersey_number", { ascending: true });

  // From `season_teams`, not `teams`: a team not enrolled this season is nowhere to transfer to.
  const { data: enrolled } = await admin
    .from("season_teams")
    .select("team_id, teams!season_teams_team_id_fkey(id, name)")
    .eq("season_id", season.id);
  const transferTargets = (enrolled ?? [])
    .flatMap((e) =>
      e.teams && e.teams.id !== team.id
        ? [{ id: e.teams.id, name: e.teams.name }]
        : [],
    )
    .sort((a, b) => a.name.localeCompare(b.name));

  // ⚠️ The team may not be in this season (the switcher keeps `team.id`); without this, Add Player wrote rows
  // for it. An empty state, not `notFound()`, and `addRosterPlayer` refuses too.
  if (!(enrolled ?? []).some((e) => e.team_id === team.id)) {
    return (
      <EmptyState
        title={`${team.name} is not in ${season.name}`}
        description="Enrol the team in this season on the season setup page, or switch to a season it plays in."
      />
    );
  }

  // ⛔ `players` read unfiltered, with the archive applied per league below: a global archived flag would
  // silently hide the person from every other league's picker.
  const [{ data: allPeople }, archived, { data: leagueRostered }] =
    await Promise.all([
      admin
        .from("players")
        .select("id, first_name, last_name")
        .order("last_name", { ascending: true }),
      archivedPlayerIdsIn(leagueId, admin),
      // On a team in this league now: the picker says so, since `archivePlayer` refuses them.
      admin
        .from("team_players")
        .select("player_id, seasons!inner(league_id)")
        .is("left_on", null)
        .eq("seasons.league_id", leagueId),
    ]);
  // Shared with the page through `cache()`. ⚠️ Not only for `showNight`: `PlayerEditDialog` offers these as the
  // night options, so deleting this empties that control.
  const nights = await seasonNightsFor(season);
  const showNight = hasMultipleNights(nights);

  const onRoster = new Set((roster ?? []).map((r) => r.player_id));
  const rosteredInLeague = new Set(
    (leagueRostered ?? []).map((r) => r.player_id),
  );
  const people = (allPeople ?? [])
    .filter((p) => !onRoster.has(p.id))
    .map((p) => ({
      id: p.id,
      name: `${p.first_name} ${p.last_name}`,
      // Archived out of this league only: hidden until "Show archived" is ticked.
      archived: archived.has(p.id),
      rostered: rosteredInLeague.has(p.id),
    }));

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Team logo</CardTitle>
        </CardHeader>
        <CardContent className="flex items-center gap-4">
          <TeamLogo
            name={team.name}
            color={team.color}
            logoPath={team.logo_path}
            textColor={team.logo_text_color}
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
            seasonId={season.id}
            teamId={team.id}
            leagueId={leagueId}
            people={people}
          />
        </CardContent>
      </Card>

      {(roster ?? []).length === 0 ? (
        <EmptyState title="No players yet" description="Add players above." />
      ) : (
        /* ⛔ The same three sections as the public table above, in the same order. ⚠️ Three columns, with
           everything else behind Edit: that is what makes the row fit. */
        <div className="space-y-6">
          {(
            [
              ["Forwards", "F"],
              ["Defence", "D"],
              ["Goalies", "G"],
            ] as const
          ).map(([title, code]) => {
            const rows = (roster ?? []).filter((r: any) => r.position === code);
            if (rows.length === 0) return null;
            return (
              <section key={code} aria-label={`Manage ${title}`}>
                <h3 className="text-muted-foreground mb-2 text-sm font-semibold">
                  {title}
                </h3>
                <div className="overflow-x-auto rounded-lg border">
                  <Table>
                    <TableHeader>
                      <TableRow className="bg-muted/40">
                        <TableHead className="w-12 text-center">#</TableHead>
                        <TableHead>Player</TableHead>
                        <TableHead className="text-right">Manage</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {rows.map((r: any) => (
                        <TableRow key={r.id}>
                          <TableCell className="text-muted-foreground text-center tabular-nums">
                            {r.jersey_number ?? "—"}
                          </TableCell>
                          <TableCell className="font-medium">
                            {r.players?.first_name} {r.players?.last_name}
                            <NightBadge
                              night={
                                showNight ? (r.night_of_week ?? null) : null
                              }
                            />
                            {r.is_captain ? (
                              <Badge
                                variant="secondary"
                                className="ml-2 px-1.5 py-0 text-[0.65rem]"
                              >
                                C
                              </Badge>
                            ) : null}
                            {r.is_rookie ? (
                              <Badge
                                variant="outline"
                                className="ml-1 px-1.5 py-0 text-[0.65rem]"
                              >
                                R
                              </Badge>
                            ) : null}
                            {r.is_suspended ? (
                              <Badge
                                variant="destructive"
                                className="ml-1 px-1.5 py-0 text-[0.65rem]"
                              >
                                SUSP
                              </Badge>
                            ) : null}
                            {r.injury_notes ? (
                              <Badge
                                variant="destructive"
                                className="ml-1 px-1.5 py-0 text-[0.65rem]"
                              >
                                INJ
                              </Badge>
                            ) : null}
                          </TableCell>
                          <TableCell>
                            <div className="flex items-center justify-end gap-1">
                              <PlayerEditDialog
                                rosterId={r.id}
                                firstName={r.players?.first_name ?? ""}
                                lastName={r.players?.last_name ?? ""}
                                jerseyNumber={r.jersey_number ?? null}
                                position={r.position}
                                nightOfWeek={r.night_of_week ?? null}
                                nights={nights}
                                isCaptain={!!r.is_captain}
                                isRookie={!!r.is_rookie}
                                isSuspended={!!r.is_suspended}
                                injuryNotes={r.injury_notes ?? null}
                                transferTargets={transferTargets}
                              />
                              {/* ⚠️ Remove stays on the row, outside the dialog: the one
                                  destructive control must not be found by accident. */}
                              <form action={removeRosterPlayer}>
                                <input type="hidden" name="id" value={r.id} />
                                <input
                                  type="hidden"
                                  name="team_id"
                                  value={team.id}
                                />
                                <Button
                                  type="submit"
                                  variant="ghost"
                                  size="sm"
                                  className="text-destructive"
                                >
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
              </section>
            );
          })}
        </div>
      )}

      {/*
        ⛔ No goalie-only scheduling card: a night is a field on any roster row (`src/lib/goalie/suggest.ts`).
      */}
    </div>
  );
}
/* eslint-enable @typescript-eslint/no-explicit-any */
