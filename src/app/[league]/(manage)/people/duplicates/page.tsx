import { notFound } from "next/navigation";
import { requireLeagueManager } from "@/lib/auth/guards";
import { resolveLeagueBySlug } from "@/lib/league/current";
import { createAdminClient } from "@/utils/supabase/admin";
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

// Nothing merges on its own: two real people share names. Candidates come only from this league's
// rosters, and the actions re-derive that scope from the ids, since a form is not evidence.
export default async function DuplicatesPage({
  params,
}: {
  params: Promise<{ league: string }>;
}) {
  const { league: leagueSlug } = await params;
  // Season-less, so not `getManageContext`: detection reads every season, leaving nothing to switch.
  const league = await resolveLeagueBySlug(leagueSlug);
  if (!league) notFound();
  const ctx = { league };
  await requireLeagueManager(ctx.league.id);
  const admin = createAdminClient();

  const { data: seasons } = await admin
    .from("seasons")
    .select("id, name")
    .eq("league_id", ctx.league.id);
  const seasonName = new Map((seasons ?? []).map((s) => [s.id, s.name]));
  const seasonIds = [...seasonName.keys()];

  // Every season and departed rows too (no `left_on` filter): identity, not today's team, and each import
  // run makes a new record per appearance. `.in()` with an empty list matches nothing, safely.
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

  // `findDuplicateClusters` returns one entry per matching row; the merge form offers records, not
  // appearances, so a record on two teams is collapsed here.
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

  // Dismissed names come from `players`, not the candidates: a record whose roster row is gone would show
  // as a blank line beside an Undo button.
  const dismissedIds = [
    ...new Set((pairs ?? []).flatMap((p) => [p.player_a, p.player_b])),
  ];
  const { data: dismissedPlayers } = await admin
    .from("players")
    .select("id, first_name, last_name")
    .in("id", dismissedIds);
  const nameOf = new Map(
    (dismissedPlayers ?? []).map((p) => [
      p.id,
      `${p.first_name} ${p.last_name}`.trim(),
    ]),
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
