/**
 * A redirect target that stays on this site, or `fallback`.
 *
 * ⛔ Decided by the URL parser, not by inspecting characters: the parser folds
 * `\` into `/` and strips tab/CR/LF first, which every hand-written check missed.
 * A path that normalizes to `//host` (a dot-segment ahead of the slashes, plain
 * or percent-encoded) is refused too, even though the origin check alone passes it.
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
