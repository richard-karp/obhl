import { EmptyState } from "@/components/shared/empty-state";

/** ⛔ Callers pass `readFailed`: a null season is also a failed read, and "Check back soon" would be false. */
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
