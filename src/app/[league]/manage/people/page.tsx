import { requireLeagueManager } from "@/lib/auth/guards";
import { createAdminClient } from "@/utils/supabase/admin";
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

// Fixed here and in League Office so the two surfaces cannot drift. Audit prose
// says "a commissioner" and "a deputy commissioner"; these are the column form.
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
  // Season-scoped for one reason: the captain candidates below come from one
  // season's rosters. Everything else on the page is league-wide.
  const ctx = await getManageContext(leagueSlug, seasonParam);
  const viewer = await requireLeagueManager(ctx.league.id);
  const admin = createAdminClient();

  // This league's staff, not the instance's. The page listed every profile in
  // the database, and its Remove button deleted the account outright — so a
  // manager of one league was handed the other league's staff to delete.
  const { data: members } = await admin
    .from("profile_leagues")
    .select("profile_id")
    .eq("league_id", ctx.league.id);
  const leagueMemberIds = (members ?? []).map((m) => m.profile_id);

  // The office is unioned in EXPLICITLY. Its members reach every league without
  // holding a `profile_leagues` row for any of them, so the query above cannot
  // see them and no amount of widening it would — the row does not exist. They
  // are listed because a manager looking at their own league's staff should see
  // everyone who can act in it, and their rows are read-only here.
  const officeTiers = await listOfficeTiers();
  const memberIds = [...new Set([...leagueMemberIds, ...officeTiers.keys()])];

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
      .eq("is_captain", true)
      // Current captains only — a departed row keeps its captaincy in the
      // history it preserves, and offering it here would link an account to a
      // team the person has left.
      .is("left_on", null);
    // Archived out of THIS league (0040) — filtered in memory rather than in the
    // query above, because `player_league_archive` has no join to `team_players`
    // and the candidate list is a handful of rows either way.
    //
    // ⚠️ This is the only player-derived list on this page. Everything else here
    // is staff PROFILES, which the archive has nothing to say about — a person
    // archived out of a league is not an account, and nothing here should go
    // looking for a general player list to filter, because there isn't one.
    const archived = await archivedPlayerIdsIn(ctx.league.id, admin);
    captains = (caps ?? [])
      .filter((c) => !archived.has(c.player_id))
      .map((c) => ({
        id: c.player_id,
        label: `${c.players?.first_name} ${c.players?.last_name} (${c.teams?.name})`,
      }));
  }

  // Addresses for everyone the table will show. The strategy, and why it is not
  // `listUsers`, is on `emailsByProfileId`.
  const emailById = await emailsByProfileId(admin, memberIds);

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
  // The SAME rule the server applies, not a second statement of it. What renders
  // and what `updateStaffRole` permits have to agree, and they now agree by
  // construction rather than by two pieces of logic being kept in step by hand.
  // Containment stays the tier-0 test; `decideProfileWrite` ignores it above that.
  const viewerTier = officeTiers.get(viewer.id) ?? null;
  // BOTH of `updateStaffRole`'s gates, in the same order, or the row offers what
  // the server refuses. `decideProfileWrite` is the precedence half; the second
  // clause is the demotion half — a manager may not unmake a peer, and the
  // office is the tier that can.
  const canChangeRole = (id: string, role: string | null) =>
    decideProfileWrite(
      viewerTier,
      officeTiers.get(id) ?? null,
      (leaguesOf.get(id) ?? []).every((l) => viewerLeagues.has(l)),
    ) && (role !== "league_manager" || viewerTier !== null);

  return (
    <div className="space-y-6">
      <PageHeader
        title="People & Roles"
        description="Create staff accounts and assign manager, captain, or scorekeeper roles."
      >
        {/*
          The switcher scopes the captain candidates in the form below, and
          nothing else on this page — the staff list is league-wide. It is here
          rather than in the brand bar for the reason on `SeasonSwitcher`.
        */}
        <SeasonSwitcher ctx={ctx} />
        {/*
          Here rather than in the top nav: the nav already carries its five
          inline links and a sixth pushes the whole set onto its own row, and
          duplicate review is a job you go looking for after an import, not a
          section of the site.
        */}
        <Button asChild variant="outline" size="sm">
          <Link href={`/${leagueSlug}/manage/people/duplicates`}>
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
