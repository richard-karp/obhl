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
 * The right-hand end of the header: who you are, the theme toggle, the way to
 * set a password, and sign-out.
 *
 * ONE component for both headers — the league header and the league picker —
 * because the thing that was broken is that they disagreed: a signed-in manager
 * on a public page saw the anonymous chrome, with no badge and no sign-out.
 * Copies would drift back into that state one edit at a time.
 *
 * ⚠️ THERE IS NO `crossLink` ANY MORE, and its absence is the change rather than
 * an oversight. It used to carry "Manage" from a public page and "View site"
 * from the manage chrome — one control for crossing between two halves of the
 * app. There are no halves: one header serves every page under `/<league>`, with
 * the staff row beneath it for anyone who belongs to the league, so there is
 * nowhere to cross TO. Re-adding it would recreate the mode this removed.
 *
 * No `"use client"` and no server-only imports, so it compiles into whichever
 * side imports it. Everything it needs arrives as serializable props; `signOut`
 * is a server action, which a client component may import and submit to.
 *
 * ⚠️ Element ORDER is load-bearing for the "signed out is unchanged" bar. With
 * no session this renders `children` and the toggle and nothing else, which is
 * byte-for-byte what the public header and the picker rendered before this
 * existed. Adding an unconditional element here breaks that for every anonymous
 * visitor at once.
 */
export function AccountCluster({
  /**
   * The viewer, or null for an anonymous one — in which case the whole account
   * half disappears.
   *
   * ONE prop rather than a `signedIn` boolean beside a `role`, because those two
   * made illegal states representable: `signedIn={false}` with a non-null role
   * rendered no badge and no error. `role` here is the role to SHOW, which is
   * not always the viewer's own — the league header passes null for a signed-in
   * visitor to a league they do not belong to.
   */
  user,
  /**
   * The league to land on after signing out, or undefined where there is none —
   * the league picker draws this cluster too, and has no league in its URL.
   *
   * ⚠️ It is a HINT, not an instruction. It rides to `signOut` as a hidden form
   * field, which puts it under the client's control, so the action resolves it
   * against the database and falls back to `/` rather than redirecting to
   * whatever was posted. See `signOut`.
   */
  leagueSlug,
  /**
   * Context-specific items that lead the cluster: "All leagues" on the league
   * header, nothing on the picker. They are NOT account state, which is why they
   * are a slot rather than more props.
   */
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
        // Hidden on the narrowest screens for the same reason the manage header
        // hides it there: it is the one element that says nothing a signed-in
        // viewer cannot infer from the sign-out button beside it.
        <Badge variant="secondary" className="hidden sm:inline-flex">
          {ROLE_LABEL[user.role]}
        </Badge>
      ) : null}
      {user ? (
        // ⛔ THE ONLY IN-APP ROUTE TO `/set-password`. The other one is on
        // `/login`, which a signed-in person never sees — so without this, the
        // bootstrap case (arrived by magic link, wants a password so the next
        // sign-in needs no email) has to type the URL. It also carries the
        // recovery case: if the emailed link ever lands someone on `/` instead
        // of the set-password page — which is what a redirect URL missing from
        // Supabase's allow-list does, silently — this is the difference between
        // finishing and a dead end.
        //
        // ⚠️ Inside the `user` branch, like everything else here: with no
        // session this component must still render `children` and the toggle and
        // nothing else, or the "signed out is unchanged" bar breaks for every
        // anonymous visitor. Hidden below `sm` for the same reason the badge is
        // — the header has an overflow test at `md`.
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
            ⚠️ INSIDE the `user` branch, with everything else. An unconditional
            element here — even a hidden input, which renders nothing — breaks
            the "signed out is byte-for-byte unchanged" bar this component is
            written to.
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
