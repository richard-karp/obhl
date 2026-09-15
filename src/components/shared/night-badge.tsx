import { Badge } from "@/components/ui/badge";
import { NIGHT_LABEL, NIGHT_LONG } from "@/lib/season/nights";

// ⚠️ First letter only, so Tuesday and Thursday are both `T`, by the maintainer's choice; `title` tells them apart.
// ⚠️ `title` only: `aria-label` is dropped on a role-less span, and `sr-only` text breaks e2e name matching.
export function NightBadge({ night }: { night: number | null }) {
  // A night the season no longer plays still renders: hiding it would discard a manager's work.
  if (night === null) return null;
  return (
    <Badge
      variant="outline"
      className="ml-1 px-1.5 py-0 text-[0.65rem]"
      title={NIGHT_LONG[night]}
    >
      {NIGHT_LABEL[night][0]}
    </Badge>
  );
}
