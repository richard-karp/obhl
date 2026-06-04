/** Date/time formatting helpers for game schedules. */

export function formatGameDate(iso: string | null): string {
  if (!iso) return "TBD";
  return new Date(iso).toLocaleDateString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
  });
}

export function formatGameTime(iso: string | null): string {
  if (!iso) return "";
  return new Date(iso).toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
  });
}

export function formatGameDateTime(iso: string | null): string {
  if (!iso) return "TBD";
  const date = formatGameDate(iso);
  const time = formatGameTime(iso);
  return time ? `${date} · ${time}` : date;
}

export function formatLongDate(iso: string | null): string {
  if (!iso) return "";
  return new Date(iso).toLocaleDateString("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric",
  });
}
