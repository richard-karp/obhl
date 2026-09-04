import { SeasonSelect } from "./season-select";
import type { ManageContext } from "@/lib/queries/season";

/**
 * The season switcher, as a manage page drops it into its header row.
 *
 * ⚠️ THE HEADER ROW, NOT THE BRAND BAR. `manage-nav.tsx` carries a measured
 * `MAX_INLINE_LINKS` whose comment states there is no fallback behind the
 * threshold and that anything added past it needs re-measuring there. Putting
 * the season beside the page title sidesteps that measurement entirely, and
 * keeps the season visible next to the content it scopes.
 *
 * A server component so the client bundle gets three fields per season rather
 * than the whole row — `ai_summary` alone can be a paragraph of generated prose,
 * and none of it is wanted in the browser.
 *
 * Renders nothing for a league with no seasons: there is nothing to switch
 * between, and the page beneath already says so in its own empty state.
 */
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
