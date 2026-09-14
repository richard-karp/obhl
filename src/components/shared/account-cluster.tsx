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

// One component for both headers, so they cannot disagree. ⚠️ No `crossLink`: there are no halves to cross.
// ⚠️ Signed out it renders `children` and the toggle and nothing else; an unconditional element breaks that.
export function AccountCluster({
  // One prop, not `signedIn` beside `role`, which allowed illegal states. `role` is the one to show: null
  // for a visitor to a league they don't belong to.
  user,
  /** ⚠️ A hint, not an instruction: a client-controlled field that `signOut` resolves, falling back to `/`. */
  leagueSlug,
  /** Context items that lead the cluster, such as "All leagues"; not account state, so a slot. */
  children,
}: {
  user: { role: AppRole | null } | null;
  leagueSlug?: string;
  children?: React.ReactNode;
}) {
  return (
    <>
      {children}
      {user?.role ? (
        // Hidden on the narrowest screens: the sign-out button beside it already says the viewer is signed in.
        <Badge variant="secondary" className="hidden sm:inline-flex">
          {ROLE_LABEL[user.role]}
        </Badge>
      ) : null}
      {user ? (
        // ⛔ The only in-app route to `/set-password` for a signed-in person, and the way out if a reset link
        // lands on `/`. ⚠️ Inside the `user` branch, and hidden below `sm` like the badge.
        <Link
          href="/set-password"
          className="text-muted-foreground hidden text-sm hover:underline sm:inline"
        >
          Password
        </Link>
      ) : null}
      <ThemeToggle />
      {user ? (
        <form action={signOut}>
          {/*
            ⚠️ Inside the `user` branch: even an unconditional hidden input would change the signed-out markup.
          */}
          {leagueSlug ? (
            <input type="hidden" name="league" value={leagueSlug} />
          ) : null}
          <Button type="submit" variant="ghost" size="sm">
            Sign out
          </Button>
        </form>
      ) : null}
    </>
  );
}
