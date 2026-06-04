"use server";

import { cookies } from "next/headers";
import { revalidatePath } from "next/cache";
import { LEAGUE_COOKIE } from "@/lib/league/current";

/** Sets the current-league cookie from the header switcher. */
export async function selectLeague(formData: FormData) {
  const slug = String(formData.get("slug") ?? "").trim();
  if (!slug) return;
  const store = await cookies();
  store.set(LEAGUE_COOKIE, slug, {
    path: "/",
    maxAge: 60 * 60 * 24 * 365,
    sameSite: "lax",
  });
  // Re-render every route group that depends on the active league.
  revalidatePath("/", "layout");
}
