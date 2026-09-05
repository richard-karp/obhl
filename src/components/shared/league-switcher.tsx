"use client";

import { useRouter } from "next/navigation";
import { useTransition } from "react";
import type { LeagueOption } from "@/lib/league/current";
import { cn } from "@/lib/utils";

/**
 * League picker. The league lives in the URL, so switching is navigation — it
 * used to write a cookie, which nothing reads any more.
 *
 * A switch always lands on the chosen league's root (`rootPath`), never the
 * equivalent sub-path: `/harbor/seasons/<uuid>` names a season that
 * belongs to Harbor, so carrying that path across to Oceanview would only 404.
 *
 * Renders nothing when there's only one league. Requires JS: a bare select
 * wouldn't navigate on its own.
 */
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
    // `min-w-0` so this can give way. As a flex item its automatic minimum
    // size is the select's width, which the cap below pins at 11rem — on a
    // phone that rigid 176px is what pushed the header past the screen and put
    // the whole page into horizontal scrolling.
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
    </div>
  );
}
