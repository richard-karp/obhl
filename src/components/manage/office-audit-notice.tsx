import type { OfficeAuditEntry } from "@/lib/audit";

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
                  {new Date(e.created_at).toLocaleDateString()}
                </span>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
