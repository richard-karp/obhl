"use client";

import { useTransition } from "react";
import { selectLeague } from "@/lib/actions/league";
import type { LeagueOption } from "@/lib/league/current";
import { cn } from "@/lib/utils";

/**
 * Header league picker. Cookie-backed (see lib/actions/league.ts); changing it
 * re-renders the whole app for the chosen league. Renders nothing when there's
 * only one league. Requires JS: changing the select calls the server action via
 * a transition (a bare select wouldn't submit the form on its own).
 */
export function LeagueSwitcher({
  leagues,
  currentSlug,
  className,
}: {
  leagues: LeagueOption[];
  currentSlug: string;
  className?: string;
}) {
  const [pending, startTransition] = useTransition();
  if (leagues.length < 2) return null;

  return (
    <form action={selectLeague} className={cn("flex items-center", className)}>
      <label className="sr-only" htmlFor="league-switcher">
        Select league
      </label>
      <select
        id="league-switcher"
        name="slug"
        defaultValue={currentSlug}
        disabled={pending}
        aria-label="Select league"
        onChange={(e) =>
          startTransition(() => {
            const fd = new FormData();
            fd.set("slug", e.currentTarget.value);
            selectLeague(fd);
          })
        }
        className="border-input bg-background hover:bg-secondary/60 h-8 max-w-[11rem] truncate rounded-md border px-2 text-sm font-medium transition-colors disabled:opacity-60"
      >
        {leagues.map((l) => (
          <option key={l.slug} value={l.slug}>
            {l.name}
          </option>
        ))}
      </select>
    </form>
  );
}
