import Link from "next/link";
import { requireManager } from "@/lib/auth/guards";
import { createAdminClient } from "@/utils/supabase/admin";
import { getActiveContext } from "@/lib/queries/season";
import { ScheduleBuilderPanel } from "@/components/manage/schedule-builder-panel";
import { PageHeader } from "@/components/shared/page-header";
import { EmptyState } from "@/components/shared/empty-state";
import { Button } from "@/components/ui/button";

export default async function ScheduleBuilderPage() {
  await requireManager();
  const ctx = await getActiveContext();
  if (!ctx?.season) {
    return (
      <div className="space-y-4">
        <EmptyState
          title="No active season"
          description="Create a season and set it active, or build a schedule from a season's setup page."
        />
        <div className="text-center">
          <Button asChild size="sm">
            <Link href="/seasons">Go to Seasons</Link>
          </Button>
        </div>
      </div>
    );
  }

  const admin = createAdminClient();
  const { count } = await admin
    .from("season_teams")
    .select("*", { count: "exact", head: true })
    .eq("season_id", ctx.season.id);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Schedule Builder"
        description={`${ctx.season.name} (active) · ${count ?? 0} teams enrolled`}
      />
      <ScheduleBuilderPanel seasonId={ctx.season.id} />
    </div>
  );
}
