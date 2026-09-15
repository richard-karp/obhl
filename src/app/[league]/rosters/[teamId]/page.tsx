import { notFound, permanentRedirect } from "next/navigation";
import { createAdminClient } from "@/utils/supabase/admin";
import { resolveLeagueBySlug } from "@/lib/league/current";
import { requireVisibleLeague } from "@/lib/auth/guards";

// ⛔ A page, not a `next.config.ts` rewrite (an id must become a slug), in neither route group:
// `(manage)` would send an anonymous visitor to /login instead of the public team page.
export default async function RosterRedirectPage({
  params,
}: {
  params: Promise<{ league: string; teamId: string }>;
}) {
  const { league: slug, teamId } = await params;
  const league = await resolveLeagueBySlug(slug);
  if (!league) notFound();
  // The destination applies this, so this must too, or a 308 hands out a staged league's team slug.
  await requireVisibleLeague(league);

  // `error` is discarded on purpose: a malformed uuid (22P02) gets the same 404 as another league's team,
  // whose slug must not leak.
  const { data: team } = await createAdminClient()
    .from("teams")
    .select("slug, league_id")
    .eq("id", teamId)
    .maybeSingle();
  if (!team || team.league_id !== league.id) notFound();

  permanentRedirect(`/${league.slug}/teams/${team.slug}`);
}
