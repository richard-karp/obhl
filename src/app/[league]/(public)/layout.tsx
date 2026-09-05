import { notFound } from "next/navigation";
import { SiteHeader } from "@/components/shared/site-header";
import { SiteFooter } from "@/components/shared/site-footer";
import { resolveLeagueBySlug } from "@/lib/league/current";
import { requireVisibleLeague, canManageLeague } from "@/lib/auth/guards";
import { getSessionUser } from "@/lib/auth/session";
import { officeTierOf } from "@/lib/auth/office";
import { StaffLinks } from "@/components/manage/manage-nav";

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

  // These pages are shared: `/rules`, `/teams/<slug>` and `/schedule` each serve
  // the public and the people who run the league from one URL. Following one used
  // to cost a manager every link in `ManageNav`, because the manage chrome lives
  // in the other route group — a consequence of the merges that nobody chose.
  //
  // The row is additive: `SiteHeader` stays, so "All leagues", the badge and the
  // link on to the tools all still work, and the page still reads as the public
  // page it is. `getSessionUser` and `isLeagueMember` are both memoized, so for a
  // manager this is one extra membership read the header already paid for, and
  // for everyone else — including every anonymous visitor — it is one short-
  // circuit on a missing cookie.
  const user = (await canManageLeague(league.id))
    ? await getSessionUser()
    : null;
  const officeTier = user ? await officeTierOf(user.id) : null;

  return (
    <>
      <SiteHeader league={league} />
      {user ? (
        <StaffLinks
          role={user.role}
          currentSlug={league.slug}
          officeTier={officeTier}
        />
      ) : null}
      <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-6 sm:py-8">
        {children}
      </main>
      <SiteFooter leagueName={league.name} />
    </>
  );
}
