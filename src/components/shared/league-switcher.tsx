"use client";

import { useRouter } from "next/navigation";
import { useTransition } from "react";
import type { LeagueOption } from "@/lib/league/current";
import { cn } from "@/lib/utils";

// Switching is navigation, always to the chosen league's `rootPath`: a sub-path names the old league's rows and
// would 404. Requires JS, since a bare select wouldn't navigate.
export function LeagueSwitcher({
  leagues,
  currentSlug,
  rootPath = "",
  className,
}: {
  leagues: LeagueOption[];
  currentSlug: string;
  /** Appended to `/<slug>` — e.g. `/dashboard` for the staff tools. */
  rootPath?: string;
  className?: string;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  if (leagues.length < 2) return null;

  return (
    // `min-w-0` so this can give way: its automatic minimum is the select's 11rem, which pushed a phone's
    // header past the screen.
    <div className={cn("flex min-w-0 items-center", className)}>
      <label className="sr-only" htmlFor="league-switcher">
        Select league
      </label>
      <select
        id="league-switcher"
        name="slug"
        defaultValue={currentSlug}
        disabled={pending}
        aria-label="Select league"
        onChange={(e) => {
          const slug = e.currentTarget.value;
          startTransition(() => router.push(`/${slug}${rootPath}`));
        }}
        // Shrinks between two bounds and ellipsises; the 5rem floor keeps it a usable target.
        className="border-input bg-background hover:bg-secondary/60 h-8 max-w-[11rem] min-w-[5rem] truncate rounded-md border px-2 text-sm font-medium transition-colors disabled:opacity-60"
      >
        {leagues.map((l) => (
          <option key={l.slug} value={l.slug}>
            {l.name}
          </option>
        ))}
      </select>
    </div>
  );
}
