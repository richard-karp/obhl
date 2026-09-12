/**
 * Paths 19–21: Goalie management — buttons on score page, default goalie on
 * roster page, and captain permission to set goalie.
 */
import { test, expect } from "@playwright/test";
import type { Page } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";

function admin() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SECRET_KEY!,
    { auth: { autoRefreshToken: false, persistSession: false } },
  );
}

/**
 * A Sharks game still to be played, on the given weekday in the league zone.
 *
 * ⛔ `scheduled`, NOT ANY GAME. A finalized game already has a goalie of
 * record, and the board shows THAT instead of the suggestion — so a test that
 * grabbed a played game would assert the seed's scoring, not the rule.
 */
async function sharksGameOn(weekday: number): Promise<string> {
  const db = admin();
  const { data: team } = await db
    .from("teams")
    .select("id")
    .eq("slug", "sharks")
    .limit(1)
    .single();
  // ⛔ SCOPED TO THE ACTIVE SEASON AND ORDERED. Without the season filter this
  // matched Sharks games in ANY season, including ones other specs create, and
  // without an order it took whichever row PostgREST returned first. It worked
  // only because `workers: 1` happens to run this file before those specs — a
  // dependency on suite order that nothing states.
  const { data: season } = await db
    .from("seasons")
    .select("id, leagues!inner(slug)")
    .eq("leagues.slug", "obhl")
    .eq("is_active", true)
    .single();
  const { data: games } = await db
    .from("games")
    .select("id, scheduled_at, home_team_id, away_team_id, status, is_draft")
    .eq("season_id", season!.id)
    .or(`home_team_id.eq.${team!.id},away_team_id.eq.${team!.id}`)
    .eq("status", "scheduled")
    .eq("is_draft", false)
    .order("scheduled_at", { ascending: true });
  const match = (games ?? []).find(
    (g) =>
      g.scheduled_at &&
      new Date(g.scheduled_at).toLocaleDateString("en-US", {
        timeZone: "America/New_York",
        weekday: "short",
      }) === ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][weekday],
  );
  if (!match) {
    throw new Error(
      `Seed has no scheduled Sharks game on weekday ${weekday} — check supabase/seed.sql, which pins rounds 4 (Tue) and 5 (Thu).`,
    );
  }
  return match.id;
}

async function signedInAs(
  page: Page,
  role: "Manager" | "Scorekeeper" | "Captain",
) {
  await page.goto("/login");
  await page.getByRole("button", { name: role }).click();
  // ⚠️ THE LANDING IS ROLE-DEPENDENT NOW. Everyone still lands on the league
  // picker, except a scorekeeper, who lands on `/tonight` — the only
  // surface they are meant to use. Waiting for "/" unconditionally would hang
  // here for the whole scorekeeper half of this file.
  await page.waitForURL(role === "Scorekeeper" ? "/tonight" : "/");
  await page.goto("/obhl/dashboard");
}

// ── Path 19: Scorekeeper sees goalie buttons ────────────────────────────────

test.describe("Path 19 — Scorekeeper goalie buttons", () => {
  test("goalie section shows buttons not a dropdown after dressing players", async ({
    page,
  }) => {
    await signedInAs(page, "Scorekeeper");
    await page.goto("/obhl/schedule");

    // The scorekeeper's game list is the public schedule now, with a
    // button per row for whoever may open a scoresheet.
    // ⛔ BY HREF: a scorekeeper now sees only tonight's games, and by the time
    // this file runs earlier specs have finalized some of them — at which point
    // the button says "Edit" and a label match finds nothing.
    await page.locator('a[href$="/score"]').first().click();
    await expect(page).toHaveURL(/\/games\/[^/]+\/score$/);

    // Dress all players for both teams so goalie section appears
    const lineupForms = page.locator("form").filter({
      has: page.locator('input[name="player_ids"]'),
    });
    for (let f = 0; f < (await lineupForms.count()); f++) {
      const boxes = lineupForms.nth(f).locator('input[type="checkbox"]');
      for (let i = 0; i < (await boxes.count()); i++) {
        await boxes.nth(i).check();
      }
      await lineupForms
        .nth(f)
        .getByRole("button", { name: "Save lineup" })
        .click();
      await page.waitForLoadState("networkidle");
    }

    // Goalie section uses buttons with jersey-number labels, not a <select>
    await expect(page.locator('select[name="goalie_id"]')).toHaveCount(0);
    await expect(page.getByText("GOALIE").first()).toBeVisible();

    // Each goalie form renders a visible submit button (e.g. "#1", "Sub")
    const goalieForm = page
      .locator("form")
      .filter({ has: page.locator('input[name="goalie_id"]') })
      .first();
    const goalieBtn = goalieForm.getByRole("button");
    await expect(goalieBtn).toBeVisible();

    // Clicking a button submits the form; page should still render the section
    await goalieBtn.click();
    await page.waitForLoadState("networkidle");
    await expect(page.getByText("GOALIE").first()).toBeVisible();
  });
});

