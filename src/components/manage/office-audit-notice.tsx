import type { OfficeAuditEntry } from "@/lib/audit";

// Pinned to a locale, like `audit-session-list.tsx`: a bare `toLocaleDateString()` uses the server's.
function fmt(iso: string) {
  return new Date(iso).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });
}

/** Prose fixed in one place: audit prose says "a deputy commissioner", the role column "Deputy". */
function sentence(e: OfficeAuditEntry): string {
  switch (e.action) {
    case "appoint_deputy":
      return `${e.actor} appointed ${e.target} as a deputy commissioner`;
    case "remove_deputy":
      return `${e.actor} removed ${e.target} as a deputy commissioner`;
    // Not an office act: filed here because this band is the only surface for an entry with no league.
    // Worded so it can't be misread as one.
    case "set_own_password":
      return `${e.actor} set their own password`;
    default:
      // An action added without a sentence here should read as unfinished, not
      // as something that did not happen.
      return `${e.actor} changed ${e.target} in the League Office (${e.action})`;
  }
}

// A distinct band, one row per action: a tier change touches every league, and a row per league is noise.
export function OfficeAuditNotice({
  entries,
  heading,
  emptyText,
}: {
  entries: OfficeAuditEntry[];
  heading: string;
  emptyText?: string;
}) {
  if (entries.length === 0 && !emptyText) return null;

  return (
    <section className="bg-muted/30 rounded-lg border p-4">
      <h2 className="mb-2 text-sm font-semibold">{heading}</h2>
      {entries.length === 0 ? (
        <p className="text-muted-foreground text-sm">{emptyText}</p>
      ) : (
        <ul className="space-y-1">
          {entries.map((e) => (
            <li key={e.id} className="text-muted-foreground text-sm">
              {sentence(e)}
              {e.created_at ? (
                <span className="ml-2 text-xs opacity-70">
                  {fmt(e.created_at)}
                </span>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
