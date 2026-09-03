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

  const [{ data: profiles }, { data: allMemberships }] = await Promise.all([
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

  // Addresses for THIS league's staff, asked for by id, a bounded number at a
  // time.
  //
  // This was `listUsers({ perPage: 1000 })` — one page of the instance's auth
  // users, joined against. A page says nothing about the rest, so past the
  // thousandth auth user staff would start vanishing from this table with no
  // error anywhere.
  //
  // Paging that call would answer the truncation too, and is the worse trade:
  // there is no batch-lookup-by-id in the admin API, so paging means reading the
  // whole auth table, and each page has to come back before the next can be
  // asked for. That is 50 serial round trips at ten thousand users, where asking
  // per member is one wave of however many staff this league has. The cost
  // tracks the league, which is what this page is about, rather than the
  // instance, which only grows.
  //
  // Capped anyway. `Promise.all` over the whole list would fire one request per
  // member with nothing bounding it, and a league with hundreds of staff would
  // open hundreds of admin connections at once to render a table.
  const LOOKUP_AT_A_TIME = 10;
  const emailById = new Map<string, string>();
  for (let i = 0; i < memberIds.length; i += LOOKUP_AT_A_TIME) {
    const looked = await Promise.all(
      memberIds.slice(i, i + LOOKUP_AT_A_TIME).map(async (id) => {
        const { data, error } = await admin.auth.admin.getUserById(id);
        // A lookup that failed is not an account without an address, and the
        // two used to render identically — so a rate-limited page read as staff
        // who simply have no email.
        if (error) return [id, "(address unavailable)"] as const;
        return [id, data.user?.email ?? "—"] as const;
      }),
    );
    for (const [id, email] of looked) emailById.set(id, email);
  }
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
