/**
 * Turn a display name into a URL-safe slug: lowercase, with every run of
 * non-alphanumeric characters collapsed to a single hyphen and the leading and
 * trailing hyphens trimmed. Punctuation separates rather than disappears, so
 * "St. John's" becomes "st-john-s".
 */
export function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}
