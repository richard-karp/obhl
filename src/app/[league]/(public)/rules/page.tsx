import type { Metadata } from "next";
import { getActiveContext } from "@/lib/queries/season";
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
  const ctx = await getActiveContext(slug);
  const rules = await getRules(ctx.league.id);
  const canEdit = await canManageLeague(ctx.league.id);

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
          leagueId={ctx.league.id}
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
