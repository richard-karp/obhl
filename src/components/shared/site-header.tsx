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
          RE-MEASURED 2026-09-06 in Chromium at `Desktop Chrome` metrics, by
          summing the bar's children plus its gaps and padding against its own
          client width — the same method as the 2026-09-05 pass, re-run because
          the cluster's contents changed twice since: the password work added a
          "Password" link, and the chrome merge removed the "Manage" cross-link.
          The 2026-09-05 figures below are superseded, not adjusted.

                              cluster    bar with the nav inline, at md (768)
            anonymous           110px     697  — 71px of slack
            signed in, member   336px     923  — overflows by 155
            signed in, stranger 261px     848  — overflows by 80

          (Was 110 / 325 / 190 and 697 / 912 / 777. Anonymous is unchanged to the
          pixel, which is what says the method matched.)

          The conclusion is the one it always was, by a wider margin: the account
          items do not try to fit beside the inline nav. Signed in, the inline nav
          starts at `lg` — 923 against 1024, 101px clear — and below that the
          links take the full-width row they already use on a phone.

          ⚠️ THE SWITCH IS KEYED ON `user`, NOT ON `member`, AND THAT IS
          DELIBERATE. Two review passes read the `member`-gated cluster above and
          proposed keying it the same way. Measured: a signed-in visitor to a
          league they do NOT belong to still gets a sign-out button and a Password
          link, and at 848 against 768 they need the row too — by 80px now rather
          than the 9px that made this look marginal. Re-key on `member` and that
          viewer overflows.

          Anonymous, both class strings are exactly what they were before this
          component learned who was viewing, so nothing an anonymous visitor
          sees moved at any width.

          ⚠️ The staff row is NOT in this budget and does not belong in it: it is
          a sibling of `<header>`, not a child of this bar. It has its own 390px
          measurement — see `staff-links.tsx` and the 390px leg of the overflow
          test in `e2e/02-auth.spec.ts`.
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
