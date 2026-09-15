import { EmptyState } from "@/components/shared/empty-state";

/**
 * ⛔ `readFailed` is not decoration. Every caller reaches this through `ctx.season === null`,
 * which is true both when the league has no active season and when the read of it failed —
 * and "Check back soon" is a statement about the league, made on information nobody has.
 */
export function NoSeason({ readFailed = false }: { readFailed?: boolean }) {
  if (readFailed) {
    return (
      <EmptyState
        title="Couldn't load this league's season"
        description="Something went wrong reading it — this is not the same as there being no season. Reload, and tell a manager if it keeps happening."
      />
    );
  }
  return (
    <EmptyState
      title="No active season"
      description="There's no active season to display yet. Check back soon."
    />
  );
}
