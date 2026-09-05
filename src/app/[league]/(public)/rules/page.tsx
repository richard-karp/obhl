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

/**
 * The league rules — one URL, for everybody.
 *
 * This absorbed `/manage/rules/edit`, which was the same heading over the same
 * row of the same table with an editor instead of a renderer. Two URLs for one
 * thing is a thing a manager has to remember; one page that shows more to
 * whoever is entitled to more is not.
 */
export default async function RulesPage({
  params,
}: {
  params: Promise<{ league: string }>;
}) {
  const { league: slug } = await params;
  // No season, and no season switcher either — carried over from
  // `/manage/rules/edit`, which stopped paying for a season it never read:
  // rules belong to the LEAGUE (`league_rules`, 0002). This page is the one
  // merged surface with nothing to scope, which is why it takes no `?season=`
  // while the schedule and the team pages both do.
  const league = await resolveLeagueBySlug(slug);
  if (!league) notFound();
  const rules = await getRules(league.id);
  const canEdit = await canManageLeague(league.id);

  // Built once and handed to whichever wrapper is used, so the manager's
  // preview and the public page cannot drift into two renderings of one
  // document. An anonymous visitor gets exactly what they got before this page
  // learned about editing — the same markup, and no editor in their bundle.
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
