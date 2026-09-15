/**
 * ⛔ Decided by the URL parser, not by inspecting characters: it folds `\` into `/` and strips
 * tab/CR/LF. A path normalizing to `//host` is refused, though the origin check passes it.
 */
export function safeNextPath(
  raw: string | null | undefined,
  fallback: string,
): string {
  if (!raw || !raw.startsWith("/")) return fallback;
  try {
    const probe = new URL(raw, "http://a.invalid");
    if (probe.origin !== "http://a.invalid" || probe.pathname.startsWith("//"))
      return fallback;
    return probe.pathname + probe.search;
  } catch {
    return fallback;
  }
}
