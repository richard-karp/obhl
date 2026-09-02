/**
 * Path 13: Announcements — post, verify on homepage, delete.
 */
import { test, expect } from "@playwright/test";
import type { Page } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";

/** Service-role client, for reading what the page is not supposed to show. */
function admin() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SECRET_KEY!,
    { auth: { autoRefreshToken: false, persistSession: false } },
  );
}

async function signedInAs(page: Page, role: "Manager" | "Scorekeeper" | "Captain") {
  await page.goto("/login");
  await page.getByRole("button", { name: role }).click();
  // Sign-in lands on the league picker — there is no league-agnostic dashboard
  // any more. Every caller below expects to be inside a league's manage tools.
  await page.waitForURL("/");
  await page.goto("/obhl/manage/dashboard");
}

const TEST_TITLE = `E2E Test Announcement ${Date.now()}`;
const TEST_BODY = "This was posted by an automated test and should be deleted.";

test.describe("Path 13 — Announcements", () => {
  test("post an announcement, verify on homepage, then delete it", async ({
    page,
  }) => {
    await signedInAs(page, "Manager");
    await page.goto("/obhl/manage/announcements");

    await page
      .getByLabel("Title")
      .or(page.getByPlaceholder("Title"))
      .fill(TEST_TITLE);
    await page
      .getByLabel("Message")
      .or(page.getByPlaceholder("Write the announcement…"))
      .fill(TEST_BODY);

    await page.getByRole("button", { name: "Post announcement" }).click();
    await page.waitForLoadState("networkidle");
    await expect(page.getByText(TEST_TITLE)).toBeVisible();

    // Visible on the league homepage
    await page.goto("/obhl");
    await expect(page.getByText(TEST_TITLE)).toBeVisible();

    // Delete from manage page
    await page.goto("/obhl/manage/announcements");
    await page
      .locator('[data-slot="card"]')
      .filter({ hasText: TEST_TITLE })
      .getByRole("button", { name: "Delete" })
      .click();
    await page.waitForLoadState("networkidle");
    await expect(page.getByText(TEST_TITLE)).not.toBeVisible();

    // Gone from the league homepage
    await page.goto("/obhl");
    await expect(page.getByText(TEST_TITLE)).not.toBeVisible();
  });

  // Guards the trap in `src/lib/audit.ts`: `leagueOfEntity` returns null for any
  // `entity_type` it does not handle, and a null league is hidden by RLS *and*
  // filtered out of every league-scoped view — so an entry can be written
  // perfectly and never appear anywhere a manager looks. Asserting the row
  // exists is therefore not enough; both halves are checked here.
  //
  // The two announcement entries reach their league by different routes on
  // purpose. The post resolves through the `announcement` case in that switch,
  // because its row still exists. The delete cannot — by the time it is logged
  // the row is gone and the switch has nothing to read — so it passes
  // `league_id` outright. Knock the switch case out and only the first goes red.
  test("posting and deleting an announcement both land in this league's audit log", async ({
    page,
  }) => {
    const title = `Audit Probe Announcement ${Date.now()}`;
    const db = admin();
    const { data: league } = await db
      .from("leagues")
      .select("id")
      .eq("slug", "obhl")
      .single();

    await signedInAs(page, "Manager");
    await page.goto("/obhl/manage/announcements");
    await page
      .getByLabel("Title")
      .or(page.getByPlaceholder("Title"))
      .fill(title);
    await page
      .getByLabel("Message")
      .or(page.getByPlaceholder("Write the announcement…"))
      .fill("Posted by an automated test to check the audit log.");
    await page.getByRole("button", { name: "Post announcement" }).click();
    await page.waitForLoadState("networkidle");

    await page.goto("/obhl/manage/audit");
    await expect(page.getByText(`Posted "${title}"`)).toBeVisible();

    await page.goto("/obhl/manage/announcements");
    await page
      .locator('[data-slot="card"]')
      .filter({ hasText: title })
      .getByRole("button", { name: "Delete" })
      .click();
    await page.waitForLoadState("networkidle");

    await page.goto("/obhl/manage/audit");
    await expect(page.getByText(`Deleted "${title}"`)).toBeVisible();

    // …and neither entry was filed under a null league, which is the state the
    // page above cannot distinguish from "no entry was written at all".
    const { data: entries } = await db
      .from("audit_log")
      .select("action, league_id")
      .in("action", ["create_announcement", "delete_announcement"])
      .order("created_at", { ascending: false })
      .limit(2);
    expect((entries ?? []).map((e) => e.action).sort()).toEqual([
      "create_announcement",
      "delete_announcement",
    ]);
    for (const e of entries ?? []) {
      expect(e.league_id, `${e.action} was filed under no league`).toBe(league!.id);
    }
  });
});
