"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";
import { ThemeToggle } from "@/components/shared/theme-toggle";
import { LeagueSwitcher } from "@/components/shared/league-switcher";
import { signOut } from "@/lib/actions/auth";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import type { AppRole } from "@/lib/auth/session";
import type { LeagueOption } from "@/lib/league/current";

/** Paths relative to `/<league>/manage`. */
const LINKS: Record<AppRole, { path: string; label: string }[]> = {
  league_manager: [
    { path: "/dashboard", label: "Dashboard" },
    { path: "/people", label: "People & Roles" },
    { path: "/seasons", label: "Seasons" },
    { path: "/rosters", label: "Rosters" },
    { path: "/schedule-builder", label: "Schedule" },
    { path: "/score", label: "Games" },
    { path: "/announcements", label: "Announcements" },
    { path: "/rules/edit", label: "Rules" },
    { path: "/import", label: "Import" },
    { path: "/audit", label: "Audit Log" },
  ],
  scorekeeper: [
    { path: "/dashboard", label: "Dashboard" },
    { path: "/score", label: "Score Games" },
  ],
  captain: [{ path: "/dashboard", label: "Dashboard" }],
};

/**
 * How many links the brand bar can hold inline before they get a row to
 * themselves.
 *
 * Measured at the widest the bar ever gets. Capped at `max-w-6xl` (1152px), the
 * inline nav's share is what is left after the brand and the account controls
 * take ~594px — about 526px, which holds five links of the manager's average
 * width. A narrower window leaves less, and what gives way there is the league
 * switcher, which shrinks; that is what keeps a short set intact down to `md`.
 *
 * Widening the window does not rescue a long set. The container is capped, so
 * ten links overflow it at every viewport — on a wide screen the centred
 * container's slack merely hides the fact. They get their own row instead.
 *
 * Deliberately no scroller on the inline nav. `overflow-x-auto` on a flex item
 * drops its automatic minimum size to zero, so the nav starts giving way
 * instead of the league switcher: with one, the scorekeeper's two links lose
 * 47px of "Score Games" at 768px. This threshold is the mechanism, and there is
 * no fallback behind it — a link set added past it needs re-measuring here.
 */
const MAX_INLINE_LINKS = 5;

const ROLE_LABEL: Record<AppRole, string> = {
  league_manager: "Manager",
  scorekeeper: "Scorekeeper",
  captain: "Captain",
};

function Links({
  links,
  base,
}: {
  links: { path: string; label: string }[];
  base: string;
}) {
  const pathname = usePathname();
  return (
    <>
      {links.map((l) => {
        const href = `${base}${l.path}`;
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

export function ManageNav({
  role,
  leagues,
  currentSlug,
}: {
  role: AppRole | null;
  leagues: LeagueOption[];
  currentSlug: string;
}) {
  const base = `/${currentSlug}/manage`;
  const links = role
    ? LINKS[role]
    : [{ path: "/dashboard", label: "Dashboard" }];

  // The manager's ten links cannot sit beside the account controls at any
  // window size, so they get the full-width row to themselves — the same row
  // every role already uses on small screens. Short link sets keep the inline
  // nav and only drop to the row below `md`.
  const linksNeedOwnRow = links.length > MAX_INLINE_LINKS;

  return (
    <header className="bg-background/80 supports-[backdrop-filter]:bg-background/60 sticky top-0 z-40 border-b backdrop-blur">
      <div className="mx-auto flex h-14 max-w-6xl items-center gap-4 px-4">
        {/*
          Deliberately allowed to wrap. On a narrow phone "OBHL Manage" breaking
          across two lines is what keeps the account controls inside the screen;
          pinning it to one line costs ~47px and pushes them back out.
        */}
        <Link href={`${base}/dashboard`} className="font-bold tracking-tight">
          OBHL <span className="text-muted-foreground font-normal">Manage</span>
        </Link>
        {linksNeedOwnRow ? null : (
          <nav className="hidden items-center gap-1 md:flex">
            <Links links={links} base={base} />
          </nav>
        )}
        {/*
          `min-w-0` is what lets this cluster give way on a phone. Without it
          its automatic minimum is its min-content width — and the league
          select contributes its full capped 11rem there, because a max-width
          clamps an intrinsic contribution but a min-width does not lower it.
          That pinned the cluster at 296px and pushed the page sideways below
          390px. The toggle and sign-out are `shrink-0`, so the squeeze lands
          on the select, which has its own floor.
        */}
        <div className="ml-auto flex min-w-0 items-center gap-2">
          <LeagueSwitcher
            leagues={leagues}
            currentSlug={currentSlug}
            rootPath="/manage/dashboard"
          />
          {role ? (
            <Badge variant="secondary" className="hidden sm:inline-flex">
              {ROLE_LABEL[role]}
            </Badge>
          ) : null}
          <Link
            href={`/${currentSlug}`}
            className="text-muted-foreground hidden text-sm hover:underline sm:inline"
          >
            View site
          </Link>
          <ThemeToggle />
          <form action={signOut}>
            <Button type="submit" variant="ghost" size="sm">
              Sign out
            </Button>
          </form>
        </div>
      </div>
      {/*
        The link row. Always present below `md`; for a long link set it is the
        only nav at every size. Padded like the page's `main` so the links line
        up with the content beneath them, and it still scrolls on a screen too
        narrow to hold them.
      */}
      <div className={cn("border-t", !linksNeedOwnRow && "md:hidden")}>
        {/*
          A `nav`, not a `div`. For a long link set this is the only navigation
          on the page, so as a plain div it left managers with no navigation
          landmark at all. Both this and the inline nav can sit in the markup
          together because they are mutually exclusive in CSS, and a
          `display: none` element is not in the accessibility tree — exactly one
          landmark is ever exposed.
        */}
        <nav className="mx-auto flex max-w-6xl gap-1 overflow-x-auto px-4 py-1">
          <Links links={links} base={base} />
        </nav>
      </div>
    </header>
  );
}
