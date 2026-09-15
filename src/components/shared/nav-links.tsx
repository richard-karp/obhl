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

// The slug arrives as a prop (a client component; the resolver is server-only), and active state is measured
// against `/<league>`, not `/`.
export function NavLinks({ league }: { league: string }) {
  const pathname = usePathname();
  const base = `/${league}`;

  return (
    // Named: the staff row is a second `navigation` landmark.
    <nav
      aria-label="League"
      className="flex items-center gap-1 overflow-x-auto"
    >
      {LINKS.map((link) => {
        const href = `${base}${link.path}`;
        // Exact match for home; a section stays lit on its detail pages, and the `/` guard stops
        // `/standings-archive` lighting up Standings.
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
