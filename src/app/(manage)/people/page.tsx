import { requireManager } from "@/lib/auth/guards";
import { createAdminClient } from "@/utils/supabase/admin";
import { getActiveContext } from "@/lib/queries/season";
import {
  CreateStaffForm,
  type CaptainOption,
} from "@/components/manage/create-staff-form";
import { StaffRowActions } from "@/components/manage/staff-row-actions";
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

/* eslint-disable @typescript-eslint/no-explicit-any */
export default async function PeoplePage() {
  await requireManager();
  const admin = createAdminClient();
  const ctx = await getActiveContext();

  const [{ data: usersList }, { data: profiles }] = await Promise.all([
    admin.auth.admin.listUsers({ perPage: 1000 }),
    admin.from("profiles").select("id, role, display_name"),
  ]);

  let captains: CaptainOption[] = [];
  if (ctx?.season) {
    const { data: caps } = await admin
      .from("team_players")
      .select(
        "player_id, players!team_players_player_id_fkey(first_name, last_name), teams!team_players_team_id_fkey(name)",
      )
      .eq("season_id", ctx.season.id)
      .eq("is_captain", true);
    captains = (caps ?? []).map((c: any) => ({
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
          <CreateStaffForm captains={captains} />
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
                  <StaffRowActions id={s.id} role={s.role ?? "scorekeeper"} />
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>

      <p className="text-muted-foreground text-xs">
        Staff sign in with a magic link — no passwords. Removing an account
        revokes access immediately.
      </p>
    </div>
  );
}
/* eslint-enable @typescript-eslint/no-explicit-any */
