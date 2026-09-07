/**
 * Path 28: manual schedule edits — every one of them a trade.
 *
 * ⛔ WHAT THIS SPEC IS REALLY GUARDING: the user's constraint that total games
 * per team and games per night are non-negotiable. The UI cannot be allowed to
 * produce a schedule that breaks either, so the assertions below read the
 * COUNTS out of the database before and after each edit rather than trusting a
 * success message.
 *
 * Seeds its own future season, the shape `14-one-off-game` and
 * `29-schedule-repair` use, so its mutations stay inside it.
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
 * ⛔ COMPUTED, NEVER PINNED. `11-` and `23-` hardcode 2026-09-15 and break the
 * day after it passes; a spec seeded from the clock cannot rot that way. Far
 * enough out that the season can never be "started" while this suite runs.
 */
const YEAR = new Date().getUTCFullYear() + 2;
const SEASON = `Edit Test ${YEAR}`;
const FIRST_NIGHT = `${YEAR}-01-05`; // a Tuesday-ish anchor; the generator picks nights
const SEASON_END = `${YEAR}-06-30`;

/** See `11-schedule-builder.spec.ts` — Phase S runs five candidates. */
const AFTER_GENERATE = { timeout: 45_000 };

/**
 * Wait for the generate form, and fail IMMEDIATELY and by name if the builder
 * came up in either state that has no form on the page.
 *
 * ⚠️ COPIED, AND IT HAS TO BE. A shared `e2e/*.ts` module was built and measured
 * on 2026-09-06: every relative TypeScript import dies at load with
 * `context.conditions?.includes is not a function`, sibling or not, with or
 * without a `.js` specifier. Change one copy, change them all.
 */
async function expectGenerateFormUsable(page: Page) {
  const firstNight = page.getByLabel("First game night");
  const readFailed = page.getByText("This season's games couldn't be read");
  const started = page.getByText("The season is under way");
  await expect(firstNight.or(readFailed).or(started).first()).toBeVisible();
  if (await readFailed.isVisible()) {
    throw new Error("Schedule builder is in its read-failed state.");
  }
  if (await started.isVisible()) {
    throw new Error(
      "The seeded season has started — check the dates it seeds.",
    );
  }
}

async function signedInAs(page: Page, role: "Manager" | "Scorekeeper") {
  await page.goto("/login");
  await page.getByRole("button", { name: role }).click();
  await page.waitForURL("/");
  await page.goto("/obhl/dashboard");
}

async function seasonId(): Promise<string> {
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
  return season!.id as string;
}

/** The two numbers the whole feature promises to keep. */
async function counts(season: string) {
  const db = admin();
  const { data } = await db
    .from("games")
    .select("scheduled_at, status, home_team_id, away_team_id")
    .eq("season_id", season)
    .eq("is_draft", false);
  const perTeam: Record<string, number> = {};
  const perNight: Record<string, number> = {};
  for (const g of data ?? []) {
    perTeam[g.home_team_id] = (perTeam[g.home_team_id] ?? 0) + 1;
    perTeam[g.away_team_id] = (perTeam[g.away_team_id] ?? 0) + 1;
    if (g.status !== "scheduled" || !g.scheduled_at) continue;
    // The league runs on Eastern; slicing the ISO date is enough here because
    // every seeded game is an evening, well clear of a UTC day boundary flip
    // in that direction.
    const night = new Date(g.scheduled_at).toISOString().slice(0, 10);
    perNight[night] = (perNight[night] ?? 0) + 1;
  }
  return { perTeam, perNight };
}

/** Live games already in the seeded season — the seed's idempotence check. */
async function publishedCount(): Promise<number> {
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
    .maybeSingle();
  if (!season) return 0;
  const { count } = await db
    .from("games")
    .select("id", { count: "exact", head: true })
    .eq("season_id", season.id)
    .eq("is_draft", false);
  return count ?? 0;
}

/**
 * The first pair of games that can legally trade nights, as indices into the
 * panel's own game list.
 *
 * ⛔ COMPUTED, NOT GUESSED. A first attempt picked the first and last games and
 * the app refused it — correctly: swapping them put Bears on a night Bears
 * already played. With six teams and two games a night, most arbitrary pairs
 * collide, so a test that picks blind is testing the refusal path by accident
 * and calling it the success path.
 */
