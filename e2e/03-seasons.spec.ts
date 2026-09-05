/**
 * Paths 7–8: Season setup and AI league summary.
 */
import { test, expect } from "@playwright/test";
import type { Page } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";

/** Service-role client, for setting up and tearing down a throwaway season. */
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
  await page.goto("/obhl/dashboard");
}

async function goToActiveSeasonSetup(page: Page) {
  await page.goto("/obhl/seasons");
  await page
    .getByRole("row", { name: /Spring 2026/ })
    .getByRole("link", { name: "Setup" })
    .click();
  await expect(page).toHaveURL(/\/seasons\//);
}

test.describe("Path 7 — Season setup", () => {
  test("seasons list shows Spring 2026 with Active badge", async ({ page }) => {
    await signedInAs(page, "Manager");
    await page.goto("/obhl/seasons");
    await expect(page.getByText("Spring 2026")).toBeVisible();
    await expect(page.getByText("Active").first()).toBeVisible();
  });

  test("season setup page shows step chips and 6 enrolled teams", async ({
    page,
  }) => {
    await signedInAs(page, "Manager");
    await goToActiveSeasonSetup(page);
    await expect(page.getByText("Season created")).toBeVisible();
    await expect(page.getByText("6 enrolled")).toBeVisible();
    await expect(page.locator("table tbody tr")).toHaveCount(6);
  });

  test("carry-forward button is present on season setup", async ({ page }) => {
    await signedInAs(page, "Manager");
    await goToActiveSeasonSetup(page);
    await expect(
      page.getByRole("button", { name: "Same teams as last season" }),
    ).toBeVisible();
  });

  /**
   * Every season action, driven once, with its audit entry read back off the
   * page a manager actually opens.
   *
   * Both halves matter. `leagueOfEntity` (`src/lib/audit.ts`) returns null for
   * an `entity_type` it does not handle, and a null league is hidden by RLS
   * *and* filtered out of every league-scoped view — so an entry can be written
   * correctly and be invisible everywhere. A row count proves nothing about
   * that; the page does.
   *
   * Driven inside a season of its own, because the alternative is unenrolling
   * and reactivating the fixture every other spec is written against. The one
   * unavoidable exception is "Set active", which is per-league by definition —
   * it is done last and put back in `finally`.
   */
  test("every season action lands in this league's audit log", async ({ page }) => {
    const stamp = Date.now();
    const seasonName = `Audit Probe Season ${stamp}`;
    const teamName = `Audit Probe Team ${stamp}`;
    const db = admin();
    const { data: league } = await db
      .from("leagues")
      .select("id")
      .eq("slug", "obhl")
      .single();
    const { data: wasActive } = await db
      .from("seasons")
      .select("id, name")
      .eq("league_id", league!.id)
      .eq("is_active", true)
      .single();

    let seasonId: string | null = null;
    let teamId: string | null = null;
    try {
      await signedInAs(page, "Manager");

      // ── create_season ────────────────────────────────────────────────────
      await page.goto("/obhl/seasons");
      await page.getByLabel("Name").fill(seasonName);
      await page.getByRole("button", { name: "Create season" }).click();
      await expect(page.getByText(`Season "${seasonName}" created.`)).toBeVisible();

      const { data: made } = await db
        .from("seasons")
        .select("id")
        .eq("name", seasonName)
        .single();
      seasonId = made!.id as string;

      await page.goto("/obhl/audit");
      await expect(page.getByText(`Created season ${seasonName}`)).toBeVisible();

      // ── create_team ──────────────────────────────────────────────────────
      await page.goto(`/obhl/seasons/${seasonId}`);
      await page.getByLabel("Team name").fill(teamName);
      await page.getByRole("button", { name: "Add team" }).click();
      await expect(page.getByText(`Added ${teamName}.`)).toBeVisible();
      const { data: madeTeam } = await db
        .from("teams")
        .select("id")
        .eq("name", teamName)
        .single();
      teamId = madeTeam!.id as string;

      await page.goto("/obhl/audit");
      await expect(page.getByText(`Added team ${teamName}`)).toBeVisible();

      // ── unenroll_team ────────────────────────────────────────────────────
      //
      // Destructive: the `season_teams` row is gone afterwards. The entry is
      // filed under the SEASON, which outlives it — a row that named the
      // enrollment would resolve to no league and disappear.
      await page.goto(`/obhl/seasons/${seasonId}`);
      await page
        .locator("table tbody tr")
        .filter({ hasText: teamName })
        .getByRole("button", { name: "Remove" })
        .click();
      await page.waitForLoadState("networkidle");

      await page.goto("/obhl/audit");
      await expect(
        page.getByText(`Removed ${teamName} from this season`),
      ).toBeVisible();

      // ── carry_forward_enrollment ─────────────────────────────────────────
      await page.goto(`/obhl/seasons/${seasonId}`);
      await page
        .getByRole("button", { name: "Same teams as last season" })
        .click();
      await page.waitForLoadState("networkidle");
      await expect(page.getByText("enrolled")).toBeVisible();

      // ── set_active_season ────────────────────────────────────────────────
      //
      // Last, because it takes the league's active season off whatever the rest
      // of the suite expects. Put back in `finally`.
      await page.goto("/obhl/seasons");
      await page
        .getByRole("row", { name: new RegExp(seasonName) })
        .getByRole("button", { name: "Set active" })
        .click();
      await page.waitForLoadState("networkidle");

      await page.goto("/obhl/audit");
      await expect(
        page.getByText(`Made ${seasonName} the active season (was ${wasActive!.name})`),
      ).toBeVisible();

      // …and every one of them named this league. That is the half the page
      // cannot show: an entry filed under no league renders as nothing at all,
      // which reads exactly like an entry that was never written.
      //
      // `carry_forward_enrollment` is only checked here. Its label carries no
      // unique text, so a match on the page could be a leftover from an earlier
      // run — and it reaches its league by the same `season` case as the four
      // above, which the page has already shown working.
      const { data: entries } = await db
        .from("audit_log")
        .select("action, league_id")
        .eq("entity_id", seasonId);
      const byAction = new Map((entries ?? []).map((e) => [e.action, e.league_id]));
      for (const action of [
        "create_season",
        "unenroll_team",
        "carry_forward_enrollment",
        "set_active_season",
      ]) {
        expect(byAction.has(action), `${action} wrote no audit entry`).toBe(true);
        expect(byAction.get(action), `${action} was filed under no league`).toBe(
          league!.id,
        );
      }
    } finally {
      // The two deletes are order-free — `season_teams` cascades from both
      // sides (`0003_membership.sql`). What is NOT order-free is the restore
      // below: by this point the probe season may be the active one, and a
      // partial unique index allows a league only one, so it has to be gone
      // before Spring 2026 can be made active again.
      if (seasonId) await db.from("seasons").delete().eq("id", seasonId);
      if (teamId) await db.from("teams").delete().eq("id", teamId);
      await db
        .from("seasons")
        .update({ is_active: true })
        .eq("id", wasActive!.id);
    }
  });
});

test.describe("Path 8 — AI league summary", () => {
  test("League Summary card shows Generate button when no summary exists", async ({
    page,
  }) => {
    await signedInAs(page, "Manager");
    await goToActiveSeasonSetup(page);
    await page.waitForLoadState("networkidle");
    await expect(page.getByRole("button", { name: "Generate", exact: true })).toBeVisible({ timeout: 10000 });
    await expect(page.getByText("No summary yet")).toBeVisible();
  });

  test("Generate triggers Claude and summary appears on both pages", async ({
    page,
  }) => {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      test.skip(true, "ANTHROPIC_API_KEY not set — skipping live AI call");
      return;
    }

    await signedInAs(page, "Manager");
    await goToActiveSeasonSetup(page);

    await page.getByRole("button", { name: "Generate" }).click();
    await expect(
      page.getByRole("button", { name: "Regenerate" }),
    ).toBeVisible({ timeout: 30_000 });

    const summaryText = await page.locator("p.italic").first().innerText();
    expect(summaryText.length).toBeGreaterThan(20);

    await page.goto("/obhl");
    await expect(
      page.getByRole("heading", { name: "League Update" }),
    ).toBeVisible();
  });
});
