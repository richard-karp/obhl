import { redirect, notFound } from "next/navigation";
import { getSessionUser } from "@/lib/auth/session";
import { resolveLeagueBySlug } from "@/lib/league/current";

// ⛔ `if (!user) redirect("/login")` stays: the coarse gate over every page in this group, not chrome.
// Each page keeps its own fine guard; the header is drawn by `[league]/layout.tsx`.
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
  // Resolved again: layouts cannot pass data down, and the lookup is memoized.
  const league = await resolveLeagueBySlug(slug);
  if (!league) notFound();

  return (
    <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-8">
      {children}
    </main>
  );
}
