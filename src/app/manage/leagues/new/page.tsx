import type { Metadata } from "next";
import Link from "next/link";
import { requireManager } from "@/lib/auth/guards";
import { EsportsdeskImport } from "@/components/manage/esportsdesk-import";
import { PageHeader } from "@/components/shared/page-header";

// ⚠️ DECLARED, unlike the page this replaces. Under `[league]` it inherited
// `[league]/layout.tsx`'s `title: { absolute: league.name }` and needed nothing.
// Out here the only ancestor is the root layout, whose default is the site's own
// "OBHL — Recreational Hockey League" — so without this the tab would say less
// than it did before the move. The root template renders this as "New league · OBHL".
export const metadata: Metadata = { title: "New league" };

/**
 * Creating a league, at `/manage/leagues/new` — outside `[league]`, because a
 * league that does not exist yet belongs to no league.
 *
 * ⛔ THE ROUTE IS WHAT MAKES THE GUARD LEGAL. `requireManager()` is role-only,
 * and `src/lib/actions/league-guards.test.ts` asserts that no page under
 * `[league]/(manage)` uses a role-only guard — correctly, because inside a
 * league the role is not enough. Here there is no league to be a member of: the
 * two importers behind this page create one and grant the creating manager
 * membership as their first write. Moving this file back under `[league]` would
 * fail that test, and rightly.
 *
 * Safe as a top-level route for the same reason `/manage/office` is: `manage` is
 * a reserved league slug (0030), so nothing can ever answer beneath it.
 *
 * ⚠️ There is no layout in `src/app/manage/`, so this page draws its own frame.
 * `SiteHeader` and the staff link row come from `[league]/layout.tsx`, which
 * this route is outside of — which also means the back-link below is the only
 * way out of this page, and a clean import redirects past it into the new
 * league.
 */
export default async function NewLeaguePage() {
  // Role only, matching the actions this page submits to. A scorekeeper or a
  // captain gets the picker, the same as any other refusal; anyone signed out is
  // sent to /login by `requireUser` beneath this.
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
          description="Pull a league from an esportsdesk site by URL — rosters only as a starting draft for a new season, or a full migration with the schedule and results."
        />
        <EsportsdeskImport />
      </div>
    </div>
  );
}