// ── Path 20: the night's goalie ─────────────────────────────────────────────
//
// ⛔ THREE TESTS STOOD HERE AND ARE GONE (2026-09-11). They drove "Set Default"
// on a roster row and the "Goalie Schedule" card's per-weekday selects — both
// removed with `team_players.is_default_goalie` and the `team_goalie_days`
// table in `0049`. They could not be repointed, because there is no longer a
// goalie-specific control anywhere: a night is an ordinary roster field now,
// set beside jersey and position, and for a goalie it names that night's
// starter.
//
// ⚠️ REPLACED, NOT DROPPED. The rule itself is unit-tested in
// `src/lib/goalie/suggest.ts` — including the case no fixture reaches, two
// goalies sharing a night. What belongs HERE is the end-to-end pair the unit
// test cannot see: a two-goalie team pre-selecting a DIFFERENT goalie on each
// of its two nights, and a one-goalie team pre-selecting theirs on every
// night. Both need a fixture with two nights and a team with two goalies,
// which the seed gains in the next commit; the tests land with it.

test.describe("Path 20 — the night's goalie", () => {
  /**
   * ⛔ THE ONE THING THE UNIT TEST CANNOT SEE. `suggestGoalie` is exercised
   * directly in `src/lib/goalie/suggest.test.ts`; what it cannot prove is that
   * the scoresheet READS the same column the roster WRITES, on a real game,
   * through the real query. That is the shape of the two failures `AGENTS.md`
   * records — a feature that passed its whole suite while doing nothing.
   *
   * ⚠️ ASSERTED THROUGH `#8`, WHICH ONLY SHARKS HAVE. Every other seeded team's
   * goalie wears #1, so #1 appears twice on any scoresheet and cannot identify
   * a side; #8 is Sharks' second goalie and is pinned to Thursday. Whether it
   * carries the suggested styling therefore answers "did the night decide
   * this?" on its own.
   */
  const suggested = (page: Page, label: string) =>
    page.getByRole("button", { name: label, exact: true });

  test("a two-goalie team suggests a different goalie on each of its nights", async ({
    page,
  }) => {
    await signedInAs(page, "Manager");

    // Thursday: #8's night, so #8 is the suggestion.
    await page.goto(`/obhl/games/${await sharksGameOn(4)}/score`);
    await expect(suggested(page, "#8")).toBeVisible();
    await expect(suggested(page, "#8")).toHaveClass(/bg-secondary/);

    // Tuesday: #1's night. #8 is still on the page — same roster — but must no
    // longer be the one offered, which is the whole point of the column.
    await page.goto(`/obhl/games/${await sharksGameOn(2)}/score`);
    await expect(suggested(page, "#8")).toBeVisible();
    await expect(suggested(page, "#8")).not.toHaveClass(/bg-secondary/);
  });

  test("a one-goalie team suggests its goalie whatever the night", async ({
    page,
  }) => {
    // ⚠️ THE RULE THAT REPLACED `is_default_goalie`. Every such flag in
    // production sat on a team with exactly one goalie, and this reproduces
    // them: the seed gives those teams a goalie with NO night at all, so
    // nothing but the one-goalie rule can be selecting them.
    await signedInAs(page, "Manager");
    await page.goto(`/obhl/games/${await sharksGameOn(4)}/score`);

    // Exactly two buttons carry the suggestion — one per team. Sharks' is #8
    // by its night; the opponent's is theirs by being their only goalie.
    await expect(
      page
        .getByRole("button", { name: /^#\d+$/ })
        .and(page.locator(".bg-secondary")),
    ).toHaveCount(2);
  });
});

// ── Path 21: Captain sets goalie ────────────────────────────────────────────

test.describe("Path 21 — Captain sets goalie of record", () => {
  test("captain sees goalie buttons for their own team", async ({ page }) => {
    await signedInAs(page, "Captain");

    const gameLink = page.getByRole("link", { name: "Set lineup" }).first();
    await expect(gameLink).toBeVisible();
    await gameLink.click();
    await expect(page).toHaveURL(/\/games\/[^/]+\/score$/);

    // Goalie section is present (label visible)
    await expect(page.getByText("GOALIE").first()).toBeVisible();

    // Goalie buttons are rendered — each is a visible submit button inside a goalie form
    const goalieForm = page
      .locator("form")
      .filter({ has: page.locator('input[name="goalie_id"]') })
      .first();
    await expect(goalieForm.getByRole("button")).toBeVisible();
  });

  test("captain can click a goalie button and it persists", async ({
    page,
  }) => {
    await signedInAs(page, "Captain");

    const gameLink = page.getByRole("link", { name: "Set lineup" }).first();
    await gameLink.click();
    await expect(page).toHaveURL(/\/games\/[^/]+\/score$/);

    // Click the first goalie button
    const firstGoalieForm = page
      .locator("form")
      .filter({ has: page.locator('input[name="goalie_id"]') })
      .first();
    await firstGoalieForm.getByRole("button").click();
    await page.waitForLoadState("networkidle");

    // After save the page re-renders on the same URL with the goalie section still present
    await expect(page).toHaveURL(/\/games\/[^/]+\/score$/);
    await expect(page.getByText("GOALIE").first()).toBeVisible();
  });

  test("captain does not see empty-net GA controls", async ({ page }) => {
    await signedInAs(page, "Captain");

    const gameLink = page.getByRole("link", { name: "Set lineup" }).first();
    await gameLink.click();
    await expect(page).toHaveURL(/\/games\/[^/]+\/score$/);

    // ⛔ THE LABEL, EXACTLY AS RENDERED. This read `"EMPTY-NET GA"` and passed on
    // a case-insensitive substring match — until the label was renamed to
    // "Empty-net goals", after which it matched nothing for ANY role and could
    // no longer fail — `getByText` with a string is a case-insensitive SUBSTRING
    // match, so it was real against the old label and vacuous against the new
    // one. Keep it pinned to the string the component actually renders.
    await expect(page.getByText("Empty-net goals")).toHaveCount(0);
  });
});

// ── Path 22: a substitute goalie is an answer ───────────────────────────────

test.describe("Path 22 — the finalize gate and the Sub button", () => {
  /**
   * ⛔ THE FALSE POSITIVE THE GATE WAS CORRECTED FOR, AND THE ONLY SPEC THAT
   * WOULD SEE IT COME BACK.
   *
   * `finalizeGame` refuses a sheet with no goalie of record — four of six
   * team-sides in the maintainer's first three production games had none, and
   * all three completed silently. But `setGoalie` writes
   * `goalie_id = null, is_sub = true` for the Sub button, and that is a
   * COMPLETE answer: `0015` gives a substitute goalie no individual record on
   * purpose. A gate that read the resulting null as "nobody entered this"
   * would nag a correctly-filled sheet, and a warning that fires on correct
   * data is how people learn to click through warnings — which would undo the
   * whole point of the gate.
   *
   * `scoresheetProblems` therefore warns on `none` and not on `sub`, and
   * `incomplete.test.ts` pins that. What the unit test cannot see is whether
   * the SCORESHEET reaches the same conclusion from real rows — the gap
   * `AGENTS.md` names, a feature green in every test while doing nothing in
   * production.
   */
  test("a game whose goalies are both subs completes without a warning", async ({
    page,
  }) => {
    await signedInAs(page, "Manager");
    const gameId = await sharksGameOn(4);
    await page.goto(`/obhl/games/${gameId}/score`);

    // Both sides need a lineup, or the gate fires on that instead and the test
    // would pass for the wrong reason.
    const lineupForms = page.locator("form").filter({
      has: page.locator('input[name="player_ids"]'),
    });
    for (let f = 0; f < (await lineupForms.count()); f++) {
      const boxes = lineupForms.nth(f).locator('input[type="checkbox"]');
      for (let i = 0; i < (await boxes.count()); i++)
        await boxes.nth(i).check();
      await lineupForms
        .nth(f)
        .getByRole("button", { name: "Save lineup" })
        .click();
      await page.waitForLoadState("networkidle");
    }

    // A substitute in each net. ⚠️ Re-resolved each pass: the click re-renders
    // the board, so a locator held across it goes stale.
    for (let i = 0; i < 2; i++) {
      await page
        .getByRole("button", { name: "Sub", exact: true })
        .nth(i)
        .click();
      await page.waitForLoadState("networkidle");
    }

    try {
      await page.getByRole("button", { name: "Complete game" }).click();
      await page.waitForLoadState("networkidle");

      // No bounce, no banner, and the game is actually written.
      await expect(page).not.toHaveURL(/incomplete=1/);
      await expect(
        page
          .locator("[role=alert]")
          .filter({ hasText: "not finished being entered" }),
      ).toHaveCount(0);
      await expect(page.getByText("Final").first()).toBeVisible();
    } finally {
      // ⚠️ PUT BACK. `sharksGameOn` only returns `scheduled` games, so leaving
      // this one final quietly shrinks the pool the tests above draw from.
      await page.goto(`/obhl/games/${gameId}/score`);
      const reopen = page.getByRole("button", { name: "Reopen" });
      if (await reopen.isVisible()) {
        await reopen.click();
        await page.waitForLoadState("networkidle");
      }
    }
  });
});
