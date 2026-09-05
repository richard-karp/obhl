import { notFound, permanentRedirect } from "next/navigation";
import { createAdminClient } from "@/utils/supabase/admin";
import { resolveLeagueBySlug } from "@/lib/league/current";

/**
 * `/rosters/<uuid>` moved to `/teams/<slug>`, and this is the only redirect in
 * the change that cannot be a path rewrite: the old URL names a team by id and
 * the new one names it by slug, so something has to look the row up.
 *
 * ⛔ It lives in NEITHER route group, and that is the point. Under `(manage)` it
 * would inherit that layout's `if (!user) redirect("/login")`, so an anonymous
 * visitor following an old link would land on a sign-in page instead of the
 * public team page they were entitled to all along. Under `(public)` it would
 * take the header and the visibility gate for a page that renders nothing. Here
 * only `[league]/layout.tsx` applies, which resolves the league and 404s an
 * unknown one.
 *
 * It still enforces that the team belongs to the league in the URL: an id says
 * nothing about whose it is, and answering for another league's team would leak
 * that team's slug.
 */
export default async function RosterRedirectPage({
  params,
}: {
  params: Promise<{ league: string; teamId: string }>;
}) {
  const { league: slug, teamId } = await params;
  const league = await resolveLeagueBySlug(slug);
  if (!league) notFound();

  const { data: team } = await createAdminClient()
    .from("teams")
    .select("slug, league_id")
    .eq("id", teamId)
    .maybeSingle();
  if (!team || team.league_id !== league.id) notFound();

  permanentRedirect(`/${league.slug}/teams/${team.slug}`);
}
