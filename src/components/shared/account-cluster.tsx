import Link from "next/link";
import { ThemeToggle } from "./theme-toggle";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { signOut } from "@/lib/actions/auth";
import type { AppRole } from "@/lib/auth/session";

const ROLE_LABEL: Record<AppRole, string> = {
  league_manager: "Manager",
  scorekeeper: "Scorekeeper",
  captain: "Captain",
};

/**
 * The right-hand end of every header: who you are, the way to the other half of
 * the app, the theme toggle, and sign-out.
 *
 * ONE component for all three headers — the public league header, the manage
 * header and the league picker — because the thing that was broken is that they
 * disagreed: a signed-in manager on a public page saw the anonymous chrome, with
 * no badge and no route back to their tools. Three copies would drift back into
 * that state one edit at a time.
 *
 * No `"use client"` and no server-only imports, so it compiles into whichever
 * side imports it: a server component in `SiteHeader`, part of the client bundle
 * in `ManageNav`. Everything it needs arrives as serializable props; `signOut` is
 * a server action, which a client component may import and submit to.
 *
 * ⚠️ Element ORDER is load-bearing for the "signed out is unchanged" bar. With
 * no session this renders `children` and the toggle and nothing else, which is
 * byte-for-byte what the public header and the picker rendered before this
 * existed. Adding an unconditional element here breaks that for every anonymous
 * visitor at once.
 */
export function AccountCluster({
  /** Null for an anonymous viewer: the whole account half then disappears. */
  role,
  signedIn,
  /**
   * Where this viewer's *other* half of the app is: their tools from a public
   * page, the public site from the manage chrome. Null when there is nowhere
   * meaningful to point — a signed-in visitor to a league they do not belong to,
   * or anyone with no membership at all.
   *
   * It is the CALLER's job to decide where it goes, and the callers differ: a
   * league page points at that league, while the picker has no league in its URL
   * and picks the first one this account can reach. See `app/page.tsx`.
   */
  crossLink,
  /**
   * Context-specific items that lead the cluster: "All leagues" on the public
   * header, the league switcher on the manage one. They are NOT account state,
   * which is why they are a slot rather than more props.
   */
  children,
}: {
  role: AppRole | null;
  signedIn: boolean;
  crossLink?: { href: string; label: string } | null;
  children?: React.ReactNode;
}) {
  return (
    <>
      {children}
      {signedIn && role ? (
        // Hidden on the narrowest screens for the same reason the manage header
        // hides it there: it is the one element that says nothing a signed-in
        // viewer cannot infer from the sign-out button beside it.
        <Badge variant="secondary" className="hidden sm:inline-flex">
          {ROLE_LABEL[role]}
        </Badge>
      ) : null}
      {signedIn && crossLink ? (
        <Link
          href={crossLink.href}
          className="text-muted-foreground hidden text-sm hover:underline sm:inline"
        >
          {crossLink.label}
        </Link>
      ) : null}
      <ThemeToggle />
      {signedIn ? (
        <form action={signOut}>
          <Button type="submit" variant="ghost" size="sm">
            Sign out
          </Button>
        </form>
      ) : null}
    </>
  );
}
