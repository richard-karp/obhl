import { requireLeagueManager } from "@/lib/auth/guards";
import { createAdminClient } from "@/utils/supabase/admin";
import { getActiveContext } from "@/lib/queries/season";
import {
  CreateStaffForm,
  type CaptainOption,
} from "@/components/manage/create-staff-form";
import { StaffRowActions } from "@/components/manage/staff-row-actions";
import { memberLeagueIds } from "@/lib/auth/membership";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { PageHeader } from "@/components/shared/page-header";

const ROLE_LABEL: Record<string, string> = {
  league_manager: "Manager",
  scorekeeper: "Scorekeeper",
  captain: "Captain",
};

export default async function PeoplePage({
  params,
}: {
  params: Promise<{ league: string }>;
}) {
  const { league: leagueSlug } = await params;
  const ctx = await getActiveContext(leagueSlug);
  const viewer = await requireLeagueManager(ctx.league.id);
  const admin = createAdminClient();

  // This league's staff, not the instance's. The page listed every profile in
  // the database, and its Remove button deleted the account outright — so a
  // manager of one league was handed the other league's staff to delete.
  const { data: members } = await admin
    .from("profile_leagues")
    .select("profile_id")
    .eq("league_id", ctx.league.id);
  const memberIds = (members ?? []).map((m) => m.profile_id);

  const [{ data: usersList }, { data: profiles }, { data: allMemberships }] =
    await Promise.all([
      admin.auth.admin.listUsers({ perPage: 1000 }),
      memberIds.length
        ? admin.from("profiles").select("id, role, display_name").in("id", memberIds)
        : Promise.resolve({ data: [] as { id: string; role: string | null; display_name: string | null }[] }),
      // Every league these people work, not just this one — a role change reaches
      // all of them. One query for the table, rather than one per row.
      memberIds.length
        ? admin.from("profile_leagues").select("profile_id, league_id").in("profile_id", memberIds)
        : Promise.resolve({ data: [] as { profile_id: string; league_id: string }[] }),
    ]);

  let captains: CaptainOption[] = [];
  if (ctx.season) {
    const { data: caps } = await admin
      .from("team_players")
      .select(
        "player_id, players!team_players_player_id_fkey(first_name, last_name), teams!team_players_team_id_fkey(name)",
      )
      .eq("season_id", ctx.season.id)
      .eq("is_captain", true);
    captains = (caps ?? []).map((c) => ({
      id: c.player_id,
      label: `${c.players?.first_name} ${c.players?.last_name} (${c.teams?.name})`,
    }));
  }

  const emailById = new Map(
    (usersList?.users ?? []).map((u) => [u.id, u.email ?? "—"]),
  );
  const staff = (profiles ?? [])
    .map((p) => ({ ...p, email: emailById.get(p.id) ?? "—" }))
    .sort((a, b) => (a.role ?? "").localeCompare(b.role ?? ""));

  // The one refusal `removeStaff` makes, so a row can render the reason rather
  // than a button that silently does nothing. It also covers the sole manager
  // of a league, who is necessarily whoever is looking at this page.

  // The same idea for the role control: a role is instance-wide, so changing it
  // lands in every league that person works — and `updateStaffRole` refuses,
  // silently, any change that would reach one the viewer is not in. Worked out
  // here so the row says why instead of offering a control that does nothing.
  // `mayWriteProfileOf` is the server-side twin — this decides what to render,
  // that decides what happens, and they have to agree.
  const viewerLeagues = new Set(await memberLeagueIds(viewer.id));
  const leaguesOf = new Map<string, string[]>();
  for (const m of allMemberships ?? []) {
    leaguesOf.set(m.profile_id, [...(leaguesOf.get(m.profile_id) ?? []), m.league_id]);
  }
  const canChangeRole = (id: string) =>
    (leaguesOf.get(id) ?? []).every((l) => viewerLeagues.has(l));

  return (
    <div className="space-y-6">
      <PageHeader
        title="People & Roles"
        description="Create staff accounts and assign manager, captain, or scorekeeper roles."
      />

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Add a staff account</CardTitle>
        </CardHeader>
        <CardContent>
          <CreateStaffForm captains={captains} leagueId={ctx.league.id} />
        </CardContent>
      </Card>

      <div className="overflow-hidden rounded-lg border">
        <Table>
          <TableHeader>
            <TableRow className="bg-muted/40">
              <TableHead>Email</TableHead>
              <TableHead>Name</TableHead>
              <TableHead>Role</TableHead>
              <TableHead className="text-right">Manage</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {staff.map((s) => (
              <TableRow key={s.id}>
                <TableCell className="font-medium">{s.email}</TableCell>
                <TableCell className="text-muted-foreground">
                  {s.display_name ?? "—"}
                </TableCell>
                <TableCell>{ROLE_LABEL[s.role ?? ""] ?? "—"}</TableCell>
                <TableCell>
                  <StaffRowActions
                    id={s.id}
                    role={s.role ?? "scorekeeper"}
                    leagueId={ctx.league.id}
                    canRemove={s.id !== viewer.id}
                    canChangeRole={canChangeRole(s.id)}
                  />
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>

      <p className="text-muted-foreground text-xs">
        Staff sign in with a magic link — no passwords. This list is{" "}
        {ctx.league.name} only, and Remove takes someone out of this league —
        their account, and any other league they work in, are left alone. You
        cannot remove yourself, or the last manager of a league.
      </p>
    </div>
  );
}
