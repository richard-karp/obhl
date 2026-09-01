import { revalidatePath } from "next/cache";

/**
 * Small helpers shared by the scoresheet's server actions
 * (`lib/actions/games.ts`) and by `finalize.ts`.
 *
 * A plain module because `lib/actions/games.ts` is `"use server"`, where every
 * export is a callable endpoint and a non-async export is a build error — so it
 * cannot be the home of anything two modules need to share.
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
  revalidatePath("/[league]/manage/score/[gameId]", "page");
  revalidatePath("/[league]/manage/score", "page");
  if (alsoPublic) for (const p of PUBLIC_PATHS) revalidatePath(p, "page");
}
