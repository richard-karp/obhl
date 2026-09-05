/** Duplicate merge review. */
import { test, expect } from "@playwright/test";

test("duplicates page loads and is scoped to this league", async ({ page }) => {
  await page.goto("/login");
  await page.getByRole("button", { name: "Manager" }).click();
  await page.waitForURL("/");
  await page.goto("/obhl/people/duplicates");

  await expect(
    page.getByRole("heading", { name: /possible duplicates/i }),
  ).toBeVisible();
  // Every listed name must belong to THIS league. The seed builds names from
  // arrays, so real clusters may or may not exist — assert the scope, not a
  // count, or this test breaks whenever the seed's name arithmetic changes.
  await expect(page.getByText("Anchors")).toHaveCount(0);
});

/**
 * The assertion above passes on an empty page too, so it says nothing about the
 * page having rendered anything. This covers the two things that are true
 * whatever the seed's names work out to: the review component is on the page,
 * and the only route to it works.
 *
 * Deliberately not tested here: the cross-league refusal. `supabase/seed.sql`
 * seeds `obhl` and `harbor`, but the e2e manager belongs to both, so a browser
 * cannot reach it — that is the gap `league-guards.test.ts` covers.
 */
test("the review list renders, and People & Roles links to it", async ({ page }) => {
  await page.goto("/login");
  await page.getByRole("button", { name: "Manager" }).click();
  await page.waitForURL("/");
  await page.goto("/obhl/people");

  await page.getByRole("link", { name: /possible duplicates/i }).click();
  await expect(page).toHaveURL(/\/people\/duplicates$/);

  // Either clusters to review or the empty state — both are the component.
  const clusters = page.getByRole("button", { name: /merge \d+ into this record/i });
  const empty = page.getByText(/no same-name records to review/i);
  await expect(clusters.or(empty).first()).toBeVisible();
});
