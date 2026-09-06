import { notFound } from "next/navigation";
import { SiteFooter } from "@/components/shared/site-footer";
import { resolveLeagueBySlug } from "@/lib/league/current";
import { requireVisibleLeague } from "@/lib/auth/guards";

/**
 * The public half of a league: everything a visitor may see.
 *
 * ⛔ THE VISIBILITY GATE IS THE POINT OF THIS FILE, and it is the reason the
 * file still exists now that the chrome has moved up to `[league]/layout.tsx`.
 * It is not chrome and it did not move.
 *
 * ⚠️ BUT DO NOT READ IT AS THE THING KEEPING A STAGED LEAGUE HIDDEN TODAY. RLS
 * does that one layer above: `leagues` has three SELECT policies — `is_public`,
 * `manages_league(id)`, `is_league_member(id)` — whose disjunction is
 * `decideLeagueVisible(is_public, member)` restated, so a viewer who cannot see
 * the league gets `null` from `resolveLeagueBySlug` and a 404 in
 * `[league]/layout.tsx` before this file runs. `requireVisibleLeague` is the app
 * half of that mirrored pair (`lib/league/visibility.ts`), kept because the day
 * the two halves disagree is the day it is the only thing left. Defence in
 * depth, stated as such rather than overstated.
 *
 * The header, and the staff link row beneath it, are drawn once in
 * `[league]/layout.tsx` for every page under `/<league>` — public and staff
 * alike. There is one site, so there is one header; a shared page is a public
 * page with more on it, and the staff row is the more.
 */
export default async function PublicLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ league: string }>;
}) {
  const { league: slug } = await params;
  const league = await resolveLeagueBySlug(slug);
  // `[league]/layout.tsx` has already 404'd an unknown slug. What is left is a
  // league that exists but isn't published, and who may see THAT is no longer a
  // constant: these pages are shared, so a manager staging a league has to be
  // able to open the public side of it while the public cannot.
  if (!league) notFound();
  await requireVisibleLeague(league);

  return (
    <>
      <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-6 sm:py-8">
        {children}
      </main>
      <SiteFooter leagueName={league.name} />
    </>
  );
}
