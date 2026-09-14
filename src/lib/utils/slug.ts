/**
 * Lowercase, each run of non-alphanumerics one hyphen, ends trimmed. Punctuation separates
 * rather than disappears: "St. John's" becomes "st-john-s".
 */
export function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}
