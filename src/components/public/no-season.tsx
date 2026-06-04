import { EmptyState } from "@/components/shared/empty-state";

export function NoSeason() {
  return (
    <EmptyState
      title="No active season"
      description="There's no active season to display yet. Check back soon."
    />
  );
}
