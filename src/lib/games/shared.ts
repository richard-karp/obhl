import { revalidatePath } from "next/cache";

/**
 * A plain module: `lib/actions/games.ts` is `"use server"`, where every export is a callable
 * endpoint and a non-async export is a build error.
 */

const PUBLIC_PATHS = [
  "/[league]",
  "/[league]/standings",
  "/[league]/stats",
  "/[league]/schedule",
];

/** Surface a DB/RLS error instead of silently "succeeding" with nothing saved. */
export function check(error: { message: string } | null, what: string) {
  if (error) throw new Error(`${what} failed: ${error.message}`);
}

export function revalidateAfterScore(gameId: string, alsoPublic = false) {
  revalidatePath("/[league]/games/[gameId]/score", "page");
  if (alsoPublic) for (const p of PUBLIC_PATHS) revalidatePath(p, "page");
}
