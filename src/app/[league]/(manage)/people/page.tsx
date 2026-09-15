import { notFound } from "next/navigation";
import { requireLeagueManager } from "@/lib/auth/guards";
import { createAdminClient } from "@/utils/supabase/admin";
import { resolveLeagueBySlug } from "@/lib/league/current";
import { getManageContext } from "@/lib/queries/season";
import {
  CreateStaffForm,
  type CaptainOption,
} from "@/components/manage/create-staff-form";
import { StaffRowActions } from "@/components/manage/staff-row-actions";
import { memberLeagueIds } from "@/lib/auth/membership";
import { archivedPlayerIdsIn } from "@/lib/players/archive";
import { listOfficeTiers } from "@/lib/auth/office";
import { emailsByProfileId } from "@/lib/auth/users";
import { decideProfileWrite } from "@/lib/auth/precedence";
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
import { SeasonSwitcher } from "@/components/manage/season-switcher";
import { Button } from "@/components/ui/button";
import Link from "next/link";

const ROLE_LABEL: Record<string, string> = {
  league_manager: "Manager",
  scorekeeper: "Scorekeeper",
  captain: "Captain",
};

// The column form, matching League Office; audit prose says "a deputy commissioner".
const OFFICE_LABEL: Record<string, string> = {
  commissioner: "Commissioner",
  deputy: "Deputy",
};

export default async function PeoplePage({
  params,
  searchParams,
}: {
  params: Promise<{ league: string }>;
  searchParams: Promise<{ season?: string }>;
}) {
  const { league: leagueSlug } = await params;
  const { season: seasonParam } = await searchParams;
  // League, then guard, then context: `getManageContext` reads every season on the admin client, so it
  // must not run for a request about to be refused. The season scopes only the captain candidates.
  const league = await resolveLeagueBySlug(leagueSlug);
  if (!league) notFound();
  const viewer = await requireLeagueManager(league.id);
  const ctx = await getManageContext(leagueSlug, seasonParam);
  const admin = createAdminClient();

  // This league's staff, not the instance's: otherwise a manager is handed another league's staff to remove.
  const { data: members } = await admin
    .from("profile_leagues")
    .select("profile_id")
    .eq("league_id", ctx.league.id);
  const leagueMemberIds = (members ?? []).map((m) => m.profile_id);

  // The office is unioned in explicitly: it holds no `profile_leagues` row, so the query above cannot see
  // it. Listed because it can act in this league; its rows are read-only here.
  const officeTiers = await listOfficeTiers();
  const memberIds = [...new Set([...leagueMemberIds, ...officeTiers.keys()])];

  const [{ data: profiles }, { data: allMemberships }] = await Promise.all([
    memberIds.length
      ? admin
          .from("profiles")
          .select("id, role, display_name")
          .in("id", memberIds)
      : Promise.resolve({
          data: [] as {
            id: string;
            role: string | null;
            display_name: string | null;
          }[],
        }),
    // Every league these people work, not just this one — a role change reaches
    // all of them. One query for the table, rather than one per row.
    memberIds.length
      ? admin
          .from("profile_leagues")
          .select("profile_id, league_id")
          .in("profile_id", memberIds)
      : Promise.resolve({
          data: [] as { profile_id: string; league_id: string }[],
        }),
  ]);

  let captains: CaptainOption[] = [];
  if (ctx.season) {
    const { data: caps } = await admin
      .from("team_players")
      .select(
        "player_id, players!team_players_player_id_fkey(first_name, last_name), teams!team_players_team_id_fkey(name)",
      )
      .eq("season_id", ctx.season.id)
      .eq("is_captain", true)
      // Current captains only: a departed row keeps its captaincy, and would link an account to a team
      // the person has left.
      .is("left_on", null);
    // Archived out of this league (0040), filtered in memory: `player_league_archive` has no join to
    // `team_players`. The only player-derived list here; the rest is staff profiles.
    const archived = await archivedPlayerIdsIn(ctx.league.id, admin);
    captains = (caps ?? [])
      .filter((c) => !archived.has(c.player_id))
      .map((c) => ({
        id: c.player_id,
        label: `${c.players?.first_name} ${c.players?.last_name} (${c.teams?.name})`,
      }));
  }

  const emailById = await emailsByProfileId(admin, memberIds);

  const staff = (profiles ?? [])
    .map((p) => ({ ...p, email: emailById.get(p.id) ?? "—" }))
    .sort((a, b) => (a.role ?? "").localeCompare(b.role ?? ""));

  // A role is instance-wide, and `updateStaffRole` silently refuses a change reaching a league the viewer
  // is not in, so the row renders the reason instead of a control that does nothing.
  const viewerLeagues = new Set(await memberLeagueIds(viewer.id));
  const leaguesOf = new Map<string, string[]>();
  for (const m of allMemberships ?? []) {
    leaguesOf.set(m.profile_id, [
      ...(leaguesOf.get(m.profile_id) ?? []),
      m.league_id,
    ]);
  }
  const viewerTier = officeTiers.get(viewer.id) ?? null;
  // ⚠️ Both of `updateStaffRole`'s gates, in its order, or the row offers what the server refuses: the
  // same `decideProfileWrite`, then a manager may not unmake a peer (the office can).
  const canChangeRole = (id: string, role: string | null) =>
    decideProfileWrite(
      viewerTier,
      officeTiers.get(id) ?? null,
      (leaguesOf.get(id) ?? []).every((l) => viewerLeagues.has(l)),
    ) &&
    (role !== "league_manager" || viewerTier !== null);

  return (
    <div className="space-y-6">
      <PageHeader
        title="People & Roles"
        description="Create staff accounts and assign manager, captain, or scorekeeper roles."
      >
        {/*
          The switcher scopes only the captain candidates in the form below; the staff list is league-wide.
        */}
        <SeasonSwitcher ctx={ctx} />
        {/*
          The only link to the duplicates review: neither `NavLinks` nor the staff row lists it.
        */}
        <Button asChild variant="outline" size="sm">
          <Link href={`/${leagueSlug}/people/duplicates`}>
            Possible duplicates
          </Link>
        </Button>
      </PageHeader>

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
                <TableCell>
                  {OFFICE_LABEL[officeTiers.get(s.id) ?? ""] ??
                    ROLE_LABEL[s.role ?? ""] ??
                    "—"}
                </TableCell>
                <TableCell>
                  <StaffRowActions
                    id={s.id}
                    role={s.role ?? "scorekeeper"}
                    leagueId={ctx.league.id}
                    canRemove={s.id !== viewer.id}
                    canChangeRole={canChangeRole(s.id, s.role)}
                    officeTier={officeTiers.get(s.id) ?? null}
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
