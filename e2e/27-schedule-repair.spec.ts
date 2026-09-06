/**
 * Path 27: changing a schedule that is already live — move a whole night, pin a
 * team to a night and repair around it, and repair with no pin at all.
 *
 * ⛔ EVERY WRITE HERE GOES THROUGH AN IN-PLACE `games` UPDATE, NEVER THROUGH
 * `replace_published_schedule`. That is the point of the feature: once
 * `season_is_started` trips, generate, replace and remove refuse permanently,
 * and these tools have to keep working. The id-stability assertion below is what
 * holds that line — a regenerate mints new ids and replaces every subscriber's
 * calendar events; a repair must not.
 *
 * The seeded season's games are all in the past, so it has no unlocked night to
 * work on. This spec builds its own future season, as `14-one-off-game` does,
 * and for the same reason. It runs after that one so its own mutations cannot
 * reach it.
 */
import { test, expect } from "@playwright/test";
import type { Page } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";

/** Service-role client, for reading ids and putting the seeded season back. */
function admin() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SECRET_KEY!,
    { auth: { autoRefreshToken: false, persistSession: false } },
  );
}

const SEASON = "Repair Test 2027";
const FIRST_NIGHT = "2027-01-05";

/** See `11-schedule-builder.spec.ts` — Phase S runs five candidates. */
const AFTER_GENERATE = { timeout: 45_000 };

async function signedInAsManager(page: Page) {
  await page.goto("/login");
  await page.getByRole("button", { name: "Manager" }).click();
  await page.waitForURL("/");
  await page.goto("/obhl/dashboard");
}

/** Every published game id for this spec's season, for the id-stability check. */
async function publishedGameIds(): Promise<string[]> {
  const db = admin();
  const { data: league } = await db
    .from("leagues")
    .select("id")
    .eq("slug", "obhl")
    .single();
  const { data: season } = await db
    .from("seasons")
    .select("id")
    .eq("league_id", league!.id)
    .eq("name", SEASON)
    .single();
  const { data } = await db
    .from("games")
    .select("id")
    .eq("season_id", season!.id)
    .eq("is_draft", false);
  return (data ?? []).map((g) => g.id).sort();
}

/**
 * A live season with future game nights, published. Idempotent across runs —
 * the same shape `14-one-off-game` uses, with its own season so this spec's
 * mutations stay inside it.
 */
async function seedFutureSeason(page: Page) {
  await page.goto("/obhl/seasons");
  const row = page.getByRole("row", { name: new RegExp(SEASON) });
  if ((await row.count()) === 0) {
    await page.getByLabel("Name").fill(SEASON);
    await page.getByLabel("Season starts").fill(FIRST_NIGHT);
    await page.getByLabel("Season ends (incl. playoffs)").fill("2027-06-30");
    await page.getByRole("button", { name: /Create season/i }).click();
    await expect(page).toHaveURL(/\/seasons\/[0-9a-f-]{36}/);
    await page.goto("/obhl/seasons");
    await expect(row).toBeVisible();
  }

  await page.goto("/obhl/seasons");
  await row.getByRole("link", { name: "Setup" }).click();
  await expect(page).toHaveURL(/\/seasons\//);

  if ((await page.locator("table tbody tr").count()) === 0) {
    await page
      .getByRole("button", { name: "Same teams as last season" })
      .click();
    await expect(page.locator("table tbody tr").first()).toBeVisible();
  }

  await page.goto("/obhl/seasons");
  const setActive = row.getByRole("button", { name: "Set active" });
  if ((await setActive.count()) > 0) await setActive.click();
  await expect(setActive).toHaveCount(0);

  await page.goto("/obhl/schedule-builder");
  await expect(
    page.getByText(new RegExp(`${SEASON} · \\d+ teams enrolled`)),
  ).toBeVisible();
  if ((await page.getByText("No draft schedule").count()) > 0) {
    await page.getByLabel("First game night").fill(FIRST_NIGHT);
    await page.getByLabel("Games per team").fill("6");
    await page.locator('label:has-text("Tue") input[name="weekdays"]').check();
    await page.locator('label:has-text("Thu") input[name="weekdays"]').check();
    await page.getByRole("button", { name: "Generate schedule" }).click();
    await expect(page.getByText("Balance report")).toBeVisible(AFTER_GENERATE);
    await page.getByRole("button", { name: /Publish \d+ games/ }).click();
    await expect(page.getByText("No draft schedule")).toBeVisible();
  }
}

test.describe("Path 27 — changing a live schedule", () => {
  // Building the fixture runs a generate; a repair runs the solver again.
  test.describe.configure({ timeout: 240_000 });

  /** Hand obhl back to the seeded season — see `14-one-off-game`. */
  test.afterAll(async () => {
    const db = admin();
    const { data: league } = await db
      .from("leagues")
      .select("id")
      .eq("slug", "obhl")
      .single();
    if (!league) return;
    await db
      .from("seasons")
      .update({ is_active: false })
      .eq("league_id", league.id)
      .eq("name", SEASON);
    await db
      .from("seasons")
      .update({ is_active: true })
      .eq("league_id", league.id)
      .eq("name", "Spring 2026");
  });

  test("a whole night moves in one action, and refuses a date that is taken", async ({
    page,
  }) => {
    test.slow();
    await signedInAsManager(page);
    await seedFutureSeason(page);

    await page.goto("/obhl/schedule-builder");
    const picker = page.getByLabel("Night to move");
    await expect(picker).toBeVisible();

    // The first two nights offered: one to move, and one whose date is taken.
    const options = picker.locator("option:not([disabled])");
    const first = (await options.nth(0).getAttribute("value"))!;
    const second = (await options.nth(1).getAttribute("value"))!;
    expect(first).toBeTruthy();
    expect(second).toBeTruthy();

    // ⚠️ Merging two nights is out of scope, and the refusal names the count.
    await picker.selectOption(first);
    await page.getByLabel("New date").fill(second);
    await page.getByRole("button", { name: "Move night" }).click();
    await expect(page.getByText(/already runs \d+ games?/)).toBeVisible();

    // A free date, mid-week so it cannot collide with a Tue/Thu night.
    const before = await publishedGameIds();
    await page.getByLabel("New date").fill("2027-06-16");
    await page.getByRole("button", { name: "Move night" }).click();
    await expect(page.getByText(/^Moved \d+ games? from /)).toBeVisible();

    // The night is on its new date, and the picker no longer offers the old one.
    await page.goto("/obhl/schedule-builder");
    await expect(
      page.getByLabel("Night to move").locator("option", {
        hasText: "June 16, 2027",
      }),
    ).toHaveCount(1);
    await expect(
      page
        .getByLabel("Night to move")
        .locator(`option[value="${first}"]`),
    ).toHaveCount(0);

    // ⛔ No new game ids. Moving a night is an update, not a republish.
    expect(await publishedGameIds()).toEqual(before);
  });
});
