"use server";

import { revalidatePath } from "next/cache";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { createAdminClient } from "@/utils/supabase/admin";
import { requireLeagueRole } from "@/lib/auth/guards";
import { resolveLeagueBySlug } from "@/lib/league/current";
import { isUuid } from "@/lib/db/uuid";
import { seasonCookieName } from "@/lib/queries/season";
import { safeNextPath } from "@/lib/safe-next-path";

/** Six months. Long enough to outlive a season's worth of visits. */
const SEASON_COOKIE_MAX_AGE = 60 * 60 * 24 * 180;

// ⚠️ An action because a Server Component cannot set a cookie. The cookie is re-checked on every
// read; all three roles are listed so a new role is decided here, not admitted silently.
export async function selectSeason(formData: FormData): Promise<void> {
  const slug = String(formData.get("league") ?? "");
  const seasonId = String(formData.get("season_id") ?? "");
  // Same-origin relative paths only, so a hand-made form cannot turn the
  // switcher into an open redirect. Not reachable cross-site today.
  const next = safeNextPath(
    String(formData.get("next") ?? ""),
    `/${slug}/dashboard`,
  );

  const league = await resolveLeagueBySlug(slug);
  if (!league) redirect("/");
  await requireLeagueRole(
    league.id,
    "league_manager",
    "scorekeeper",
    "captain",
  );

  // The id must exist AND belong to this league, or a manager of two could pin A's season on B.
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

  // ⚠️ The whole `/[league]` layout: the cookie rescopes every page, public ones included, and a
  // `/manage` path names no route (`(manage)` is a route group).
  revalidatePath("/[league]", "layout");
  redirect(next);
}
