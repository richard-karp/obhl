import Link from "next/link";
import { cn } from "@/lib/utils";

/**
 * The schedule page's three views: what still needs a score, what is coming,
 * and what has been played.
 *
 * ⛔ REAL LINKS ON `?view=`, NOT `components/ui/tabs.tsx`. This repo has tried
 * Radix `<Tabs>` over URL-conditional server content once and reverted it:
 * `team-tabs.tsx` lived from `3e692fa` to `9731234` and its docblock enumerates
 * three failures, every one of them a blank content area — BACK returning a
 * payload the retained tab state disagreed with, arrow-keys setting the value
 * on focus without navigating, and `activationMode="manual"` activating without
 * following the link. `9731234`'s message calls the removal "the two blank-panel
 * bugs the tab caused are gone by construction, along with the client component
 * that existed only to keep the tab and the URL from disagreeing."
 *
 * That case was route tabs and these are one route, so the precedent does not
 * bind — but the URL form wins on its own merits anyway: "here are the results"
 * becomes a shareable link, the page stays a Server Component with no client
 * bundle, and a test can go straight to a view instead of clicking into it.
 *
 * ⛔ `query` IS THE WHOLE OF THE CURRENT SEARCH STRING MINUS `view`, not a
 * rebuilt one. `?team=` narrows the list and the export buttons; dropping it on
 * a view switch would silently widen a filtered page, which is the bug
 * `01-public.spec.ts` documents for the download links.
 */

export const SCHEDULE_VIEWS = ["to-score", "upcoming", "results"] as const;
export type ScheduleView = (typeof SCHEDULE_VIEWS)[number];

/** An unknown or absent `?view=` reads as Upcoming rather than 404ing. */
export function resolveScheduleView(raw: string | string[] | undefined) {
  const v = Array.isArray(raw) ? raw[0] : raw;
  return (SCHEDULE_VIEWS as readonly string[]).includes(v ?? "")
    ? (v as ScheduleView)
    : "upcoming";
}

export function ScheduleViews({
  league,
  current,
  awaitingCount,
  query,
}: {
  league: string;
  current: ScheduleView;
  /**
   * How many games are played and unscored. The To score view is offered only
   * when there are some — the same condition its section had when it was a
   * section — and the number rides on the label.
   *
   * ⚠️ THE COUNT IS NOT DECORATION. That list used to sit ABOVE Upcoming on a
   * single page, deliberately: `30-schedule-edits.spec.ts` records that "a
   * section below the fold is how these games got forgotten in the first
   * place", and a view is further away than below the fold. The default stays
   * Upcoming because a scorekeeper's games are always tonight's and so always
   * live there — landing them on a list of older nights would offer a page of
   * rows their own day guard refuses. So the count is what carries the urgency
   * now, and it should not be quietly dropped as clutter.
   */
  awaitingCount: number;
  /** The rest of the query string (`team`, `season`, …), already encoded. */
  query: string;
}) {
  const href = (view: ScheduleView) => {
    const params = new URLSearchParams(query);
    // Upcoming is the default, so it gets the bare URL — the link people copy
    // out of the address bar should not carry a parameter that changes nothing.
    if (view === "upcoming") params.delete("view");
    else params.set("view", view);
    const q = params.toString();
    return `/${league}/schedule${q ? `?${q}` : ""}`;
  };

  const tabs: { view: ScheduleView; label: string }[] = [
    ...(awaitingCount > 0
      ? [{ view: "to-score" as const, label: `To score (${awaitingCount})` }]
      : []),
    { view: "upcoming", label: "Upcoming" },
    { view: "results", label: "Results" },
  ];

  return (
    // ⚠️ NAMED, because this page now has three `navigation` landmarks and two
    // unnamed ones are indistinguishable to a screen reader — the point
    // `staff-links.tsx` records about the pair that already exist.
    <nav aria-label="Schedule views" className="border-b">
      <div className="flex gap-1">
        {tabs.map((t) => {
          const active = t.view === current;
          return (
            <Link
              key={t.view}
              href={href(t.view)}
              // ⛔ `"true"`, NOT `"page"`, AND THAT IS NOT A TYPO.
              // `nav-links.tsx:48` already marks the header's "Schedule" as
              // `aria-current="page"` on this URL. Two of those at once is
              // valid ARIA and reads as a fault — `staff-links.tsx:124`
              // records that this exact condition on this exact page was
              // removed on 2026-09-11, and it would come straight back here.
              // `"true"` says "the current one of these" without claiming to
              // be the current PAGE, which is what a view tab actually is.
              aria-current={active ? "true" : undefined}
              className={cn(
                "-mb-px border-b-2 px-3 py-2 text-sm font-medium transition-colors",
                active
                  ? "border-foreground text-foreground"
                  : "text-muted-foreground hover:text-foreground border-transparent",
              )}
            >
              {t.label}
            </Link>
          );
        })}
      </div>
    </nav>
  );
}
