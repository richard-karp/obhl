import Link from "next/link";
import { cn } from "@/lib/utils";

// ⛔ Real links on `?view=`, not Radix `<Tabs>`, which over URL-driven server content gave blank panels.
// ⛔ `query` is the current search string minus `view`: dropping `?team=` would silently widen a filtered page.

export const SCHEDULE_VIEWS = ["pending", "upcoming", "results"] as const;
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
  // Played and unscored; Pending is offered only when there are some. ⚠️ The count on its label carries the
  // urgency, since unscored games out of sight get forgotten: don't drop it as clutter.
  awaitingCount: number;
  /** The rest of the query string (`team`, `season`, …), already encoded. */
  query: string;
}) {
  const href = (view: ScheduleView) => {
    const params = new URLSearchParams(query);
    // Upcoming is the default, so it gets the bare URL.
    if (view === "upcoming") params.delete("view");
    else params.set("view", view);
    const q = params.toString();
    return `/${league}/schedule${q ? `?${q}` : ""}`;
  };

  const tabs: { view: ScheduleView; label: string }[] = [
    ...(awaitingCount > 0
      ? [{ view: "pending" as const, label: `Pending (${awaitingCount})` }]
      : []),
    { view: "upcoming", label: "Upcoming" },
    { view: "results", label: "Results" },
  ];

  return (
    // ⚠️ Named: this page has three `navigation` landmarks, and unnamed ones are indistinguishable.
    <nav aria-label="Schedule views" className="border-b">
      <div className="flex gap-1">
        {tabs.map((t) => {
          const active = t.view === current;
          return (
            <Link
              key={t.view}
              href={href(t.view)}
              // ⛔ `"true"`, not `"page"`: the header's "Schedule" link is already `aria-current="page"` here, and
              // two at once reads as a fault.
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
