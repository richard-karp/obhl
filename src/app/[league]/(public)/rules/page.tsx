import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { resolveLeagueBySlug } from "@/lib/league/current";
import { getRules } from "@/lib/queries/rules";
import { canManageLeague } from "@/lib/auth/guards";
import { RulesRenderer } from "@/components/public/rules-renderer";
import { RulesSection } from "@/components/manage/rules-section";
import { PageHeader } from "@/components/shared/page-header";
import { EmptyState } from "@/components/shared/empty-state";

export const metadata: Metadata = { title: "Rules" };

export default async function RulesPage({
  params,
}: {
  params: Promise<{ league: string }>;
}) {
  const { league: slug } = await params;
  // No season and no `?season=`: rules belong to the league (`league_rules`, 0002).
  const league = await resolveLeagueBySlug(slug);
  if (!league) notFound();
  const rules = await getRules(league.id);
  const canEdit = await canManageLeague(league.id);

  // Built once for either wrapper, so the manager's preview and the public page cannot drift apart; a
  // visitor gets no editor in their bundle.
  const published = rules?.content ? (
    <RulesRenderer content={rules.content} />
  ) : (
    <EmptyState title="No rules published yet" />
  );

  return (
    <div className="max-w-3xl space-y-6">
      <PageHeader title="League Rules" />
      {canEdit ? (
        <RulesSection
          leagueId={league.id}
          initialContent={rules?.content ?? null}
        >
          {published}
        </RulesSection>
      ) : (
        published
      )}
    </div>
  );
}
