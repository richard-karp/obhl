import { redirect, notFound } from "next/navigation";
import { getSessionUser } from "@/lib/auth/session";
import { getMemberLeagues } from "@/lib/auth/membership";
import { ManageNav } from "@/components/manage/manage-nav";
import { resolveLeagueBySlug } from "@/lib/league/current";

export default async function ManageLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ league: string }>;
}) {
  const user = await getSessionUser();
  if (!user) redirect("/login");

  const { league: slug } = await params;
  const [league, leagues] = await Promise.all([
    // Resolved again rather than inherited: layouts cannot pass data down. The
    // lookup is memoized, so this is the same query `[league]/layout.tsx` and
    // the page beneath both make, answered once.
    resolveLeagueBySlug(slug),
    // The switcher offers the leagues this account is a member of, not every
    // league it can read. RLS alone would still hand a manager every *public*
    // league through the public-read policy, so the switcher would keep
    // offering a league whose pages then bounce them back to the picker.
    getMemberLeagues(user.id),
  ]);
  if (!league) notFound();

  return (
    <div className="flex min-h-full flex-col">
      <ManageNav role={user.role} leagues={leagues} currentSlug={league.slug} />
      <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-8">
        {children}
      </main>
    </div>
  );
}
