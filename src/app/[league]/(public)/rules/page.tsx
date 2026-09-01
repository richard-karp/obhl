import type { Metadata } from "next";
import { getActiveContext } from "@/lib/queries/season";
import { getRules } from "@/lib/queries/rules";
import { RulesRenderer } from "@/components/public/rules-renderer";
import { PageHeader } from "@/components/shared/page-header";
import { EmptyState } from "@/components/shared/empty-state";

export const metadata: Metadata = { title: "Rules" };

export default async function RulesPage({
  params,
}: {
  params: Promise<{ league: string }>;
}) {
  const { league: slug } = await params;
  const ctx = await getActiveContext(slug);
  const rules = await getRules(ctx.league.id);

  return (
    <div className="max-w-3xl space-y-6">
      <PageHeader title="League Rules" />
      {rules?.content ? (
        <RulesRenderer content={rules.content} />
      ) : (
        <EmptyState title="No rules published yet" />
      )}
    </div>
  );
}