async function tradeablePair(season: string): Promise<[number, number]> {
  const db = admin();
  const { data } = await db
    .from("games")
    .select("id, scheduled_at, status, home_team_id, away_team_id")
    .eq("season_id", season)
    .eq("is_draft", false)
    .order("scheduled_at", { ascending: true });

  // The same list the panel builds: dated, not final, in date order.
  const games = (data ?? []).filter(
    (g) => g.scheduled_at && g.status !== "final",
  );
  const night = (g: (typeof games)[number]) =>
    new Date(g.scheduled_at!).toISOString().slice(0, 10);
  const teams = (g: (typeof games)[number]) => [g.home_team_id, g.away_team_id];

  /** Would this night hold a team twice once `incoming` replaces `outgoing`? */
  const clashes = (
    on: string,
    outgoing: (typeof games)[number],
    incoming: (typeof games)[number],
  ) => {
    const others = games.filter(
      (g) => night(g) === on && g.id !== outgoing.id && g.id !== incoming.id,
    );
    const seen = new Set(others.flatMap(teams));
    return teams(incoming).some((t) => seen.has(t));
  };

  for (let i = 0; i < games.length; i++) {
    for (let j = i + 1; j < games.length; j++) {
      if (night(games[i]) === night(games[j])) continue;
      if (clashes(night(games[i]), games[i], games[j])) continue;
      if (clashes(night(games[j]), games[j], games[i])) continue;
      return [i, j];
    }
  }
  throw new Error("No pair of games in this fixture can legally trade nights.");
}

/**
 * A pair of games and the two teams that can legally trade places between them,
 * as [gameIndexA, gameIndexB, teamNameA, teamNameB].
 *
 * Same reasoning as `tradeablePair`: with six teams and two games a night, most
 * arbitrary picks collide, so a blind selection exercises the refusal path and
 * reads like a passing success test.
 */
async function tradeableTeams(
  season: string,
): Promise<[number, number, string, string]> {
  const db = admin();
  const { data } = await db
    .from("games")
    .select(
      "id, scheduled_at, status, home_team_id, away_team_id, home:teams!games_home_team_id_fkey(name), away:teams!games_away_team_id_fkey(name)",
    )
    .eq("season_id", season)
    .eq("is_draft", false)
    .order("scheduled_at", { ascending: true });

  const games = (data ?? []).filter(
    (g) => g.scheduled_at && g.status === "scheduled",
  );
  const night = (g: (typeof games)[number]) =>
    new Date(g.scheduled_at!).toISOString().slice(0, 10);
  const nameOf = (g: (typeof games)[number], teamId: string) =>
    (teamId === g.home_team_id
      ? (g.home as unknown as { name: string } | null)
      : (g.away as unknown as { name: string } | null)
    )?.name ?? "";

  /** Teams on a night once `moving` joins it in `leaving`'s place. */
  const clashes = (
    g: (typeof games)[number],
    leaving: string,
    moving: string,
  ) => {
    const others = games.filter((o) => night(o) === night(g) && o.id !== g.id);
    const seen = new Set(
      others.flatMap((o) => [o.home_team_id, o.away_team_id]),
    );
    const staying =
      g.home_team_id === leaving ? g.away_team_id : g.home_team_id;
    return moving === staying || seen.has(moving);
  };

  for (let i = 0; i < games.length; i++) {
    for (let j = i + 1; j < games.length; j++) {
      for (const a of [games[i].home_team_id, games[i].away_team_id]) {
        for (const b of [games[j].home_team_id, games[j].away_team_id]) {
          if (a === b) continue;
          if (clashes(games[i], a, b)) continue;
          if (clashes(games[j], b, a)) continue;
          return [i, j, nameOf(games[i], a), nameOf(games[j], b)];
        }
      }
    }
  }
  throw new Error("No two teams in this fixture can legally trade places.");
}

async function seedSeason(page: Page) {
  await page.goto("/obhl/seasons");
  const row = page.getByRole("row", { name: new RegExp(SEASON) });
  if ((await row.count()) === 0) {
    await page.getByLabel("Name").fill(SEASON);
    await page.getByLabel("Season starts").fill(FIRST_NIGHT);
    await page.getByLabel("Season ends (incl. playoffs)").fill(SEASON_END);
    await page.getByRole("button", { name: /Create season/i }).click();
    await expect(page).toHaveURL(/\/seasons\/[0-9a-f-]{36}/);
    await page.goto("/obhl/seasons");
    await expect(row).toBeVisible();
  }

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
  await expectGenerateFormUsable(page);
  // ⛔ THE GATE ASKS THE DATABASE, NOT THE PAGE. "No draft schedule" is shown by
  // a season that is fully PUBLISHED and simply has no draft staged — so gating
  // on it re-generated over an already-seeded season, and the publish button
  // then read "Replace published schedule" instead of "Publish N games". The
  // published count is the thing this seed actually cares about.
  if ((await publishedCount()) === 0) {
    await page.getByLabel("First game night").fill(FIRST_NIGHT);
    await page.getByLabel("Games per team").fill("6");
    await page.getByLabel(/Ice-time slots/).fill("19:00, 20:15");
    await page.locator('label:has-text("Tue") input[name="weekdays"]').check();
    await page.locator('label:has-text("Thu") input[name="weekdays"]').check();
    await page.getByRole("button", { name: "Generate schedule" }).click();
    await expect(page.getByText("Balance report")).toBeVisible(AFTER_GENERATE);
    await page.getByRole("button", { name: /Publish \d+ games/ }).click();
    await expect(page.getByText("No draft schedule")).toBeVisible();
  }
}

