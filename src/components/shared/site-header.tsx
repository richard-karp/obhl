import Link from "next/link";
import { NavLinks } from "./nav-links";
import { AccountCluster } from "./account-cluster";
import { getSessionUser } from "@/lib/auth/session";
import { isLeagueMember } from "@/lib/auth/membership";
import type { Tables } from "@/lib/db/helpers";

/**
 * A server component, so it can ask who is viewing without any prop-drilling
 * through the layout and without growing the client bundle. The cost for an
 * anonymous visitor is one `getClaims()` that short-circuits on a missing
 * cookie; these pages already read cookies through the Supabase server client
 * and are already dynamically rendered, so nothing about rendering changes.
 */
export async function SiteHeader({ league }: { league: Tables<"leagues"> }) {
  const user = await getSessionUser();
  // Membership, not just a role. `user.role` is instance-wide (it comes from
  // the JWT), so a manager of the OTHER league would otherwise be offered a
  // Manage link into this one — which every page behind it answers with a
  // redirect back to the picker. The lookup is memoized per request and runs
  // only for a signed-in viewer.
  const member = user ? await isLeagueMember(user.id, league.id) : false;

  return (
    <header className="bg-background/80 supports-[backdrop-filter]:bg-background/60 sticky top-0 z-40 border-b backdrop-blur">
      <div className="mx-auto flex h-14 max-w-6xl items-center gap-4 px-4">
        <Link
          href={`/${league.slug}`}
          className="flex items-center gap-2 font-bold tracking-tight"
        >
          <span className="bg-primary text-primary-foreground inline-flex size-7 items-center justify-center rounded-md text-xs">
            OB
          </span>
          <span className="hidden sm:inline">OBHL</span>
        </Link>
        {/*
          RE-MEASURED 2026-09-05 in Chromium at `Desktop Chrome` metrics, by
          summing the bar's visible children plus its gaps and padding against
          its own client width. The prediction in the comment below was right:
          there is not room for the account items beside the inline nav.

          Anonymous, the bar needs 697px and `md` gives it 768 — 71px of slack.
          The signed-in cluster is 325px against the anonymous 110px, so it wants
          215 more than that slack holds: 912 against 768. Dropping the badge
          does not rescue it either (832 against 768).

          So the account items do not try to fit there. Signed in, the inline nav
          starts at `lg` — 912 against 1024, 112px clear — and below that the
          links take the full-width row they already use on a phone. That is the
          same answer `manage-nav.tsx` reaches for the manager's ten links, for
          the same reason.

          Anonymous, both class strings are exactly what they were before this
          component learned who was viewing, so nothing an anonymous visitor
          sees moved at any width.
        */}
        <div className={user ? "hidden lg:block" : "hidden md:block"}>
          <NavLinks league={league.slug} />
        </div>
        {/*
          `min-w-0` so the cluster can give way, same as the manage header. The
          league switcher used to be the element that shrank here — pinned at
          its capped 11rem it left the bar 35px over its box just as the nav
          links appear at `md` (be1845f). With the league in the URL the
          switcher is gone; this link replaces it as the shrinking element and
          is strictly narrower, so it cannot recreate that overflow: `min-w-0`
          plus `truncate` drops its intrinsic contribution the same way, and its
          widest state (~5rem) is under the switcher's 5rem floor either way.
        */}
        <div className="ml-auto flex min-w-0 items-center gap-2">
          <AccountCluster
            signedIn={!!user}
            role={member ? user!.role : null}
            crossLink={
              member
                ? { href: `/${league.slug}/manage/dashboard`, label: "Manage" }
                : null
            }
          >
            <Link
              href="/"
              className="text-muted-foreground hover:text-foreground min-w-0 truncate text-sm whitespace-nowrap transition-colors"
            >
              All leagues
            </Link>
          </AccountCluster>
        </div>
      </div>
      <div
        className={
          user ? "border-t px-2 py-1 lg:hidden" : "border-t px-2 py-1 md:hidden"
        }
      >
        <NavLinks league={league.slug} />
      </div>
    </header>
  );
}
