import type { Metadata } from "next";
import Link from "next/link";
import { createClient } from "@/utils/supabase/server";
import { getPublicLeagues } from "@/lib/league/current";
import { EmptyState } from "@/components/shared/empty-state";
import { AccountCluster } from "@/components/shared/account-cluster";
import { getSessionUser } from "@/lib/auth/session";
import { getMemberLeagues } from "@/lib/auth/membership";

/**
 * Wording for the one page that belongs to no league, and so has no league name
 * to borrow. Override per deployment with NEXT_PUBLIC_SITE_TITLE and
 * NEXT_PUBLIC_SITE_SUBTITLE; both take effect on the next deploy.
 *
 * `||` rather than `??` on purpose — an env var set to an empty string is the
 * usual way this gets misconfigured, and blank wording is worse than the
 * default.
 */
const TITLE = process.env.NEXT_PUBLIC_SITE_TITLE || "Choose your league";
const SUBTITLE =
  process.env.NEXT_PUBLIC_SITE_SUBTITLE ||
  "Standings, schedules, stats, teams, and rules.";

// `absolute` so the tab matches the heading rather than picking up the root
// layout's "%s · OBHL" template, which would read oddly against a custom title.
export const metadata: Metadata = { title: { absolute: TITLE } };

/**
 * Root landing page: the one place that isn't league-scoped. Every league lives
 * at `/<slug>` from here on, so this is what a bare domain, a role-denied
 * redirect, and a completed sign-in all land on.
 */
export default async function LandingPage() {
  const supabase = await createClient();
  const leagues = await getPublicLeagues(supabase);

  // This page is where a completed sign-in lands, and until now it said nothing
  // about having signed in — no badge, no way on to the tools, no way out. It
  // has no league in the URL, so the account state is the instance-wide one.
  const user = await getSessionUser();
  // A cross-link needs a league, and this page is the one place that has none.
  // The destination is the OLDEST LEAGUE THIS ACCOUNT CAN REACH — not their
  // oldest membership: `getMemberLeagues` orders leagues by `leagues.created_at`,
  // and for a League Office member it returns every league in the instance, so a
  // commissioner lands on the oldest league there is rather than on anything
  // they belong to. That is stable rather than arbitrary, and it is still the
  // right link for someone with several, because the manage header it lands on
  // carries the league switcher. A dead end here is what sent a signed-in
  // manager back to typing URLs.
  const mine = user ? await getMemberLeagues(user.id) : [];

  const cluster = (
    <AccountCluster
      user={user && { role: user.role }}
      crossLink={
        mine.length > 0
          ? { href: `/${mine[0].slug}/dashboard`, label: "Manage" }
          : null
      }
    />
  );

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-1 flex-col px-4 py-10">
      <div className="mb-10 flex items-start justify-between gap-4">
        <div className="space-y-2">
          <h1 className="text-3xl font-bold tracking-tight sm:text-4xl">
            {TITLE}
          </h1>
          <p className="text-muted-foreground">{SUBTITLE}</p>
        </div>
        {/*
          Signed in the cluster is several controls and needs a row of its own;
          signed out it is the theme toggle and nothing else, and the wrapper is
          skipped so this page's anonymous markup is byte-for-byte what it was —
          the parent is `justify-between`, which would otherwise spread the
          controls across the full width.
        */}
        {user ? (
          <div className="flex items-center gap-2">{cluster}</div>
        ) : (
          cluster
        )}
      </div>

      {leagues.length === 0 ? (
        // A freshly bootstrapped database renders this: the site is up before
        // any league exists.
        <EmptyState
          title="No leagues yet"
          description="Once a league is published it will appear here."
        />
      ) : (
        <ul className="space-y-3">
          {leagues.map((l) => (
            <li key={l.slug}>
              <Link
                href={`/${l.slug}`}
                className="hover:border-primary hover:bg-muted/40 block rounded-lg border px-4 py-3 font-medium transition-colors"
              >
                {l.name}
              </Link>
            </li>
          ))}
        </ul>
      )}

      <footer className="text-muted-foreground mt-auto pt-10 text-sm">
        <Link href="/login" className="hover:text-foreground transition-colors">
          Staff sign in
        </Link>
      </footer>
    </div>
  );
}
