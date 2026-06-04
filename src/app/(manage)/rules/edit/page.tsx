import { requireManager } from "@/lib/auth/guards";
import { getActiveContext } from "@/lib/queries/season";
import { getRules } from "@/lib/queries/rules";
import { RulesEditor } from "@/components/manage/rules-editor";
import { PageHeader } from "@/components/shared/page-header";
import { EmptyState } from "@/components/shared/empty-state";

export default async function EditRulesPage() {
  await requireManager();
  const ctx = await getActiveContext();
  if (!ctx) return <EmptyState title="No league found" />;
  const rules = await getRules(ctx.league.id);

  return (
    <div className="max-w-3xl space-y-6">
      <PageHeader
        title="League Rules"
        description="Edit the rules shown on the public site."
      />
      <RulesEditor initialContent={rules?.content ?? null} />
    </div>
  );
}
