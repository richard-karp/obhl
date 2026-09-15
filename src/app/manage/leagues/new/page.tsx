import type { Metadata } from "next";
import Link from "next/link";
import { requireManager } from "@/lib/auth/guards";
import { EsportsdeskImport } from "@/components/manage/esportsdesk-import";
import { PageHeader } from "@/components/shared/page-header";

// ⚠️ Declared: outside `[league]`, the only ancestor is the root layout, whose default site title
// would name the tab.
export const metadata: Metadata = { title: "New league" };

// ⛔ Outside `[league]`, which is what makes the role-only `requireManager()` legal: a league not yet
// created has no members (`RUNBOOK.md` → Access control). `manage` is a reserved slug (0030).
export default async function NewLeaguePage() {
  // Role only, matching the actions this page submits to. No layout here: this page draws its own frame.
  await requireManager();
  return (
    <div className="mx-auto w-full max-w-4xl flex-1 px-4 py-8">
      <div className="mb-6">
        <Link
          href="/"
          className="text-muted-foreground hover:text-foreground text-sm"
        >
          ← All leagues
        </Link>
      </div>

      <div className="space-y-6">
        <PageHeader
          title="Import from esportsdesk"
          description="Pull a league from an esportsdesk site by URL — teams and players only, as a starting draft for a new season."
        />
        <EsportsdeskImport />
      </div>
    </div>
  );
}
