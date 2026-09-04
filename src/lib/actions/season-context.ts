"use server";

import { revalidatePath } from "next/cache";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { createAdminClient } from "@/utils/supabase/admin";
import { requireLeagueRole } from "@/lib/auth/guards";
import { resolveLeagueBySlug } from "@/lib/league/current";
import { isUuid } from "@/lib/db/uuid";
import { seasonCookieName } from "@/lib/queries/season";

/** Six months. Long enough to outlive a season's worth of visits. */
const SEASON_COOKIE_MAX_AGE = 60 * 60 * 24 * 180;

/**
 * Point the manage tools at a season, and go back where you were.
 *
 * ⚠️ THIS EXISTS BECAUSE A SERVER COMPONENT CANNOT SET A COOKIE. `getManageContext`
 * only reads; a page reaching for `cookies().set()` throws at runtime, because
 * HTTP does not allow a `Set-Cookie` once the response has started streaming.
 * A Server Action runs before its own response, so it may write — which is why
 * the switcher is a form rather than a link.
 *
 * The cookie is not evidence of anything. A browser can carry any value under
 * any name, so `getManageContext` re-checks whatever it reads against the
 * league's own season list on every request. The validation here is so that a
 * bad id is never *stored* in the first place, not so that reads can trust it.
 *
 * Guarded on every role rather than on manager alone: this writes no league
 * data, and each role that can open a manage page — manager, scorekeeper, a
 * captain on the dashboard — has a reason to scope it to a season. Listing all
 * three is "any role", written so that a fourth role added later has to be
 * considered here rather than admitted silently. `requireLeagueRole` also
 * carries the membership half, which is what keeps a manager of one league from
 * pinning a season in another; it covers the League Office too, which holds no
 * `profile_leagues` row (0034).
 */
export async function selectSeason(formData: FormData): Promise<void> {
  const slug = String(formData.get("league") ?? "");
  const seasonId = String(formData.get("season_id") ?? "");
  const raw = String(formData.get("next") ?? "");
  // Same rule as the magic-link handler: same-origin relative paths only, so a
  // hand-made form cannot turn the switcher into an open redirect.
  // ⛔ `//` IS NOT THE ONLY ESCAPE. Browsers normalise a backslash to a forward
  // slash in a Location header, so "/\\evil.com" leaves here looking like a
  // relative path and arrives as "//evil.com" — an off-site redirect. Not
  // reachable cross-site today (Next verifies Origin on Server Actions) and the
  // real caller passes `usePathname()`, so this is depth rather than a hole.
  const looksRelative =
    raw.startsWith("/") && !raw.startsWith("//") && raw[1] !== "\\";
  const next = looksRelative ? raw : `/${slug}/manage/dashboard`;

  const league = await resolveLeagueBySlug(slug);
  if (!league) redirect("/");
  await requireLeagueRole(league.id, "league_manager", "scorekeeper", "captain");

  // Both halves matter. The id must exist AND belong to this league: without
  // the second clause a manager of two leagues could pin league A's season onto
  // league B, where every page would then quietly ignore it.
  if (isUuid(seasonId)) {
    const { data: season } = await createAdminClient()
      .from("seasons")
      .select("id")
      .eq("id", seasonId)
      .eq("league_id", league.id)
      .maybeSingle();
    if (season) {
      const store = await cookies();
      store.set(seasonCookieName(league.id), season.id, {
        httpOnly: true,
        sameSite: "lax",
        path: "/",
        maxAge: SEASON_COOKIE_MAX_AGE,
      });
    }
  }

  // The whole manage subtree, because the cookie rescopes every page under it —
  // not just the one being returned to. These pages are all dynamic, so this is
  // about the client router cache: without it, going back to a page visited
  // before the switch can render the previous season's data and make the
  // control look like it did nothing.
  revalidatePath("/[league]/manage", "layout");
  redirect(next);
}
