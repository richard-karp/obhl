import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { resolveLeagueBySlug } from "@/lib/league/current";
import { SiteHeader } from "@/components/shared/site-header";
import { ScorekeeperChrome } from "@/components/shared/scorekeeper-chrome";
import { StaffLinks } from "@/components/shared/staff-links";
import { getSessionUser } from "@/lib/auth/session";
import { isLeagueMember, getMemberLeagues } from "@/lib/auth/membership";
import { officeTierOf } from "@/lib/auth/office";

type Props = {
  children: React.ReactNode;
  params: Promise<{ league: string }>;
};

// Per-league title and OG name. `absolute` keeps the root template off the league's home title; the
// `template` is what the pages beneath augment.
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
    // `openGraph` is replaced wholesale, not merged, so the description is restated or previews lose it.
    openGraph: {
      title: league.name,
      description:
        "Standings, schedules, stats, teams, and rules for the league.",
      type: "website",
    },
  };
}

// ⛔ The chrome is not a guard: every page below keeps its own, and a page off the nav is still reachable.
// ⛔ Nor is `requireVisibleLeague` dead code: RLS hides a staged league today; it fires when halves disagree.
export default async function LeagueLayout({ children, params }: Props) {
  const { league: slug } = await params;
  const league = await resolveLeagueBySlug(slug);
  // `is_public` is not checked here: `(public)/layout.tsx` does, so a league is managed before it is public.
  if (!league) notFound();

  // ⚠️ Membership, not role: `user.role` is instance-wide, so a manager of another league would get this
  // league's tools. A captain gets the row too; `staffLinks` gives them the Dashboard link alone.
  const user = await getSessionUser();
  const member = user ? await isLeagueMember(user.id, league.id) : false;
  // Gated on the tier, not the role: an office member's role is `league_manager` like anyone else's.
  const [officeTier, leagues] =
    user && member
      ? await Promise.all([
          officeTierOf(user.id),
          // Member leagues, not every readable one: RLS would offer public leagues whose pages bounce them.
          getMemberLeagues(user.id),
        ])
      : [null, []];

  // ⛔ A scorekeeper gets the minimal chrome, not the site header, on every league page: it removes
  // clutter, never access, and leaves one obvious way back to `/tonight`.
  const scorekeeperOnly = user?.role === "scorekeeper" && member;

  return (
    <>
      {scorekeeperOnly ? (
        <div className="mx-auto w-full max-w-6xl px-4 pt-4">
          <ScorekeeperChrome role={user.role} showTonight />
        </div>
      ) : (
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
        </>
      )}
      {children}
    </>
  );
}
