import { notFound } from "next/navigation";
import { SiteHeader } from "@/components/shared/site-header";
import { SiteFooter } from "@/components/shared/site-footer";
import { resolveLeagueBySlug } from "@/lib/league/current";

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
  // league that exists but isn't published: visible to its manager on the
  // staff pages, absent from the public site until it goes live.
  if (!league || !league.is_public) notFound();

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
