"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";

/** Paths relative to the league root — `""` is the league home itself. */
const LINKS = [
  { path: "", label: "Home" },
  { path: "/standings", label: "Standings" },
  { path: "/schedule", label: "Schedule" },
  { path: "/stats", label: "Stats" },
  { path: "/teams", label: "Teams" },
  { path: "/rules", label: "Rules" },
];

/**
 * The league slug has to arrive as a prop: this is a client component and the
 * resolver is server-only. It is also what active state is measured against —
 * the league home is `/harbor`, not `/`, and a bare `startsWith("/standings")`
 * matches nothing under `/harbor/standings`.
 */
export function NavLinks({ league }: { league: string }) {
  const pathname = usePathname();
  const base = `/${league}`;

  return (
    <nav className="flex items-center gap-1 overflow-x-auto">
      {LINKS.map((link) => {
        const href = `${base}${link.path}`;
        // Exact match for the home link; elsewhere the section stays lit on its
        // detail pages (`/harbor/teams/sharks`). The `/` guard is what stops a
        // hypothetical `/standings-archive` lighting up Standings.
        const active =
          link.path === ""
            ? pathname === base
            : pathname === href || pathname.startsWith(`${href}/`);
        return (
          <Link
            key={link.path}
            href={href}
            aria-current={active ? "page" : undefined}
            className={cn(
              "rounded-md px-3 py-1.5 text-sm font-medium whitespace-nowrap transition-colors",
              active
                ? "bg-secondary text-secondary-foreground"
                : "text-muted-foreground hover:text-foreground hover:bg-secondary/60",
            )}
          >
            {link.label}
          </Link>
        );
      })}
    </nav>
  );
}
