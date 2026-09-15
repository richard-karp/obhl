import { notFound } from "next/navigation";
import { SiteFooter } from "@/components/shared/site-footer";
import { resolveLeagueBySlug } from "@/lib/league/current";
import { requireVisibleLeague } from "@/lib/auth/guards";

// ⛔ The visibility gate is the point of this file. RLS 404s a staged league first; `requireVisibleLeague`
// is the app half of that mirrored pair (`visibility.ts`), kept for the day the two halves disagree.
export default async function PublicLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ league: string }>;
}) {
  const { league: slug } = await params;
  const league = await resolveLeagueBySlug(slug);
  // What reaches here exists but may be unpublished: a manager staging it must still open its public side.
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
