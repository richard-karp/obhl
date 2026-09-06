"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";
import { LeagueSwitcher } from "@/components/shared/league-switcher";
import type { AppRole } from "@/lib/auth/session";
import type { LeagueOption } from "@/lib/league/current";

/**
 * The staff link row. Once half of a second header — `ManageNav`, a whole brand
 * bar with its own account cluster and league switcher — now only the content,
 * because there is one header for the whole site and this sits beneath it.
 */

/** Paths relative to `/<league>`. */
const LINKS: Record<AppRole, { path: string; label: string }[]> = {
  league_manager: [
    { path: "/dashboard", label: "Dashboard" },
    { path: "/people", label: "People & Roles" },
    { path: "/seasons", label: "Seasons" },
    { path: "/teams", label: "Teams" },
    { path: "/schedule-builder", label: "Schedule Builder" },
    { path: "/schedule", label: "Games" },
    { path: "/announcements", label: "Announcements" },
    { path: "/rules", label: "Rules" },
    { path: "/import", label: "Import" },
    { path: "/audit", label: "Audit Log" },
  ],
  scorekeeper: [
    { path: "/dashboard", label: "Dashboard" },
    { path: "/schedule", label: "Score Games" },
  ],
  captain: [{ path: "/dashboard", label: "Dashboard" }],
};

/**
 * ⚠️ WHERE `MAX_INLINE_LINKS = 5` WENT, and why nothing replaced it.
 *
 * It decided whether `ManageNav`'s links sat inline in that header's brand bar
 * or took a full-width row beneath it, and it was measured: capped at
 * `max-w-6xl` (1152px), the inline nav's share was what remained after the brand
 * and the account controls took ~594px — about 526px, five links of the
 * manager's average width. The manager's ten never fitted at any viewport, so
 * they always took the row.
 *
 * That bar is gone. This row is now the only shape the staff links have, at
 * every width, so there is no threshold left to cross and no number to keep
 * true. ⛔ Do not reintroduce an inline variant of these links without measuring
 * again: the number above described a bar that no longer exists, and the one bar
 * that does — `site-header.tsx`'s — carries its own measurement, which this row
 * sits BELOW and therefore does not disturb.
 */

type NavLink = { path: string; label: string; absolute?: boolean };

function Links({ links, base }: { links: NavLink[]; base: string }) {
  const pathname = usePathname();
  return (
    <>
      {links.map((l) => {
        // `absolute` is for links that belong to no league — today only the
        // League Office. Everything else is relative to `/<league>`.
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

/**
 * The staff link row — on EVERY page under `/<league>`, for anyone who belongs
 * to the league.
 *
 * ⛔ A ROW BENEATH THE ONE HEADER, NOT A SECOND HEADER. It began life as the
 * answer for three shared pages (`/rules`, `/teams/<slug>`, `/schedule` — one
 * URL each, serving the public and the people who run the league), where
 * swapping in the whole `ManageNav` was the obvious move and was wrong: its
 * "View site" link would have pointed at a page that drew `ManageNav` again.
 * `[league]/layout.tsx` now draws this for everything, which is that same answer
 * generalised — a staff page is a public page with more on it, and this is the
 * more. There is no mode to be in or out of, and nothing to toggle.
 *
 * ⚠️ `aria-label` IS LOAD-BEARING. This and `NavLinks` ("League") are two
 * `navigation` landmarks on every page now rather than on three, and two unnamed
 * ones are indistinguishable to a screen reader.
 *
 * ⚠️ The CALLER gates this on membership, never on `user.role` — the role is
 * instance-wide, so a manager of another league would otherwise be offered tools
 * that every page behind them refuses.
 */
export function StaffLinks({
  role,
  currentSlug,
  officeTier,
  leagues,
}: {
  role: AppRole | null;
  currentSlug: string;
  officeTier: string | null;
  /**
   * The leagues this account belongs to, for the switcher. It lived in
   * `ManageNav`'s brand bar until that header was deleted, and it is HERE rather
   * than in the one remaining bar for two reasons: the bar's overflow budget is
   * measured and full (`site-header.tsx`), and the switcher is a staff control —
   * putting it in `AccountCluster`'s `children` slot would render it for
   * anonymous visitors, since that slot is outside the `user` branch.
   */
  leagues: LeagueOption[];
}) {
  return (
    <div className="bg-muted/30 border-b">
      <div className="mx-auto flex max-w-6xl items-center gap-2 px-4 py-1">
        {/*
          `min-w-0` on the scroller so the switcher beside it keeps its width:
          without it this nav's automatic minimum is its content, and the select
          is what gets squeezed off the screen instead.
        */}
        <nav
          aria-label="Staff tools"
          className="flex min-w-0 gap-1 overflow-x-auto"
        >
          <Links links={staffLinks(role, officeTier)} base={`/${currentSlug}`} />
        </nav>
        {/*
          Outside the `nav`, so the "Staff tools" landmark stays a list of links.
          Renders nothing for an account with fewer than two leagues.

          Still lands on `/<slug>/dashboard` rather than the league home: it is a
          staff control, and the equivalent sub-path never survives the crossing
          — `/obhl/seasons/<uuid>` names a season that belongs to Oceanview.
        */}
        <LeagueSwitcher
          leagues={leagues}
          currentSlug={currentSlug}
          rootPath="/dashboard"
          className="ml-auto shrink-0"
        />
      </div>
    </div>
  );
}

/**
 * The links a role gets, plus the League Office when a tier says so.
 *
 * A null role still gets the Dashboard: that is the one page that explains to an
 * account with no role yet why nothing else works, and it is reachable from
 * nowhere else.
 */
function staffLinks(
  role: AppRole | null,
  officeTier: string | null,
): NavLink[] {
  return [
    ...(role ? LINKS[role] : [{ path: "/dashboard", label: "Dashboard" }]),
    // Without this the page is reachable only by typing the URL. It is not in
    // `LINKS` because that map is keyed on role and its paths are
    // league-relative, and the office is neither.
    ...(officeTier
      ? [{ path: "/manage/office", label: "League Office", absolute: true }]
      : []),
  ];
}
