import type { Metadata } from "next";
import Link from "next/link";
import { createClient } from "@/utils/supabase/server";
import { getPublicLeagues } from "@/lib/league/current";
import { EmptyState } from "@/components/shared/empty-state";
import { AccountCluster } from "@/components/shared/account-cluster";
import { ScorekeeperChrome } from "@/components/shared/scorekeeper-chrome";
import { Badge } from "@/components/ui/badge";
import { getSessionUser } from "@/lib/auth/session";
import { getMemberLeagues } from "@/lib/auth/membership";

// Overridden per deployment, on the next deploy. `||`, not `??`: an env var set to "" is the usual
// misconfiguration, and blank wording is worse than the default.
const TITLE = process.env.NEXT_PUBLIC_SITE_TITLE || "Choose your league";
const SUBTITLE =
  process.env.NEXT_PUBLIC_SITE_SUBTITLE ||
  "Standings, schedules, stats, teams, and rules.";

// `absolute` so the tab matches the heading rather than picking up the root
// layout's "%s · OBHL" template, which would read oddly against a custom title.
export const metadata: Metadata = { title: { absolute: TITLE } };

export default async function LandingPage() {
  const supabase = await createClient();
  const publicLeagues = await getPublicLeagues(supabase);

  const user = await getSessionUser();

  // ⛔ A member's leagues are listed too: `getPublicLeagues` omits a staged league, and nothing else
  // here links to one (`LeagueSwitcher` renders null below two leagues).
  const mine = user ? await getMemberLeagues(user.id) : [];

  // ⛔ Staged is `is_public` on the row, never "absent from `publicLeagues`": a failed read returns
  // `[]` and badges every league "Not yet public". The slug set only deduplicates.
  const publicSlugs = new Set(publicLeagues.map((l) => l.slug));
  // ⚠️ Published first, then the member's own, on purpose: never interleave the sections by age.
  const leagues = [
    ...publicLeagues.map((l) => ({ ...l, staged: false })),
    ...mine
      .filter((l) => !publicSlugs.has(l.slug))
      .map(({ is_public, ...l }) => ({ ...l, staged: !is_public })),
  ];

  // ⛔ A scorekeeper gets the minimal chrome here too: the account is shared, so `AccountCluster`'s
  // Password link changes everyone's password. Every guard refuses to `/`, so they land here often.
  const cluster =
    user?.role === "scorekeeper" ? (
      <ScorekeeperChrome role={user.role} showTonight />
    ) : (
      <AccountCluster user={user && { role: user.role }} />
    );

  // ⛔ Role only, with no membership check, matching `requireManager()` behind the link: the only way
  // in for a manager with no league, since the staff row is drawn for members only.
  const canCreateLeague = user?.role === "league_manager";
  const newLeagueLink = (
    <Link
      href="/manage/leagues/new"
      className="hover:bg-secondary/60 text-muted-foreground hover:text-foreground rounded-md border px-3 py-1.5 text-sm font-medium whitespace-nowrap transition-colors"
    >
      New league
    </Link>
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
          Signed out, the wrapper is skipped: the cluster is only the theme toggle, and the
          `justify-between` parent would otherwise spread the controls across the full width.
        */}
        {user ? (
          <div className="flex items-center gap-2">
            {/*
              ⚠️ `leagues.length > 0` is not redundant: it stops this and the empty state's own copy of
              the link rendering together on a league-less instance.
            */}
            {canCreateLeague && leagues.length > 0 ? newLeagueLink : null}
            {cluster}
          </div>
        ) : (
          cluster
        )}
      </div>

      {leagues.length === 0 ? (
        // ⛔ A manager needs the link here, or a fresh instance has no way to create its first league.
        // Beside `EmptyState`, not inside: it has no children slot.
        <div className="space-y-4">
          <EmptyState
            title="No leagues yet"
            description="Once a league is published it will appear here."
          />
          {canCreateLeague ? (
            <div className="flex justify-center">{newLeagueLink}</div>
          ) : null}
        </div>
      ) : (
        <ul className="space-y-3">
          {leagues.map((l) => (
            <li key={l.slug}>
              <Link
                href={`/${l.slug}`}
                className="hover:border-primary hover:bg-muted/40 flex items-center justify-between gap-3 rounded-lg border px-4 py-3 font-medium transition-colors"
              >
                {l.name}
                {/*
                  ⚠️ The badge is the point of listing staged leagues: without it a manager cannot tell
                  which of their leagues the public can already see.
                */}
                {l.staged ? (
                  <Badge variant="secondary" className="shrink-0 font-normal">
                    Not yet public
                  </Badge>
                ) : null}
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
