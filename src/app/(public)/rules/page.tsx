import type { Metadata } from "next";
import { getActiveContext } from "@/lib/queries/season";
import { getRules } from "@/lib/queries/rules";
import { RulesRenderer } from "@/components/public/rules-renderer";
import { PageHeader } from "@/components/shared/page-header";
import { EmptyState } from "@/components/shared/empty-state";
import { NoSeason } from "@/components/public/no-season";

export const metadata: Metadata = { title: "Rules" };

export default async function RulesPage() {
  const ctx = await getActiveContext();
  if (!ctx) return <NoSeason />;
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
