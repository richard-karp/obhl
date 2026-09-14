import { notFound, redirect } from "next/navigation";
import { requireLeagueManager } from "@/lib/auth/guards";
import { resolveLeagueBySlug } from "@/lib/league/current";
import { getManageContext } from "@/lib/queries/season";

// ⛔ Not a leftover: a page, not a `next.config.ts` redirect, since it must look up which season's setup
// page to land on. Being a route, it hides a stale `revalidatePath` here from `revalidate-paths.test.ts`.
export default async function ScheduleBuilderMoved({
  params,
  searchParams,
}: {
  params: Promise<{ league: string }>;
  searchParams: Promise<{ season?: string }>;
}) {
  const { league: leagueParam } = await params;
  const { season: seasonParam } = await searchParams;
  // ⚠️ The guard stays, then context: `getManageContext` reads every season on the admin client, so it
  // must not run for a request about to be refused.
  const league = await resolveLeagueBySlug(leagueParam);
  if (!league) notFound();
  await requireLeagueManager(league.id);
  const ctx = await getManageContext(leagueParam, seasonParam);
  // The resolved slug, not the URL's: the destination stays canonical from /OBHL.
  const slug = ctx.league.slug;
  // A league with no seasons has no setup page to land on; the index is where
  // it says so and offers to create one.
  redirect(
    ctx.season ? `/${slug}/seasons/${ctx.season.id}` : `/${slug}/seasons`,
  );
}
