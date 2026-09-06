import type { Metadata } from "next";
import Link from "next/link";
import { createClient } from "@/utils/supabase/server";
import { getPublicLeagues } from "@/lib/league/current";
import { EmptyState } from "@/components/shared/empty-state";
import { AccountCluster } from "@/components/shared/account-cluster";
import { getSessionUser } from "@/lib/auth/session";

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
  // about having signed in — no badge, no way out. It has no league in the URL,
  // so the account state is the instance-wide one.
  const user = await getSessionUser();

  // ⚠️ NO "Manage" CROSS-LINK ANY MORE. It used to point at
  // `/<oldest league this account can reach>/dashboard`, which was the one route
  // from here into the staff tools. There are no separate staff tools to route
  // to: a staff member opens their league like anybody else and the staff row
  // beneath the header carries everything they can do. The list below is the
  // route, for them as for everyone.
  //
  // ⚠️ KNOWN CONSEQUENCE, left as the design implies rather than papered over:
  // the list is PUBLIC leagues, so a league still being staged does not appear
  // on it for the manager staging it. They reach it by its URL, which is what
  // they were doing before the cross-link happened to point at the oldest league
  // instead.
  const cluster = <AccountCluster user={user && { role: user.role }} />;

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
