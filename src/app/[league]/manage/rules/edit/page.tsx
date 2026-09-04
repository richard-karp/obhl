import { notFound } from "next/navigation";
import { requireLeagueManager } from "@/lib/auth/guards";
import { resolveLeagueBySlug } from "@/lib/league/current";
import { getRules } from "@/lib/queries/rules";
import { RulesEditor } from "@/components/manage/rules-editor";
import { PageHeader } from "@/components/shared/page-header";

export default async function EditRulesPage({
  params,
}: {
  params: Promise<{ league: string }>;
}) {
  const { league: leagueSlug } = await params;
  // Rules belong to the LEAGUE, not a season (`league_rules`, 0002), so this
  // page takes no season, shows no switcher, and does not pay `getManageContext`
  // for a seasons list it would never read.
  const league = await resolveLeagueBySlug(leagueSlug);
  if (!league) notFound();
  const ctx = { league };
  await requireLeagueManager(ctx.league.id);
  const rules = await getRules(ctx.league.id);

  return (
    <div className="max-w-3xl space-y-6">
      <PageHeader
        title="League Rules"
        description="Edit the rules shown on the public site."
      />
      <RulesEditor leagueId={ctx.league.id} initialContent={rules?.content ?? null} />
    </div>
  );
}
