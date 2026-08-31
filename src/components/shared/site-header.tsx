import Link from "next/link";
import { NavLinks } from "./nav-links";
import { ThemeToggle } from "./theme-toggle";
import type { Tables } from "@/lib/db/helpers";

export function SiteHeader({ league }: { league: Tables<"leagues"> }) {
  return (
    <header className="bg-background/80 supports-[backdrop-filter]:bg-background/60 sticky top-0 z-40 border-b backdrop-blur">
      <div className="mx-auto flex h-14 max-w-6xl items-center gap-4 px-4">
        <Link
          href={`/${league.slug}`}
          className="flex items-center gap-2 font-bold tracking-tight"
        >
          <span className="bg-primary text-primary-foreground inline-flex size-7 items-center justify-center rounded-md text-xs">
            OB
          </span>
          <span className="hidden sm:inline">OBHL</span>
        </Link>
        <div className="hidden md:block">
          <NavLinks league={league.slug} />
        </div>
        {/*
          `min-w-0` so the cluster can give way, same as the manage header. The
          league switcher used to be the element that shrank here — pinned at
          its capped 11rem it left the bar 35px over its box just as the nav
          links appear at `md` (be1845f). With the league in the URL the
          switcher is gone; this link replaces it as the shrinking element and
          is strictly narrower, so it cannot recreate that overflow: `min-w-0`
          plus `truncate` drops its intrinsic contribution the same way, and its
          widest state (~5rem) is under the switcher's 5rem floor either way.
        */}
        <div className="ml-auto flex min-w-0 items-center gap-2">
          <Link
            href="/"
            className="text-muted-foreground hover:text-foreground min-w-0 truncate text-sm whitespace-nowrap transition-colors"
          >
            All leagues
          </Link>
          <ThemeToggle />
        </div>
      </div>
      <div className="border-t px-2 py-1 md:hidden">
        <NavLinks league={league.slug} />
      </div>
    </header>
  );
}
