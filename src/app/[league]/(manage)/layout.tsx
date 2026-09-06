import { redirect, notFound } from "next/navigation";
import { getSessionUser } from "@/lib/auth/session";
import { resolveLeagueBySlug } from "@/lib/league/current";

/**
 * The staff pages of a league.
 *
 * ⛔ `if (!user) redirect("/login")` STAYS. It is the coarse gate over every
 * page in this group — the fine one is each page's own `requireLeagueManager` /
 * `requireGameRole` — and it is not chrome. When the two headers merged into one
 * this file lost its `ManageNav` — the header component, now
 * `components/shared/staff-links.tsx` with only its link row left — and kept
 * every guard it had.
 *
 * There is no header here any more: `[league]/layout.tsx` draws it, with the
 * staff link row beneath it, for every page under `/<league>`. That is what
 * makes the staff pages part of the site rather than a second site — the same
 * header, the same league nav, plus the row of things only staff can do.
 */
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
  // Resolved again rather than inherited: layouts cannot pass data down. The
  // lookup is memoized, so this is the same query `[league]/layout.tsx` and the
  // page beneath both make, answered once.
  const league = await resolveLeagueBySlug(slug);
  if (!league) notFound();

  return (
    <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-8">
      {children}
    </main>
  );
}
