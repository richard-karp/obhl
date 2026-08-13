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
    // `min-w-0` so this can give way. As a flex item its automatic minimum
    // size is the select's width, which the cap below pins at 11rem — on a
    // phone that rigid 176px is what pushed the header past the screen and put
    // the whole page into horizontal scrolling.
    <form action={selectLeague} className={cn("flex min-w-0 items-center", className)}>
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
        // Shrinks between the two bounds and ellipsises what doesn't fit, so a
        // long league name costs width only when there is width to spare. The
        // 5rem floor keeps it a usable target once it has given all it can.
        className="border-input bg-background hover:bg-secondary/60 h-8 max-w-[11rem] min-w-[5rem] truncate rounded-md border px-2 text-sm font-medium transition-colors disabled:opacity-60"
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
