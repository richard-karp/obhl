/**
 * Path 17: Schedule Builder — page structure, the balanced generator, and
 * manager-only access.
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
 * The seeded Fall season's first night, read from the database.
 *
 * ⛔ NEVER RESTATE THIS DATE. It used to be `const FIRST_NIGHT = "2026-09-15"`,
 * which was the seed's own literal — and on 2026-09-16 that season would have
 * STARTED, locking the builder and falsifying this spec's premise. The seed owns
 * the date; a spec that repeats it can disagree with the fixture it runs against.
 */
async function fallStart(): Promise<string> {
  const db = admin();
  const { data: league, error: le } = await db
    .from("leagues")
    .select("id")
    .eq("slug", "obhl")
    .single();
  // ⛔ FAIL BY NAME, LIKE `expectGenerateFormUsable`. `data!.starts_on` on an
  // empty read threw "Cannot read properties of null", which then surfaced as
  // the failure of EVERY test in this file with nothing pointing at the fixture.
  // And scoped to the league: both leagues carry a "Spring 2026", so an
  // unscoped `.single()` breaks the moment a second one reuses "Fall 2026".
  if (le || !league) {
    throw new Error(`Seed has no 'obhl' league: ${le?.message ?? "not found"}`);
  }
  const { data, error } = await db
    .from("seasons")
    .select("starts_on")
    .eq("league_id", league.id)
    .eq("name", "Fall 2026")
    .single();
  if (error || !data) {
    throw new Error(
      `Seed has no Fall 2026 season in obhl — check supabase/seed.sql: ${
        error?.message ?? "not found"
      }`,
    );
  }
  return data.starts_on as string;
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

/**
 * The builder's generate/publish flow only exists on a season that hasn't
 * started. The active season is in the past, so these tests drive Fall 2026
 * through its setup page, which renders the same ScheduleBuilderPanel.
 */
async function goToFallSeasonSetup(page: Page) {
  await page.goto("/obhl/seasons");
  await page
    .getByRole("row", { name: /Fall 2026/ })
    .getByRole("link", { name: "Setup" })
    .click();
  await page.waitForURL(/\/seasons\//);
}

/**
 * Wait for the generate form, and fail IMMEDIATELY and by name if the builder
 * came up in either state that has no form on the page.
 *
 * ⛔ NOT A RETRY, AND NOT A LOOSENED ASSERTION. `publishMode` returns `locked`
 * for TWO reasons, and neither renders a generate form:
 *
 *   - `readFailed` — `getPublishState` fails closed, so any of its six reads
 *     erroring locks the panel and renders "This season's games couldn't be
 *     read". Each read is retried once, so this means two consecutive failures.
 *   - `started` — the season is legitimately under way. Permanent, and it means
 *     this spec is pointed at the wrong season, not that anything broke.
 *
 * A plain `fill()` in either state waits on a locator that can never resolve
 * and reports only "waiting for getByLabel('First game night')" — on CI (run
 * 34055032836) that was a 12-minute `Test timeout of 720000ms exceeded`, which
 * tells the next person nothing about what actually happened.
 *
 * Racing the three locators is what makes the message honest: whichever the
 * page settled on is the one reported, in seconds. Both failures still fail the
 * run — they are real conditions and must not be swallowed — they just say so.
 *
 * ⛔ CALL IT BEFORE ANY GATE THAT READS THE PANEL, not inside the branch the
 * gate picks. Both locked cards make a `count()` probe answer wrongly, so a
 * guard behind one either never runs or runs too late to help.
 *
 * ⚠️ COPIED INTO EACH SPEC THAT NEEDS IT, AND IT HAS TO BE. A shared
 * `e2e/schedule-helpers.ts` was built and measured on 2026-09-06: every
 * relative TypeScript import dies at load with `context.conditions?.includes is
 * not a function`, sibling or not, with or without a `.js` specifier
 * (Playwright 1.61.0, Node 22.18.0). It is not "no module exists yet" and not
 * "only `src` is out of reach" — relative TS imports do not work here at all.
 * Change one copy, change them all; there are five.
 */
async function expectGenerateFormUsable(page: Page) {
  const firstNight = page.getByLabel("First game night");
  const readFailed = page.getByText("This season's games couldn't be read");
  const started = page.getByText("The season is under way");
  await expect(firstNight.or(readFailed).or(started).first()).toBeVisible();

  if (await readFailed.isVisible()) {
    throw new Error(
      "The schedule builder is in its read-failed state: getPublishState " +
        "reported readFailed, so publishMode locked the panel and there is no " +
        "generate form to fill. One of its parallel reads errored — check the " +
        "server log for 'publish state read failed'. The read is retried once " +
        "before it counts, so this state means TWO consecutive failures — a " +
        "persistent fault is likelier here than load.",
    );
  }

  if (await started.isVisible()) {
    throw new Error(
      "The schedule builder is locked because the season has STARTED, so " +
        "there is no generate form to fill. Not transient: a season is started " +
        "once it holds a published, non-draft game whose date has passed. " +
        "Either this spec is pointed at the wrong season, or its fixture " +
        "season has aged into the past — check the dates it seeds.",
    );
  }
}

test("page loads with heading, its season, and the switcher", async ({
  page,
}) => {
  await signedInAs(page, "Manager");
  await page.goto("/obhl/schedule-builder");
  // The heading specifically: the manage nav's link is called "Schedule
  // Builder" too, since `/schedule` is now the games list it used to share a
  // label with.
  await expect(
    page.getByRole("heading", { name: "Schedule Builder" }),
  ).toBeVisible();
  // The description used to read "<season> (active)" and this asserted on the
  // word "active". The builder is no longer pinned to the active season — the
  // switcher beside the heading picks one, and marks in its own options which
  // season the public site is showing — so the page names its season plainly.
  // With no cookie and no `?season=`, that season is still the active one.
  await expect(
    page.getByText(/Spring 2026 · \d+ teams enrolled/),
  ).toBeVisible();
  await expect(page.getByLabel("Select season")).toBeVisible();
});

test("scorekeeper cannot reach /schedule-builder", async ({ page }) => {
  await signedInAs(page, "Scorekeeper");
  await page.goto("/obhl/schedule-builder");
  await expect(page).toHaveURL("/");
});

/**
 * How long an assertion may wait on a generate.
 *
 * `playwright.config.ts` sets a 15s assertion timeout and reasons it from the
 * generator's `OBHL_SLOT_BUDGET_MS` (5s). That is one budget short of what a
 * generate actually spends: `assignNights` runs Phase S at FIVE candidates —
 * 160, 140 on three seeds, then 200 — each on its own budget, so the search
 * alone can reach ~25s before anything renders (SCHEDULE_HANDOFF §5).
 *
 * The gap hid because generate time is hardware-bound: this file's spacing test
 * takes ~3s on a laptop, ~10s on a quiet CI runner, and blew the 15s ceiling on
 * a loaded one. Raising the global timeout instead would slow every genuine
 * failure in the suite by 30s, which the config comment explicitly warns off.
 *
 * Applies ONLY to assertions waiting on a generate. Anything else that needs
 * this long is a bug, not a slow search.
 */
const AFTER_GENERATE = { timeout: 45_000 };

test.describe("Path 17 — Schedule Builder", () => {
  // Two of these tests generate twice, and a generate can be ~25s of search on
  // a slow runner — the 60s default would be the next thing to fail.
  test.describe.configure({ timeout: 150_000 });

  test.beforeEach(async ({ page }) => {
    await signedInAs(page, "Manager");
    await goToFallSeasonSetup(page);
  });

  test("generate form has the length toggle and core fields", async ({
    page,
  }) => {
    await expect(page.getByText("Generate a balanced schedule")).toBeVisible();
    await expect(page.getByLabel("First game night")).toBeVisible();
    await expect(
      page.getByRole("button", { name: "By games per team" }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "By end date" }),
    ).toBeVisible();
    await expect(page.getByLabel("Games per team")).toBeVisible();
    await expect(page.getByLabel(/Ice-time slots/).first()).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Generate schedule" }),
    ).toBeVisible();
  });

  test("length toggle swaps games-per-team for an end date", async ({
    page,
  }) => {
    await expect(page.getByLabel("Games per team")).toBeVisible();
    await page.getByRole("button", { name: "By end date" }).click();
    await expect(page.getByLabel("Last regular-season night")).toBeVisible();
    await expect(page.getByLabel("Games per team")).toHaveCount(0);
  });

  test("weekday checkboxes are all present", async ({ page }) => {
    for (const day of ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]) {
      await expect(page.getByText(day, { exact: true })).toBeVisible();
    }
  });

  test("one-off scheduling has moved off the builder, behind a link", async ({
    page,
  }) => {
    // The builder is pre-season only: draft → review → publish. Scheduling a
    // one-off is a mid-season edit to published games and lives on its own page.
    await expect(
      page.getByText("Schedule a one-off game (tournament final / semifinals)"),
    ).toHaveCount(0);
    await expect(
      page.getByRole("link", { name: "Schedule a one-off game" }),
    ).toBeVisible();
  });

  test("empty draft state shows before a draft is generated", async ({
    page,
  }) => {
    await expect(page.getByText("No draft schedule")).toBeVisible();
  });

  test("generates a balanced draft with equal games per team", async ({
    page,
  }) => {
    // These tests drive the Fall season, not the active one — start on its
    // first night, which `fallStart()` reads from the seed rather than restating. A date outside the window still
    // generates (drafts aren't bounded by the season start), so this reads as
    // passing while drafting a schedule months before the season it belongs to.

    await expectGenerateFormUsable(page);
    await page.getByLabel("First game night").fill(await fallStart());
    await page.getByLabel("Games per team").fill("4");
    // Two game nights so weekday balance is exercised.
    await page.locator('label:has-text("Tue") input[name="weekdays"]').check();
    await page.locator('label:has-text("Thu") input[name="weekdays"]').check();

    await page.getByRole("button", { name: "Generate schedule" }).click();

    // Draft preview appears: balance report and a Publish button.
    await expect(page.getByText("Balance report")).toBeVisible(AFTER_GENERATE);
    await expect(
      page.getByRole("button", { name: /Publish \d+ games/ }),
    ).toBeVisible();

    // Every team's GP cell should read 4 (equal games per team). Scoped to the
    // Balance report card: the season setup page also has a team roster table
    // above it, and an unscoped `tbody tr` selector would match both.
    const balanceReportCard = page
      .locator('[data-slot="card"]')
      .filter({ hasText: "Balance report" });
    const gpCells = balanceReportCard.locator("tbody tr td:nth-child(2)");
    const count = await gpCells.count();
    expect(count).toBeGreaterThan(1);
    for (let i = 0; i < count; i++) {
      await expect(gpCells.nth(i)).toHaveText("4");
    }

    // Clean up so later runs still see the empty-draft state.
    await page.getByRole("button", { name: "Discard draft" }).click();
    await expect(page.getByText("No draft schedule")).toBeVisible();
  });

  /**
   * The manager-facing half of schedule variations.
   *
   * Generation is deterministic for a given input — deliberately — so before
   * this button existed, a manager who disliked a schedule and pressed Generate
   * again got the byte-identical one back forever, and reaching for a manager
   * request instead switched the ice-time clustering pass off entirely.
   *
   * ⛔ Asserts on the rendered GAME LIST, not on the balance report. Every
   * variation is equally balanced by construction, so the balance report is
   * identical across all of them and an assertion there would pass against a
   * button that did nothing at all.
   *
   * Longer timeout than `AFTER_GENERATE`: this runs two full generates, and
   * under 80 games each one is a best-of-four.
   */
  test("Try a different schedule returns a different schedule", async ({
    page,
  }) => {
    test.setTimeout(300_000);
    await expectGenerateFormUsable(page);
    await page.getByLabel("First game night").fill(await fallStart());
    // ⛔ 12, NOT the 4 the other generate tests use. A TIGHT season has exactly
    // one arrangement that meets every goal and every variation converges on it,
    // so the button correctly returns the same schedule and this test cannot
    // tell that from a button that does nothing. Measured 2026-09-09 on this
    // shape — 6 teams, Tue+Thu, 3 sheets: at 4 games a team all four variations
    // are byte-identical, at 8 there are 3 distinct, at 12 there are 4.
    await page.getByLabel("Games per team").fill("12");
    await page.locator('label:has-text("Tue") input[name="weekdays"]').check();
    await page.locator('label:has-text("Thu") input[name="weekdays"]').check();

    await page.getByRole("button", { name: "Generate schedule" }).click();
    await expect(page.getByText("Balance report")).toBeVisible(AFTER_GENERATE);

    /**
     * The whole draft as one string, ice times included.
     *
     * ⛔ NOT the game picker's option text. Those read "Ducks @ Hawks —
     * September 22, 2026" — teams and DATE, no time — so a variation that moves
     * teams between ice times on the same night is invisible to it, and this
     * test passed against a working button for exactly that reason. `#rg-at` is
     * a datetime-local populated from the picked game's `localAt`, so selecting
     * each game in turn reads the time the manager actually cares about. All
     * client-side; no server round trip per game.
     */
    const draftSignature = async () => {
      const opts = await page
        .locator("#rg-game option")
        .evaluateAll((os) =>
          os
            .map((o) => ({
              value: (o as HTMLOptionElement).value,
              label: (o as HTMLOptionElement).textContent ?? "",
            }))
            .filter((o) => o.value),
        );
      const out: string[] = [];
      for (const o of opts) {
        await page.selectOption("#rg-game", o.value);
        // ⛔ BOTH HALVES, PAIRED. The label carries teams and date but no time;
        // `#rg-at` carries date and time but no teams. Either alone describes
        // only the CALENDAR — every schedule over these nights fills the same
        // twelve (date, ice time) cells and plays the same twelve pairings — so
        // either alone is identical across variations and passes against a
        // button that changed the schedule completely. Both were written that
        // way first, and both did.
        out.push(`${o.label}#${await page.inputValue("#rg-at")}`);
      }
      return out.join("|");
    };
    const before = await draftSignature();
    expect(before.length).toBeGreaterThan(20);

    await page
      .getByRole("button", { name: "Try a different schedule" })
      .click();

    // Proves the click actually dispatched a generate. Without this step a
    // button that does nothing at all fails below as "schedule unchanged",
    // which reads like a generator problem and is not one.
    await expect(
      page.getByRole("button", { name: "Generating…" }),
    ).toBeVisible({ timeout: 20_000 });
    // Completion. Waiting on "Balance report" instead would return instantly —
    // that card is already on screen from the first generate.
    await expect(
      page.getByRole("button", { name: "Generate schedule" }),
    ).toBeVisible({ timeout: 240_000 });

    expect(await draftSignature()).not.toBe(before);

    await page.getByRole("button", { name: "Discard draft" }).click();
    await expect(page.getByText("No draft schedule")).toBeVisible();
  });

  test("a generate reports its result instead of finishing in silence", async ({
    page,
  }) => {
    // The *result*, not the progress bar. This fixture is sparse and generates
    // in about 0.4 s, so asserting the bar would race its own disappearance —
    // the bar is verified by eye against a full season, where the run takes
    // ~26 s. What is covered here is the half that used to be missing
    // entirely: generateSchedule returned void, so a refusal and a slow run
    // were indistinguishable.

    await expectGenerateFormUsable(page);
    await page.getByLabel("First game night").fill(await fallStart());
    await page.getByLabel("Games per team").fill("4");
    await page.locator('label:has-text("Tue") input[name="weekdays"]').check();
    await page.locator('label:has-text("Thu") input[name="weekdays"]').check();
    await page.getByRole("button", { name: "Generate schedule" }).click();

    await expect(
      page.getByText(/Generated a \d+-game draft schedule/),
    ).toBeVisible(AFTER_GENERATE);

    await page.getByRole("button", { name: "Discard draft" }).click();
    await expect(page.getByText("No draft schedule")).toBeVisible();
  });

  test("a generate with no game nights says so rather than doing nothing", async ({
    page,
  }) => {
    // The refusal this feature exists for. With no weekday checked the action
    // bails before it touches the database; before it returned a state, the
    // button simply went back to idle and the manager was left guessing
    // whether the generator had run and failed or never started.

    await expectGenerateFormUsable(page);
    await page.getByLabel("First game night").fill(await fallStart());
    await page.getByLabel("Games per team").fill("4");

    await page.getByRole("button", { name: "Generate schedule" }).click();

    await expect(
      page.getByText("Pick at least one game night of the week."),
    ).toBeVisible();
    // And nothing was generated.
    await expect(page.getByText("No draft schedule")).toBeVisible();
  });

  test("the first-game-night field is bounded below by today", async ({
    page,
  }) => {
    // The browser half of the past-date guard. Bounded in the LEAGUE's zone,
    // not the browser's: server-UTC runs up to five hours ahead of Eastern, so
    // a UTC bound would refuse a same-day generate every evening after 7pm.
    const leagueToday = new Intl.DateTimeFormat("en-CA", {
      timeZone: "America/New_York",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(new Date());

    await expectGenerateFormUsable(page);
    await expect(page.getByLabel("First game night")).toHaveAttribute(
      "min",
      leagueToday,
    );
  });

  test("a past first game night is refused by the server, not just the browser", async ({
    page,
  }) => {
    // ⛔ THE IRREVERSIBLE ONE. `season_is_started` counts only published games,
    // so a past-dated DRAFT is invisible to the lock and looks completely fine
    // — until it is published, at which point generate, replace and remove all
    // refuse permanently. There is no undo, which is why this is refused at
    // GENERATE rather than at publish.
    //
    // The `min` attribute above is stripped first, deliberately: it is
    // browser-side and a client can drop it, so what is under test here is the
    // half that cannot be bypassed. Without the server check this generates a
    // draft and reports success.

    await expectGenerateFormUsable(page);
    await page
      .getByLabel("First game night")
      .evaluate((el) => el.removeAttribute("min"));

    await page.getByLabel("First game night").fill("2020-01-06");
    await page.getByLabel("Games per team").fill("4");
    await page.locator('label:has-text("Tue") input[name="weekdays"]').check();
    await page.locator('label:has-text("Thu") input[name="weekdays"]').check();

    await page.getByRole("button", { name: "Generate schedule" }).click();

    await expect(
      page.getByText(
        "That first game night has already passed — pick tonight or a later date.",
      ),
    ).toBeVisible();
    // And nothing was drafted — the refusal is before any write.
    await expect(page.getByText("No draft schedule")).toBeVisible();
  });

  test("spacing checks report every goal the generator models", async ({
    page,
  }) => {
    // The generator models four goals the panel is the only place a manager can
    // see. They are computed server-side per draft, so nothing below asserts a
    // *value* — a four-game fixture is not the reference season and its numbers
    // are its own. What is asserted is that each check reaches the screen, which
    // is what nothing covered before.

    await expectGenerateFormUsable(page);
    await page.getByLabel("First game night").fill(await fallStart());
    await page.getByLabel("Games per team").fill("4");
    await page.locator('label:has-text("Tue") input[name="weekdays"]').check();
    await page.locator('label:has-text("Thu") input[name="weekdays"]').check();
    await page.getByRole("button", { name: "Generate schedule" }).click();
    await expect(page.getByText("Balance report")).toBeVisible(AFTER_GENERATE);

    await expect(page.getByText("Spacing checks")).toBeVisible();
    for (const label of [
      "Teams byeing back-to-back game nights",
      "Matchups off an even weekday split",
      "Uneven ice time within a night of the week",
      "Three games in a row in one ice time",
    ]) {
      await expect(page.getByText(label, { exact: true })).toBeVisible();
    }

    // The clustering figure is NOT in the tick list above: at fewer than three
    // ice times a five-game window must hold three of one, so it cannot reach
    // zero and a tick would be a target no arrangement can hit. It has its own
    // caption instead, next to `longestLayoffDays`, which is the existing
    // precedent for a number worth showing whose zero is not the goal.
    //
    // Asserts the NUMBER, not just the words: if the field stopped arriving,
    // React renders `undefined` as nothing and the sentence still reads fine
    // with a gap where the figure should be.
    //
    // ⚠️ What it does NOT catch, measured 2026-09-10 rather than assumed: the
    // caption wired to a different REAL field. This fixture is four games a
    // team, so `slotClusterWorstTeam`, `slotStreak3` and `slotConsecutive` all
    // read 0 and all render the same sentence. Pointing it at a nonexistent
    // field fails here; pointing it at `slotStreak3` passes. Distinguishing
    // them needs a fixture long enough for the metrics to diverge, which this
    // spec's generate is not.
    await expect(
      page.getByText(/Worst team.s repeated ice times:\s*\d+\s+stretch/),
    ).toBeVisible();

    // No assertion here on what "Matchups off an even weekday split" *reads*.
    // The row once showed `pairingWeekdayExcess`, a summed squared deviation —
    // 8 where two matchups were off, and 3.7872 on a season whose weekday night
    // counts do not divide evenly — and a guard against that regressing belongs
    // where it can bite. It cannot bite here: a fixture this small reaches a
    // perfect split, so the score and the count are both 0 and both render as a
    // tick. Tried it, reverted the row to the score, and this test still passed.
    // The real guard is `spacingReport — pairingsOffWeekdaySplit` in
    // `spacing.test.ts`, which builds the uneven cadence that separates them.

    // Informational, and deliberately not a check: it has no zero to reach, so
    // it sits outside the tick list with its own explanation.
    await expect(
      page.getByText(/Longest stretch without a game/),
    ).toBeVisible();

    await page.getByRole("button", { name: "Discard draft" }).click();
    await expect(page.getByText("No draft schedule")).toBeVisible();
  });

  test("republishing replaces the schedule instead of stacking a second one", async ({
    page,
  }) => {
    // The reported bug: generate + publish twice left the season holding two
    // complete overlapping schedules, both live in the exports and standings.
    const generate = async () => {
      await expectGenerateFormUsable(page);
      await page.getByLabel("First game night").fill(await fallStart());
      await page.getByLabel("Games per team").fill("4");
      await page
        .locator('label:has-text("Tue") input[name="weekdays"]')
        .check();
      await page
        .locator('label:has-text("Thu") input[name="weekdays"]')
        .check();
      await page.getByRole("button", { name: "Generate schedule" }).click();
    };

    await generate();
    const publishButton = page.getByRole("button", {
      name: /Publish \d+ games/,
    });
    await expect(publishButton).toBeVisible(AFTER_GENERATE);
    const published = Number(
      (await publishButton.textContent())!.match(/\d+/)![0],
    );
    await publishButton.click();

    // Rendered state, not the toast — the toast auto-dismisses.
    await expect(page.getByText(`Published: ${published} games`)).toBeVisible();

    // The published state has to say how to change the schedule. Without this
    // line the page is a count plus an empty state that says "Generate one
    // above to preview it here before publishing" — neither of which tells a
    // manager that generating a draft is the precondition for replacing.
    await expect(
      page.getByText(/To change the schedule, generate a new one above/),
    ).toBeVisible();

    // Second pass — the button must offer a replace, not another publish.
    await generate();
    await expect(
      page.getByRole("button", { name: "Replace published schedule" }),
    ).toBeVisible(AFTER_GENERATE);
    await expect(
      page.getByRole("button", { name: /Publish \d+ games/ }),
    ).toHaveCount(0);

    // The live schedule stays visible in replace mode. It used to be suppressed
    // here, leaving the button label as the only evidence on the page that a
    // published schedule existed at all — on the screen that deletes it.
    await expect(page.getByText(`Published: ${published} games`)).toBeVisible();

    await page
      .getByRole("button", { name: "Replace published schedule" })
      .click();
    await expect(
      page.getByText("Replace the published schedule?"),
    ).toBeVisible();
    await expect(
      page.getByText(`This deletes ${published} live games`),
    ).toBeVisible();
    // The range is how a manager verifies *which* schedule is about to go, so
    // it's in the same long form as the rest of the panel rather than the raw
    // ISO dates this dialog used to show. Asserted by shape, and always
    // together with the sentence around it — a bare date also appears in the
    // page header and on every night heading behind the dialog. Matching the
    // literal formatted date instead would pin this test to both the fixture's
    // start date and formatLongDate's exact output.
    await expect(
      page.getByText(/This deletes \d+ live games \(.+ – .+\)/),
    ).toBeVisible();
    await expect(
      page.getByText(/This deletes \d+ live games \(\d{4}-\d{2}-\d{2}/),
    ).toHaveCount(0);
    await page.getByRole("button", { name: "Replace", exact: true }).click();

    // One schedule's worth, not two. The draft is consumed, so the page falls
    // back to "published" mode with the same count it had before.
    await expect(page.getByText(`Published: ${published} games`)).toBeVisible();
    await expect(page.getByText("No draft schedule")).toBeVisible();
  });

  test("a started season locks the builder", async ({ page }) => {
    // The active Spring 2026 season is in the past, so it has started.
    await page.goto("/obhl/schedule-builder");
    await expect(page.getByText("The season is under way")).toBeVisible();
    await expect(page.getByText("Generate a balanced schedule")).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: "Generate schedule" }),
    ).toHaveCount(0);
    // Removal is gated behind the same mode, so it must be absent here too.
    await expect(
      page.getByRole("button", { name: "Remove published schedule" }),
    ).toHaveCount(0);
  });

  test("removing a published schedule leaves the season with no games", async ({
    page,
  }) => {
    // Order-independent on purpose. Playwright runs this file with workers: 1,
    // so the republish test above normally leaves Fall 2026 already published
    // and this branch does not run — but the test then still works under `-g`
    // in isolation, or if the tests above are reordered.
    // Wait for the panel to have rendered before probing. `count()` resolves
    // immediately, so probing first can read 0 on a season that *is* published
    // and send this down the publish branch — where the button reads "Replace
    // published schedule" and the publish click times out instead.
    // ⛔ Before the probe below, not inside the branch it picks. Neither of
    // those two texts renders in the read-failed state, so a read failure
    // would fail on the probe naming only the locator — and if it got past,
    // `count()` of 0 sends this down the publish branch on a season that may
    // well be published. Fail here, by name, instead.
    await expectGenerateFormUsable(page);
    await expect(
      page.getByText(/Published: \d+ games|No draft schedule/).first(),
    ).toBeVisible();

    const removeButton = page.getByRole("button", {
      name: "Remove published schedule",
    });
    if ((await removeButton.count()) === 0) {
      await page.getByLabel("First game night").fill(await fallStart());
      await page.getByLabel("Games per team").fill("4");
      await page
        .locator('label:has-text("Tue") input[name="weekdays"]')
        .check();
      await page
        .locator('label:has-text("Thu") input[name="weekdays"]')
        .check();
      await page.getByRole("button", { name: "Generate schedule" }).click();
      // ⛔ The generate has to LAND before this button can be clicked — it does
      // not exist until the draft renders. Without this wait the click's own
      // actionability wait covers the whole search, which `actionTimeout`
      // (playwright.config.ts) now caps at 20s — under the ~25s Phase S can
      // spend on a loaded runner, and the only reason it never fired is that
      // this branch is skipped whenever the test above it ran first. Every
      // other generate site in the suite waits like this; this one didn't.
      const publish = page.getByRole("button", { name: /Publish \d+ games/ });
      await expect(publish).toBeVisible(AFTER_GENERATE);
      await publish.click();
    }

    await expect(removeButton).toBeVisible();

    await removeButton.click();
    await expect(
      page.getByText("Remove the published schedule?"),
    ).toBeVisible();
    // Asserted by shape. The dialog deliberately carries no game count — a
    // pre-start removal destroys nothing that can't be regenerated — so there
    // is no number here to pin the test to.
    await expect(
      page.getByText(/The season will have no games until you generate/),
    ).toBeVisible();
    // `exact` matters: without it this also matches the "Remove published
    // schedule" trigger behind the dialog.
    await page.getByRole("button", { name: "Remove", exact: true }).click();

    // Back to zero. All three assertions are needed: the count going away shows
    // the games are gone, the control going away shows the mode moved, and the
    // empty state shows the panel recovered rather than rendering nothing.
    await expect(page.getByText(/Published: \d+ games/)).toHaveCount(0);
    await expect(removeButton).toHaveCount(0);
    await expect(page.getByText("No draft schedule")).toBeVisible();
  });
});
