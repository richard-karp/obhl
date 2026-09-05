import type { OfficeAuditEntry } from "@/lib/audit";

/**
 * The same shape the audit entries beneath this band use
 * (`audit-session-list.tsx`), and pinned to a locale for the same reason: a bare
 * `toLocaleDateString()` renders in whatever locale and timezone the SERVER
 * happens to have, which is neither the reader's nor stable across deploys.
 */
function fmt(iso: string) {
  return new Date(iso).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });
}

/**
 * Prose fixed in one place so the two surfaces cannot drift.
 *
 * The role column and the office roster read "Commissioner" and "Deputy"; audit
 * prose reads "a commissioner" and "a deputy commissioner", which is how the
 * appointment is said aloud.
 */
function sentence(e: OfficeAuditEntry): string {
  switch (e.action) {
    case "appoint_deputy":
      return `${e.actor} appointed ${e.target} as a deputy commissioner`;
    case "remove_deputy":
      return `${e.actor} removed ${e.target} as a deputy commissioner`;
    default:
      // An action added without a sentence here should read as unfinished, not
      // as something that did not happen.
      return `${e.actor} changed ${e.target} in the League Office (${e.action})`;
  }
}

/**
 * League Office changes, as a distinct band rather than rows in a league's log.
 *
 * A tier change touches every league, so filing one row per league would fill a
 * manager's log with entries about people who never worked it, and give N rows
 * for one act. One row per action, shown apart, says the same thing once.
 *
 * `heading` differs by surface: on a league's audit page this is context a
 * manager cannot act on; in League Office it is that page's own log.
 */
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