test.describe("Path 28 — manual schedule edits", () => {
  test.describe.configure({ timeout: 240_000 });

  test.beforeAll(async ({ browser }) => {
    const page = await browser.newPage();
    await signedInAs(page, "Manager");
    await seedSeason(page);
    await page.close();
  });

  test.afterAll(async () => {
    // Hand obhl back to the seeded season — see `14-one-off-game`.
    const db = admin();
    const { data: league } = await db
      .from("leagues")
      .select("id")
      .eq("slug", "obhl")
      .single();
    await db
      .from("seasons")
      .update({ is_active: true })
      .eq("league_id", league!.id)
      .eq("name", "Spring 2026");
    await db
      .from("seasons")
      .update({ is_active: false })
      .eq("league_id", league!.id)
      .eq("name", SEASON);
  });

  test("a manager can trade two games' nights, and both counts survive", async ({
    page,
  }) => {
    const season = await seasonId();
    const before = await counts(season);

    await signedInAs(page, "Manager");
    await page.goto("/obhl/schedule");
    await expect(page.getByText("Change this schedule")).toBeVisible();

    const [i, j] = await tradeablePair(season);
    // ⚠️ Option 0 is the placeholder, so game `k` sits at `k + 1`. And `#tn-y`
    // drops whatever `#tn-x` holds, so for `j > i` that game shifts down one —
    // landing at index `j`.
    await page.locator("#tn-x").selectOption({ index: i + 1 });
    await page.locator("#tn-y").selectOption({ index: j });
    await page.getByRole("button", { name: "Swap their nights" }).click();
    await expect(page.getByText("Nights traded.")).toBeVisible();

    const after = await counts(season);
    expect(after.perTeam).toEqual(before.perTeam);
    expect(after.perNight).toEqual(before.perNight);
  });

  test("a manager can trade teams between two games, and totals survive", async ({
    page,
  }) => {
    const season = await seasonId();
    const before = await counts(season);

    await signedInAs(page, "Manager");
    await page.goto("/obhl/schedule");

    // ⛔ A DETERMINISTIC PAIR, and the success path asserted rather than
    // "either outcome". The old version accepted a refusal too, so it never
    // proved a trade can happen — it would have passed against a feature that
    // refused everything.
    const [gi, gj, outI, outJ] = await tradeableTeams(season);
    await page.locator("#tt-x").selectOption({ index: gi + 1 });
    await page.locator("#tt-outx").selectOption({ label: outI });
    await page.locator("#tt-y").selectOption({ index: gj });
    await page.locator("#tt-outy").selectOption({ label: outJ });
    await page.getByRole("button", { name: "Trade these two" }).click();

    await expect(page.getByText("Traded.")).toBeVisible();

    const after = await counts(season);
    expect(after.perTeam).toEqual(before.perTeam);
    expect(after.perNight).toEqual(before.perNight);
  });

  test("moving a game to another night is refused, and says why", async ({
    page,
  }) => {
    await signedInAs(page, "Manager");
    await page.goto("/obhl/schedule");

    await page.locator("#rg-game").selectOption({ index: 1 });
    const at = await page.locator("#rg-at").inputValue();
    // Same time, one day later — a different night, which only a trade may do.
    const nextDay = new Date(`${at}:00Z`);
    nextDay.setUTCDate(nextDay.getUTCDate() + 1);
    await page.locator("#rg-at").fill(nextDay.toISOString().slice(0, 16));
    await page.getByRole("button", { name: "Move the time" }).click();

    // ⛔ ASSERT THE ACTION'S SENTENCE, NOT THE PANEL'S. The form's static help
    // text reads "Same night only. A different night is a trade, above." — on
    // the page before any click — so the old `/same night/i` matched it and
    // this test passed whether or not the server refused anything.
    await expect(
      page.getByText(/only be moved to another time on the same night/i),
    ).toBeVisible();
  });

  test("the replace wizard refuses a swap with no compensating game", async ({
    page,
  }) => {
    await signedInAs(page, "Manager");
    await page.goto("/obhl/schedule");

    await page.locator("#rt-game").selectOption({ index: 1 });
    await page.locator("#rt-out").selectOption({ index: 1 });
    await page.locator("#rt-in").selectOption({ index: 1 });
    await page.getByRole("button", { name: "Find the swap" }).click();

    // Either it found partners, or it explained why there are none. It must
    // never simply apply a one-sided replacement.
    await expect(
      page
        .getByText("Choose the game where the two teams trade back:")
        .or(page.getByText(/different numbers of games/)),
    ).toBeVisible();
  });

  /**
   * ⛔ THE STATE THAT HID THE WORST BUG IN THIS FEATURE, and that nothing else
   * in the suite creates: a season holding a published schedule AND a staged
   * draft at once — `publishMode`'s "replace".
   *
   * Reading both sets as one broke it in two directions. Every edit was refused,
   * because the same six teams appear on the same nights in both sets and the
   * doubleheader guard saw a collision the manager could not see. And when an
   * edit did pass, the replace wizard could pair a PUBLISHED game with a DRAFT
   * one — leaving each set separately unbalanced while a union-to-union check
   * reported no change at all.
   *
   * The fix scopes every read and write to one side. This test is the proof,
   * and it is why the suite now generates a draft it never publishes.
   */
  test("edits still work with a draft staged over the published schedule", async ({
    page,
  }) => {
    const season = await seasonId();
    await signedInAs(page, "Manager");

    // Stage a draft over the live schedule without publishing it.
    await page.goto("/obhl/schedule-builder");
    await expectGenerateFormUsable(page);
    await page.getByLabel("First game night").fill(FIRST_NIGHT);
    await page.getByLabel("Games per team").fill("6");
    await page.getByLabel(/Ice-time slots/).fill("19:00, 20:15");
    await page.locator('label:has-text("Tue") input[name="weekdays"]').check();
    await page.locator('label:has-text("Thu") input[name="weekdays"]').check();
    await page.getByRole("button", { name: "Generate schedule" }).click();
    await expect(page.getByText("Balance report")).toBeVisible(AFTER_GENERATE);

    const db = admin();
    const { count: drafts } = await db
      .from("games")
      .select("id", { count: "exact", head: true })
      .eq("season_id", season)
      .eq("is_draft", true);
    expect(drafts ?? 0).toBeGreaterThan(0);

    try {
      // A published-side trade must still be offered and still succeed, with
      // the draft sitting right there covering the same nights.
      const before = await counts(season);
      await page.goto("/obhl/schedule");
      const [i, j] = await tradeablePair(season);
      await page.locator("#tn-x").selectOption({ index: i + 1 });
      await page.locator("#tn-y").selectOption({ index: j });
      await page.getByRole("button", { name: "Swap their nights" }).click();
      await expect(page.getByText("Nights traded.")).toBeVisible();

      const after = await counts(season);
      expect(after.perTeam).toEqual(before.perTeam);
      expect(after.perNight).toEqual(before.perNight);
    } finally {
      // Put the fixture back for whatever runs next.
      await page.goto("/obhl/schedule-builder");
      const discard = page.getByRole("button", { name: "Discard draft" });
      if ((await discard.count()) > 0) await discard.click();
      await expect(page.getByText("No draft schedule")).toBeVisible();
    }
  });

  test("a scorekeeper gets no edit panel on the schedule", async ({ page }) => {
    await signedInAs(page, "Scorekeeper");
    await page.goto("/obhl/schedule");
    await expect(page.getByText("Change this schedule")).toHaveCount(0);
  });

  /**
   * ⛔ THE HIDDEN-BUTTON HALF AND THE GUARD HALF ARE DIFFERENT CLAIMS. Hiding a
   * control is not a permission; the action has to refuse too. The user's rule
   * as of 2026-09-07: scorekeepers "can only score games".
   */
  test("a scorekeeper cannot cancel, postpone or reschedule a game", async ({
    page,
  }) => {
    await signedInAs(page, "Scorekeeper");
    await page.goto("/obhl/schedule");
    // ⛔ `exact`, and it is load-bearing. A scorekeeper's own staff nav holds a
    // link called "Score Games", so a loose name match takes that instead and
    // `.first()` clicks the nav — navigating back to this same page, where no
    // scoresheet heading ever appears. `05-scoring` uses `exact` for the same
    // reason.
    const score = page
      .getByRole("link", { name: "Score", exact: true })
      .first();
    await expect(score).toBeVisible();
    await score.click();

    // The scoresheet is still theirs. Waited on by its own heading rather than
    // by a URL pattern: the heading is the thing under test, and it fails with
    // a page snapshot instead of a bare "url never matched".
    await expect(page.getByRole("heading", { name: /@/ })).toBeVisible({
      timeout: 30_000,
    });
    // The schedule-state card is not.
    await expect(
      page.getByRole("heading", { name: "Game status" }),
    ).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Cancel game" })).toHaveCount(
      0,
    );
    await expect(page.getByRole("button", { name: "Postpone" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Reschedule" })).toHaveCount(
      0,
    );
  });
});
