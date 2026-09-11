import { notFound, redirect } from "next/navigation";
import { requireLeagueManager } from "@/lib/auth/guards";
import { resolveLeagueBySlug } from "@/lib/league/current";
import { getManageContext } from "@/lib/queries/season";

/**
 * Where the schedule builder used to live.
 *
 * ⛔ THE BUILDER IS NOT A PLACE ANY MORE, AND THIS IS NOT A LEFTOVER. Building a
 * schedule is one step of creating a season (2026-09-11), so the only surface
 * that renders `ScheduleBuilderPanel` is that season's setup page. What a
 * started season can still change — per-game edits, moving a night, repair, a
 * one-off — lives on `/<league>/schedule`, which is where a manager looks at
 * games.
 *
 * ⚠️ A PAGE, NOT A `next.config.ts` REDIRECT, and the difference is the season.
 * A config redirect is a URL rewrite: it cannot look up WHICH season to land
 * on, and `/seasons?season=<id>` means nothing to the seasons index. This
 * resolves the manage context — honouring `?season=` exactly as the builder did
 * — and sends the manager to that season's setup page. The two SUB-routes
 * (`/repair`, `/one-off`) moved to `/schedule/...` and are plain path rewrites,
 * so those two ARE config redirects.
 *
 * ⚠️ THIS PAGE IS WHY `revalidate-paths.test.ts` CANNOT POLICE THIS RENAME.
 * That guard resolves every `revalidatePath` pattern against the real route
 * tree — and because this file keeps `/[league]/schedule-builder` a real route,
 * a leftover `revalidatePath("/[league]/schedule-builder", "page")` still
 * resolves and still passes. Measured by mutation on 2026-09-11: the bare path
 * passes 8/8, while `/[league]/schedule-builder/repair` fails by name, its
 * directory having gone. If you delete this redirect one day, the guard starts
 * covering the bare path too.
 *
 * ⚠️ The guard stays. This is still a `(manage)` page and it still reads the
 * manage context on the admin client, so it refuses a non-manager rather than
 * bouncing them somewhere that will.
 */
export default async function ScheduleBuilderMoved({
  params,
  searchParams,
}: {
  params: Promise<{ league: string }>;
  searchParams: Promise<{ season?: string }>;
}) {
  const { league: leagueParam } = await params;
  const { season: seasonParam } = await searchParams;
  // League, then GUARD, then context — the order every manage page uses.
  // `getManageContext` reads every season on the ADMIN client, so it must not
  // run for a request about to be refused.
  const league = await resolveLeagueBySlug(leagueParam);
  if (!league) notFound();
  await requireLeagueManager(league.id);
  const ctx = await getManageContext(leagueParam, seasonParam);
  // The resolved slug, not the URL's — the destination stays canonical from
  // /OBHL, the same way the builder's own links did.
  const slug = ctx.league.slug;
  // A league with no seasons has no setup page to land on; the index is where
  // it says so and offers to create one.
  redirect(
    ctx.season ? `/${slug}/seasons/${ctx.season.id}` : `/${slug}/seasons`,
  );
}
