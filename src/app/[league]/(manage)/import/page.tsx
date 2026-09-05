import { notFound } from "next/navigation";
import { requireLeagueManager } from "@/lib/auth/guards";
import { resolveLeagueBySlug } from "@/lib/league/current";
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
  // ⚠️ `resolveLeagueBySlug`, not `getManageContext`. This page reads the league
  // and nothing else — an import creates its own season — so asking for the
  // manage context would buy a cookie read and a full seasons query it never
  // looks at.
  const league = await resolveLeagueBySlug(leagueSlug);
  if (!league) notFound();
  const ctx = { league };
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
