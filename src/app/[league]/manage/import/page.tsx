import { requireManager } from "@/lib/auth/guards";
import { EsportsdeskImport } from "@/components/manage/esportsdesk-import";
import { PageHeader } from "@/components/shared/page-header";

export default async function ImportPage() {
  await requireManager();
  return (
    <div className="space-y-6">
      <PageHeader
        title="Import from esportsdesk"
        description="Migrate a league's teams, rosters, and final results from an esportsdesk site by URL."
      />
      <EsportsdeskImport />
    </div>
  );
}
