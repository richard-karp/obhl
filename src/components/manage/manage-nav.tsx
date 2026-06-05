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

const LINKS: Record<AppRole, { href: string; label: string }[]> = {
  league_manager: [
    { href: "/dashboard", label: "Dashboard" },
    { href: "/people", label: "People & Roles" },
    { href: "/seasons", label: "Seasons" },
    { href: "/rosters", label: "Rosters" },
    { href: "/schedule-builder", label: "Schedule" },
    { href: "/score", label: "Games" },
    { href: "/announcements", label: "Announcements" },
    { href: "/rules/edit", label: "Rules" },
    { href: "/import", label: "Import" },
  ],
  scorekeeper: [
    { href: "/dashboard", label: "Dashboard" },
    { href: "/score", label: "Score Games" },
  ],
  captain: [{ href: "/dashboard", label: "Dashboard" }],
};

const ROLE_LABEL: Record<AppRole, string> = {
  league_manager: "Manager",
  scorekeeper: "Scorekeeper",
  captain: "Captain",
};

function Links({ links }: { links: { href: string; label: string }[] }) {
  const pathname = usePathname();
  return (
    <>
      {links.map((l) => {
        const active = pathname === l.href || pathname.startsWith(l.href + "/");
        return (
          <Link
            key={l.href}
            href={l.href}
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
  const links = role
    ? LINKS[role]
    : [{ href: "/dashboard", label: "Dashboard" }];

  return (
    <header className="bg-background/80 supports-[backdrop-filter]:bg-background/60 sticky top-0 z-40 border-b backdrop-blur">
      <div className="mx-auto flex h-14 max-w-6xl items-center gap-4 px-4">
        <Link href="/dashboard" className="font-bold tracking-tight">
          OBHL <span className="text-muted-foreground font-normal">Manage</span>
        </Link>
        <nav className="hidden items-center gap-1 md:flex">
          <Links links={links} />
        </nav>
        <div className="ml-auto flex items-center gap-2">
          <LeagueSwitcher leagues={leagues} currentSlug={currentSlug} />
          {role ? (
            <Badge variant="secondary" className="hidden sm:inline-flex">
              {ROLE_LABEL[role]}
            </Badge>
          ) : null}
          <Link
            href="/"
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
      <div className="flex gap-1 overflow-x-auto border-t px-2 py-1 md:hidden">
        <Links links={links} />
      </div>
    </header>
  );
}
