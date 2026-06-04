import { Badge } from "@/components/ui/badge";

const LABELS: Record<string, string> = {
  scheduled: "Scheduled",
  in_progress: "Live",
  final: "Final",
  postponed: "Postponed",
  cancelled: "Cancelled",
};

export function GameStatusBadge({ status }: { status: string }) {
  const label = LABELS[status] ?? status;
  const variant =
    status === "final"
      ? "secondary"
      : status === "in_progress"
        ? "default"
        : status === "cancelled" || status === "postponed"
          ? "outline"
          : "outline";
  return (
    <Badge variant={variant} className="font-medium">
      {label}
    </Badge>
  );
}
