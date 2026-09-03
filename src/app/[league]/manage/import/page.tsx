import { requireLeagueManager } from "@/lib/auth/guards";
import { getActiveContext } from "@/lib/queries/season";
import { EsportsdeskImport } from "@/components/manage/esportsdesk-import";
import { PageHeader } from "@/components/shared/page-header";

export default async function ImportPage({
  params,
}: {
  params: Promise<{ league: string }>;
}) {
  // This page took no params at all, so it was the one manage page with no
  // league in hand to be guarded against — reachable under any league's URL by
  // anyone holding the manager role.
  const { league: leagueSlug } = await params;
  const ctx = await getActiveContext(leagueSlug);
  await requireLeagueManager(ctx.league.id);
  return (
    <div className="space-y-6">
      <PageHeader
        title="Import from esportsdesk"
        description="Pull a league from an esportsdesk site by URL — rosters only as a starting draft for a new season, or a full migration with the schedule and results."
      />
      <EsportsdeskImport />
    </div>
  );
}
