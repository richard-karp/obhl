import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { resolveLeagueBySlug } from "@/lib/league/current";
import { SiteHeader } from "@/components/shared/site-header";
import { StaffLinks } from "@/components/manage/manage-nav";
import { getSessionUser } from "@/lib/auth/session";
import { isLeagueMember, getMemberLeagues } from "@/lib/auth/membership";
import { officeTierOf } from "@/lib/auth/office";

type Props = {
  children: React.ReactNode;
  params: Promise<{ league: string }>;
};

/**
 * Per-league title and OG name, so a link someone shares to `/harbor` previews
 * as Harbor rather than the generic site name. `absolute` on the default keeps
 * the root template from appending the site name to the league's own home
 * title; the `template` here is what the pages beneath augment.
 */
export async function generateMetadata({
  params,
}: {
  params: Promise<{ league: string }>;
}): Promise<Metadata> {
  const { league: slug } = await params;
  const league = await resolveLeagueBySlug(slug);
  if (!league) return {};
  return {
    title: { absolute: league.name, template: `%s · ${league.name}` },
    // `openGraph` is replaced wholesale by the deepest segment that defines it,
    // not merged, so the root layout's description has to be restated here or
    // league links preview with no text under the title.
    openGraph: {
      title: league.name,
      description:
        "Standings, schedules, stats, teams, and rules for the league.",
      type: "website",
    },
  };
}

/**
 * Resolves the league once for everything beneath it, so no page below needs a
 * null check, and draws THE header — the one every page under `/<league>` gets,
 * public and staff alike.
 *
 * An unknown slug 404s here — `notFound()` terminates rendering of the segment
 * it is thrown in, children included.
 *
 * `is_public` is deliberately *not* checked here: `(public)/layout.tsx` applies
 * it, which is what lets a league be managed before it is published.
 *
 * ⛔ THE CHROME IS NOT A GUARD, AND MOVING IT MOVED NO GUARD. `(public)`'s
 * `requireVisibleLeague` and `(manage)`'s `if (!user) redirect("/login")` both
 * stay exactly where they were, as does every `requireLeagueManager` on the
 * pages beneath. A page that stops being named by a nav is still reachable by
 * typing its URL; its own guard is the only thing between that URL and the data.
 *
 * ⚠️ The one visible consequence of resolving the header up here: a staged
 * league 404s in `(public)/layout.tsx`, which is BELOW this, so the 404 now
 * renders inside this header instead of on a bare page. It exposes nothing new —
 * the header names no league, and `generateMetadata` above has always titled the
 * tab with the league's name.
 */
export default async function LeagueLayout({ children, params }: Props) {
  const { league: slug } = await params;
  const league = await resolveLeagueBySlug(slug);
  if (!league) notFound();

  // ⚠️ MEMBERSHIP, NOT ROLE, and the same `isLeagueMember` the header itself
  // asks — `user.role` is instance-wide (it comes from the JWT), so a manager of
  // the OTHER league would otherwise be handed this league's tools, every one of
  // which answers with a redirect back to the picker. Both lookups are memoized
  // per request, so `SiteHeader` below re-asking costs nothing, and for an
  // anonymous visitor this is one `getClaims()` that short-circuits on a missing
  // cookie.
  //
  // Wider than the `canScoreLeague` gate this replaced, deliberately: that
  // admitted managers and scorekeepers only, so a captain — who has a dashboard
  // and reaches it from nowhere else — got no row at all. `staffLinks` already
  // answers a null or captain role with the Dashboard link and nothing more.
  const user = await getSessionUser();
  const member = user ? await isLeagueMember(user.id, league.id) : false;
  // Gated on the TIER, not the role: an office member's role is
  // `league_manager` like anyone else's. Asked only for a member, and memoized —
  // `isLeagueMember` has already asked it for anyone who reaches here.
  const [officeTier, leagues] =
    user && member
      ? await Promise.all([
          officeTierOf(user.id),
          // The switcher offers the leagues this account is a MEMBER of, not
          // every league it can read: RLS alone would hand a manager every
          // public league through the public-read policy, so the switcher would
          // keep offering a league whose pages bounce them back to the picker.
          getMemberLeagues(user.id),
        ])
      : [null, []];

  return (
    <>
      <SiteHeader league={league} />
      {user && member ? (
        <StaffLinks
          role={user.role}
          currentSlug={league.slug}
          officeTier={officeTier}
          leagues={leagues}
        />
      ) : null}
      {children}
    </>
  );
}
