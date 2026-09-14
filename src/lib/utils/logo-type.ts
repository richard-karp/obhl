/**
 * The image types a team logo may be. SVG is left out on purpose: the logos
 * bucket is public, and an SVG can carry script.
 */
const LOGO_TYPES: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
};

export const LOGO_ACCEPT = "image/png,image/jpeg,image/webp";

/** The stored extension and content type for an upload, or null to refuse it. */
export function logoFileType(
  fileName: string,
): { ext: string; contentType: string } | null {
  const dot = fileName.lastIndexOf(".");
  if (dot < 0) return null;
  const ext = fileName.slice(dot + 1).toLowerCase();
  const contentType = LOGO_TYPES[ext];
  return contentType ? { ext, contentType } : null;
}
