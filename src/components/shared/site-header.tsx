import Link from "next/link";
import { NavLinks } from "./nav-links";
import { AccountCluster } from "./account-cluster";
import { getSessionUser } from "@/lib/auth/session";
import { isLeagueMember } from "@/lib/auth/membership";
import type { Tables } from "@/lib/db/helpers";

// A server component, so it asks who is viewing without prop-drilling or client bundle; an anonymous visitor
// costs one `getClaims()` that short-circuits.
export async function SiteHeader({ league }: { league: Tables<"leagues"> }) {
  const user = await getSessionUser();
  // Membership, not role: `user.role` is instance-wide, so a manager of another league would be shown this
  // league's role badge. Memoized, and only for a signed-in viewer.
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
          ⚠️ Keyed on `user`, not `member`: measured, any signed-in cluster overflows the inline nav at `md`, a
          non-member's by 80px, so signed in the inline nav starts at `lg`. The staff row is outside this budget.
        */}
        <div className={user ? "hidden lg:block" : "hidden md:block"}>
          <NavLinks league={league.slug} />
        </div>
        {/*
          `min-w-0` so the cluster can give way, with the truncating "All leagues" link as the shrinking element.
        */}
        <div className="ml-auto flex min-w-0 items-center gap-2">
          <AccountCluster
            user={user && { role: member ? user.role : null }}
            leagueSlug={league.slug}
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
