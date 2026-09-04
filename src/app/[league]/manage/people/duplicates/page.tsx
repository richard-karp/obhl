import { requireLeagueManager } from "@/lib/auth/guards";
import { createAdminClient } from "@/utils/supabase/admin";
import { getActiveContext } from "@/lib/queries/season";
import {
  findDuplicateClusters,
  type DuplicateCandidate,
} from "@/lib/players/duplicates";
import {
  DuplicateClusters,
  type ClusterView,
  type DismissedPair,
} from "@/components/manage/duplicate-clusters";
import { PageHeader } from "@/components/shared/page-header";

/**
 * Review same-name player records and fold the real duplicates into one.
 *
 * A roster-only import carries names and nothing else, so it creates a fresh
 * `players` row for every team appearance: one person who played for two teams
 * arrives as two records, and their stats split across both. Two real people
 * also share a name, which is why nothing here merges on its own.
 *
 * Scoped to this league by construction. Candidates come only from roster rows
 * in this league's seasons, so a record from another league is not a disabled
 * option — it is never on the page. The actions re-derive the same scope from
 * the ids they are given, since a form is not evidence.
 */
export default async function DuplicatesPage({
  params,
}: {
  params: Promise<{ league: string }>;
}) {
  const { league: leagueSlug } = await params;
  const ctx = await getActiveContext(leagueSlug);
  await requireLeagueManager(ctx.league.id);
  const admin = createAdminClient();

  const { data: seasons } = await admin
    .from("seasons")
    .select("id, name")
    .eq("league_id", ctx.league.id);
  const seasonName = new Map((seasons ?? []).map((s) => [s.id, s.name]));
  const seasonIds = [...seasonName.keys()];

  // Every season, and departed rows too — no `left_on` filter here. This is a
  // question about identity, not about who is on a team today, and a record
  // that only ever appears as a departure is exactly as likely to be someone's
  // duplicate. The importer also makes a new record per appearance each time it
  // runs, so last season's import and this one's split the same person.
  // `.in()` with an empty list is a valid filter that matches nothing, so a
  // league with no seasons yet needs no special case here.
  const [{ data: rows }, { data: pairs }] = await Promise.all([
    admin
      .from("team_players")
      .select(
        "player_id, season_id, team_id, jersey_number, position, left_on, players!team_players_player_id_fkey(first_name, last_name), teams!team_players_team_id_fkey(name)",
      )
      .in("season_id", seasonIds),
    admin
      .from("player_distinct_pairs")
      .select("id, player_a, player_b")
      .eq("league_id", ctx.league.id),
  ]);

  const candidates: DuplicateCandidate[] = (rows ?? []).map((r) => ({
    playerId: r.player_id,
    firstName: r.players?.first_name ?? "",
    lastName: r.players?.last_name ?? "",
    seasonId: r.season_id,
    teamId: r.team_id,
    teamName: r.teams?.name ?? "—",
    jerseyNumber: r.jersey_number,
    position: r.position,
    leftOn: r.left_on,
  }));

  const clusters = findDuplicateClusters(
    candidates,
    (pairs ?? []).map((p) => [p.player_a, p.player_b] as const),
  );

  // `findDuplicateClusters` returns one entry per matching ROW, so a record on
  // two teams is in its cluster twice. The merge form offers records, not
  // appearances, so the collapse happens here — see the note on that function.
  const views: ClusterView[] = clusters.map((c) => {
    const byPlayer = new Map<string, ClusterView["players"][number]>();
    for (const m of c.members) {
      const existing = byPlayer.get(m.playerId);
      const appearance = {
        seasonName: seasonName.get(m.seasonId) ?? "—",
        teamName: m.teamName,
        jerseyNumber: m.jerseyNumber,
        position: m.position,
        leftOn: m.leftOn ?? null,
      };
      if (existing) existing.appearances.push(appearance);
      else
        byPlayer.set(m.playerId, {
          id: m.playerId,
          name: `${m.firstName} ${m.lastName}`.trim(),
          appearances: [appearance],
        });
    }
    const players = [...byPlayer.values()];
    return { key: c.key, name: players[0]?.name ?? c.key, players };
  });

  // Names for the dismissed list. Read from `players` rather than the candidate
  // rows above: a dismissed record whose roster row has since been deleted is
  // not among them, and it would otherwise show as a blank line with an Undo
  // button beside it.
  const dismissedIds = [
    ...new Set((pairs ?? []).flatMap((p) => [p.player_a, p.player_b])),
  ];
  const { data: dismissedPlayers } = await admin
    .from("players")
    .select("id, first_name, last_name")
    .in("id", dismissedIds);
  const nameOf = new Map(
    (dismissedPlayers ?? []).map((p) => [p.id, `${p.first_name} ${p.last_name}`.trim()]),
  );
  const dismissed: DismissedPair[] = (pairs ?? []).map((p) => ({
    id: p.id,
    nameA: nameOf.get(p.player_a) ?? "a deleted record",
    nameB: nameOf.get(p.player_b) ?? "a deleted record",
  }));

  return (
    <div className="space-y-6">
      <PageHeader
        title="Possible duplicates"
        description="Records that share a name. Merging is permanent — marking two records as different people is not."
      />
      <DuplicateClusters
        leagueId={ctx.league.id}
        clusters={views}
        dismissed={dismissed}
      />
    </div>
  );
}
