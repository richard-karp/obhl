"use client";

// ⛔ `"use client"` stays the first line: a directive prologue may be preceded only by comments.

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";
import { LeagueSwitcher } from "@/components/shared/league-switcher";
import type { AppRole } from "@/lib/auth/session";
import type { LeagueOption } from "@/lib/league/current";

/** Paths relative to `/<league>`. */
const LINKS: Record<AppRole, { path: string; label: string }[]> = {
  league_manager: [
    { path: "/dashboard", label: "Dashboard" },
    { path: "/people", label: "People & Roles" },
    // ⛔ No "/schedule-builder": building a schedule is reached from a season's setup page.
    { path: "/seasons", label: "Seasons" },
    // ⛔ No "/teams", "/schedule" or "/rules": `NavLinks` names those URLs, and a different label still leads to
    // the same page. The page guards are pinned by `PAGE_REFUSALS` (`e2e/09-access.spec.ts`, Path 17).
    { path: "/announcements", label: "Announcements" },
    // ⛔ No "/import": it creates a league, so it is the absolute "New league" link in `staffLinks()`.
    { path: "/audit", label: "Audit Log" },
  ],
  // ⛔ Empty, and the row is never drawn for a scorekeeper (`ScorekeeperChrome` replaces it). The key stays
  // because the type is `Record<AppRole, ...>`.
  scorekeeper: [],
  captain: [{ path: "/dashboard", label: "Dashboard" }],
};

// ⛔ No inline variant of these links without measuring again: this row sits below `site-header.tsx`'s
// measured bar, outside its budget.

type NavLink = { path: string; label: string; absolute?: boolean };

function Links({ links, base }: { links: NavLink[]; base: string }) {
  const pathname = usePathname();
  return (
    <>
      {links.map((l) => {
        // `absolute` is for links that belong to no league — the League Office,
        // and creating a league. Everything else is relative to `/<league>`.
        const href = l.absolute ? l.path : `${base}${l.path}`;
        const active = pathname === href || pathname.startsWith(href + "/");
        return (
          <Link
            key={l.path}
            href={href}
            aria-current={active ? "page" : undefined}
            className={cn(
              "rounded-md px-3 py-1.5 text-sm font-medium whitespace-nowrap transition-colors",
              active
                ? "bg-secondary text-secondary-foreground"
                : "text-muted-foreground hover:text-foreground hover:bg-secondary/60",
            )}
          >
            {l.label}
          </Link>
        );
      })}
    </>
  );
}

// ⛔ A row beneath the one header, not a second header; the caller gates it on membership, never `user.role`.
// ⚠️ It does not stick: `sticky top-14` was measured and slides under the taller header below `lg`.
export function StaffLinks({
  role,
  currentSlug,
  officeTier,
  leagues,
}: {
  role: AppRole | null;
  currentSlug: string;
  officeTier: string | null;
  // For the switcher, here and not in the header: that bar's budget is full, and `AccountCluster`'s `children`
  // slot would render it for anonymous visitors.
  leagues: LeagueOption[];
}) {
  return (
    <div className="bg-muted/30 border-b">
      <div className="mx-auto flex max-w-6xl items-center gap-2 px-4 py-1">
        {/*
          ⛔ `flex-1`, not only `min-w-0`, which let the switcher's floor push the page past a 390px screen.
          ⚠️ `aria-label` is load-bearing: two unnamed `navigation` landmarks are indistinguishable.
        */}
        <nav
          aria-label="Staff tools"
          className="flex min-w-0 flex-1 gap-1 overflow-x-auto"
        >
          <Links
            links={staffLinks(role, officeTier)}
            base={`/${currentSlug}`}
          />
        </nav>
        {/*
          Outside the `nav`, landing on `/dashboard`: a sub-path never survives the crossing. ⛔ No `className`
          overrides: its own `min-w-0` lets it give way, and pinned it pushed the page into horizontal scroll.
        */}
        <LeagueSwitcher
          leagues={leagues}
          currentSlug={currentSlug}
          rootPath="/dashboard"
        />
      </div>
    </div>
  );
}

/** A null role still gets the Dashboard: the one page telling a roleless account why nothing else works. */
function staffLinks(
  role: AppRole | null,
  officeTier: string | null,
): NavLink[] {
  return [
    ...(role ? LINKS[role] : [{ path: "/dashboard", label: "Dashboard" }]),
    // ⚠️ Gated on the role, not a tier, matching `requireManager()`. A manager in no league never sees this
    // row, so the root page's own link is not redundant.
    ...(role === "league_manager"
      ? [{ path: "/manage/leagues/new", label: "New league", absolute: true }]
      : []),
    // Not in `LINKS`: that map is role-keyed and league-relative, and the office is neither.
    ...(officeTier
      ? [{ path: "/manage/office", label: "League Office", absolute: true }]
      : []),
  ];
}
