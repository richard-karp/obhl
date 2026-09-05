import { notFound } from "next/navigation";
import { SiteHeader } from "@/components/shared/site-header";
import { SiteFooter } from "@/components/shared/site-footer";
import { resolveLeagueBySlug } from "@/lib/league/current";
import { requireVisibleLeague } from "@/lib/auth/guards";

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
  // constant: these pages are becoming shared, so a manager staging a league
  // has to be able to open the public side of it while the public cannot.
  if (!league) notFound();
  await requireVisibleLeague(league);

  return (
    <>
      <SiteHeader league={league} />
      <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-6 sm:py-8">
        {children}
      </main>
      <SiteFooter leagueName={league.name} />
    </>
  );
}
