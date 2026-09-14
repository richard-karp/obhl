import { SeasonSelect } from "./season-select";
import type { ManageContext } from "@/lib/queries/season";

// ⚠️ In the page's header row, not the brand bar, which has no width left for another control. A server
// component, so the client gets three fields per season.
export function SeasonSwitcher({ ctx }: { ctx: ManageContext }) {
  if (ctx.seasons.length === 0) return null;
  return (
    <SeasonSelect
      leagueSlug={ctx.league.slug}
      currentId={ctx.season?.id ?? null}
      seasons={ctx.seasons.map((s) => ({
        id: s.id,
        name: s.name,
        isActive: s.is_active,
      }))}
    />
  );
}
