/**
 * Team branding — dark monogram ink and uploaded crests — has to survive the
 * trip from `teams` to the chip on EVERY screen, not just the four call sites
 * that happened to plumb the columns through.
 *
 * `TeamLogo` was never the bug (see `src/components/shared/team-logo.test.ts`,
 * the control): the callers were, because a column absent from a `select` is
 * `undefined` at the prop and the chip's fallbacks — white letters, initials —
 * are indistinguishable from a team that genuinely wants them. So these
 * assertions are deliberately made against DATA a caller can only be showing if
 * it asked the database for it.
 *
 * Two teams, not one: `logo_text_color` has NO effect once `logo_path` is set —
 * that branch renders the image and draws no letters — so one team carries the
 * crest and the rest carry the ink.
 */
import { test, expect } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";

const LOGO_PATH = "e2e-branding/crest.png";

function admin() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SECRET_KEY!,
    { auth: { autoRefreshToken: false, persistSession: false } },
  );
}

/**
 * The rows exactly as they were before this file touched them, captured in
 * `beforeAll` and held here so `afterAll` needs no lookup of its own — a second
 * round trip there is a second chance to fail.
 *
 * ⛔ THE PRIOR VALUES, NOT THE SCHEMA DEFAULTS. Restoring to `'light'` / `null`
 * is right only for a freshly seeded database, and this one is NOT freshly
 * seeded per spec: worktrees share ONE local Supabase, and a parallel session's
 * branch or an earlier spec may legitimately have set a team's branding. Writing
 * the defaults back would then be this file silently overwriting somebody else's
 * fixture — damage that outlives the run, on a database no `db reset` of ours is
 * going to undo for them.
 */
let before: {
  id: string;
  logo_text_color: string | null;
  logo_path: string | null;
}[] = [];

test.describe("Team logo ink and crests reach every screen", () => {
  test.beforeAll(async () => {
    const db = admin();
    const { data: teams, error } = await db
      .from("teams")
      .select("id, logo_text_color, logo_path, leagues!inner(slug)")
      .eq("leagues.slug", "obhl")
      .order("id", { ascending: true });
    if (error)
      throw new Error(`could not read Oceanview teams: ${error.message}`);
    before = (teams ?? []).map((t) => ({
      id: t.id,
      logo_text_color: t.logo_text_color,
      logo_path: t.logo_path,
    }));
    if (before.length === 0)
      throw new Error("Oceanview has no teams — is the seed loaded?");

    // Every Oceanview team gets the dark ink, so no assertion below depends on
    // which teams happen to be playing tonight or leading the scoring race.
    const ids = before.map((t) => t.id);
    await db.from("teams").update({ logo_text_color: "dark" }).in("id", ids);
    // Exactly one crest. The file need not exist in storage — what is being
    // asserted is that the caller read the column and chose the image branch.
    await db.from("teams").update({ logo_path: LOGO_PATH }).eq("id", ids[0]);
  });

  test.afterAll(async () => {
    // Row by row, because the captured values differ per team. Six statements
    // against one shared database is a price worth paying to put back exactly
    // what was there.
    const db = admin();
    for (const row of before) {
      await db
        .from("teams")
        .update({
          logo_text_color: row.logo_text_color ?? "light",
          logo_path: row.logo_path,
        })
        .eq("id", row.id);
    }
  });

  test("the schedule shows dark letters and the uploaded crest", async ({
    page,
  }) => {
    await page.goto("/obhl/schedule");
    // The crest: `game-row.tsx` can only render an <img> if `logo_path` came
    // through `GAME_SELECT`.
    await expect(
      page.locator(`img[src*="${LOGO_PATH}"]`).first(),
    ).toBeAttached();
    // The ink: `text-slate-900` is the dark branch of the monogram chip.
    await expect(page.locator("span.text-slate-900").first()).toBeVisible();
  });

  test("the league home shows dark letters in the points leaders", async ({
    page,
  }) => {
    await page.goto("/obhl");
    // Scoped to the leaders card on purpose. The standings table on the same
    // page already plumbed `textColor` before this change, so an unscoped
    // `text-slate-900` on this page passes whether or not the leaders were
    // fixed.
    const leaders = page
      .locator('[data-slot="card"]')
      .filter({ hasText: "Points Leaders" });
    await expect(leaders.locator("span.text-slate-900").first()).toBeVisible();
  });

  test("the standings table shows the uploaded crest", async ({ page }) => {
    await page.goto("/obhl/standings");
    await expect(
      page.locator(`img[src*="${LOGO_PATH}"]`).first(),
    ).toBeAttached();
  });

  test("the stats tables show dark letters and the uploaded crest", async ({
    page,
  }) => {
    await page.goto("/obhl/stats");
    await expect(page.locator("span.text-slate-900").first()).toBeVisible();
    await expect(
      page.locator(`img[src*="${LOGO_PATH}"]`).first(),
    ).toBeAttached();
  });
});
