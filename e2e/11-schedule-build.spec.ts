/** Building a season's schedule: generate, publish, replace and remove, a manager request, and a draft that aged. */
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

type Role =
  | "Manager"
  | "Scorekeeper"
  | "Captain"
  | "One-league mgr"
  | "One-league scorer"
  | "No-league mgr"
  | "Commissioner"
  | "Deputy";

/** Dev-panel sign-in. A scorekeeper lands on `/tonight`, everyone else on the picker. */
async function signInAs(page: Page, role: Role, then?: string) {
  await page.goto("/login");
  await page.getByRole("button", { name: role, exact: true }).click();
  await page.waitForURL(
    role === "Scorekeeper" || role === "One-league scorer" ? "/tonight" : "/",
  );
  if (then) await page.goto(then);
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

test("scorekeeper cannot reach /schedule-builder", async ({ page }) => {
  await signInAs(page, "Scorekeeper", "/obhl/dashboard");
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
    await signInAs(page, "Manager", "/obhl/dashboard");
    await goToFallSeasonSetup(page);
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

/**
 * Path 24: Manager schedule constraints — telling the generator what to do,
 * and being told what it could not do.
 *
 * Driven through Fall 2026's setup page for the same reason `11-schedule-build`
 * is: the generate flow only exists on a season that has not started, and the
 * active season is in the past. Both pages render the same
 * `ScheduleBuilderPanel`, so the card under test is identical either way.
 */

/**
 * The second Tuesday of the generated window — the first night's date plus
 * seven days.
 *
 * ⛔ COMPUTED, NOT PINNED. This used to be the literal `"2026-09-22"`, which
 * only worked because the old `FIRST_NIGHT` was the literal `"2026-09-15"` —
 * exactly a week earlier and also a Tuesday. `fallStart()` is guaranteed a
 * Tuesday (SCHEDULE_HANDOFF), so a week after it is always a Tuesday too, but
 * the calendar date itself moves with the clock. A test that names a slot_on
 * request by an absolute date has to derive that date from the same anchor
 * the generate form uses, or the request lands outside the generated season.
 */
async function secondTuesday(): Promise<string> {
  const d = new Date(`${await fallStart()}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 7);
  return d.toISOString().slice(0, 10);
}

/** Pick the first real team in the constraints card's picker, and return its name. */
async function firstTeamName(page: Page): Promise<string> {
  const select = page.getByLabel("Team", { exact: true });
  const value = await select.locator("option").nth(1).getAttribute("value");
  const name = (await select.locator("option").nth(1).textContent())!.trim();
  await select.selectOption(value!);
  return name;
}

/**
 * The listed requests, and ONLY those.
 *
 * ⛔ Never assert a request's description against the whole page. The card
 * lists it AND sonner toasts it ("Added: <description>."), so a bare
 * `getByText(description)` is a strict-mode violation the moment an add
 * succeeds — the assertion fails precisely when the thing it checks worked.
 */
function requestList(page: Page) {
  return page
    .locator("li")
    .filter({ has: page.getByRole("button", { name: /^Remove request:/ }) });
}

/**
 * The preview's "Manager requests" card — the one that reports whether each
 * request landed.
 *
 * ⛔ NOT `[data-slot="card"]` filtered on the text "Manager requests". The
 * constraints card inside the generate form is headed "Manager requests
 * (optional)", and it lives inside a Card of its own, so that filter always
 * matches TWO elements: the outcome card can never be asserted absent, and
 * asserting it present is a strict-mode violation. Match the card TITLE
 * exactly, which only the outcome card has.
 */
function outcomeCard(page: Page) {
  // `:scope >` pins the card whose OWN header carries the title. Without it the
  // filter also matches every enclosing Card — the builder panel nests them —
  // and a 2-element match makes `toBeVisible` a strict-mode violation.
  return page.locator('[data-slot="card"]').filter({
    has: page.locator(':scope > [data-slot="card-header"]', {
      hasText: /^Manager requests$/,
    }),
  });
}

/**
 * Remove every request currently listed, so the suite can re-run from clean.
 *
 * ⛔ THE LIST SHRINKING IS THE SIGNAL, NOT THE TOAST. Waiting on
 * "Removed that request." looks right and is a trap: sonner stacks and lingers,
 * so on the second pass the toast from the FIRST removal is still on screen and
 * the assertion returns instantly. The loop then clicks the next ✕ while the
 * previous transition still has every remove button disabled and the re-render
 * is detaching them — "element is not enabled", "element was detached", and a
 * 150 s timeout inside afterEach that reads as if the page had hung.
 */
async function clearRequests(page: Page) {
  for (;;) {
    const rows = requestList(page);
    const before = await rows.count();
    if (before === 0) break;
    await rows
      .first()
      .getByRole("button", { name: /^Remove request:/ })
      .click();
    await expect(rows).toHaveCount(before - 1);
  }
}

test.describe("Path 24 — schedule constraints", () => {
  // A generate can be ~25 s of search, and two of these run one.
  test.describe.configure({ timeout: 150_000 });

  test.beforeEach(async ({ page }) => {
    await signInAs(page, "Manager", "/obhl/dashboard");
    await goToFallSeasonSetup(page);
    // ⛔ HERE, not before each `fill` further down. The constraints card and
    // its team select are INSIDE the generate form, so `firstTeamName` touches
    // the panel too — a guard placed after it never runs, because the select is
    // the locator that has already timed out. Guarding from one place also
    // covers the tests that only read the card.
    await expectGenerateFormUsable(page);
  });

  test.afterEach(async ({ page }) => {
    await clearRequests(page);
  });

  /**
   * ⛔ `slot_on`, NOT `bye_on`, AND THE SEEDED LEAGUE IS WHY.
   *
   * Six teams over the default three sheets is three games a night, so all six
   * play every night and the season has NO BYE BUDGET AT ALL — every bye
   * request is correctly refused by `refuteConstraints` on arithmetic, and no
   * assertion here can make one land. Dropping to two sheets creates byes but
   * walks into the other wall: `planByParticipation` returns null at six teams
   * on two sheets even with nothing constrained, so the fallback planner ships
   * and every request is reported unmet. Both limits are measured on the
   * rank-off note in `assignNights.ts`.
   *
   * `play_on`, `slot_on` and `slot_bias` all work on this shape. `slot_on` is
   * the one worth driving: it is the kind that has to survive BOTH phases —
   * Phase P forcing the play night, Phase S pinning the ice time — and it is
   * read back off the placed games rather than off what either was asked to do.
   */
  test("a honoured request shows as met on the preview", async ({ page }) => {
    const name = await firstTeamName(page);
    const requestDate = await secondTuesday();
    await page.getByLabel("Request", { exact: true }).selectOption("slot_on");
    await page.getByLabel("Date", { exact: true }).fill(requestDate);
    // ⚠️ THE LATEST DEFAULT SLOT, and it must stay in step with the form's
    // `slot_times` default — this test does not fill that field, so it inherits
    // it. Pinned to 21:30 until 2026-09-11, when the default became
    // 19:00 / 20:20 / 21:40; a request naming a time the season does not run is
    // unsatisfiable, so the row came back ✗ and the tick assertion below failed.
    await page.getByLabel("Ice time").fill("21:40");
    await page.getByRole("button", { name: "Add request" }).click();
    const description = `${name} plays at 21:40 on ${requestDate}`;
    await expect(
      requestList(page).filter({ hasText: description }),
    ).toBeVisible();

    await page.getByLabel("First game night").fill(await fallStart());
    await page.getByLabel("Games per team").fill("4");
    await page.locator('label:has-text("Tue") input[name="weekdays"]').check();
    await page.locator('label:has-text("Thu") input[name="weekdays"]').check();
    await page.getByRole("button", { name: "Generate schedule" }).click();

    await expect(page.getByText("Balance report")).toBeVisible(AFTER_GENERATE);

    // ⛔ ASSERT THE TICK, not merely that the request is listed. Listing it
    // proves nothing — an unmet request is listed too, with a ✗ — and this test
    // spent its whole life passing over one.
    const row = outcomeCard(page)
      .locator("li")
      .filter({ hasText: description });
    await expect(row).toBeVisible();
    await expect(row).toContainText("✓");

    // The card is derived from the placed draft, not from what the generator
    // was asked to do — so it is still right after a reload.
    await page.reload();
    await expect(
      outcomeCard(page).locator("li").filter({ hasText: description }),
    ).toContainText("✓");

    await page.getByRole("button", { name: "Discard draft" }).click();
    await expect(page.getByText("No draft schedule")).toBeVisible();
  });
});

/**
 * Path 26: what the generate form does with what it was told.
 *
 * Two opposite requirements, which is why they share a spec: **generate is
 * iterative** — a manager regenerates repeatedly, changing one field — so it
 * must keep every field it was given; **publish is terminal**, so it returns the
 * form to defaults and clears the season's stored manager requests.
 *
 * Driven through Fall 2026's setup page for the same reason `11-schedule-build`
 * is: the generate flow only exists on a season that has not started, and the
 * active season is in the past. Both pages render the same
 * `ScheduleBuilderPanel`.
 */

/** Non-default ice times, so "still what I typed" cannot pass by accident. */
const SLOT_TIMES = "18:45, 20:00";

/**
 * A Thursday inside the season, skipped — far enough out not to starve it.
 *
 * ⛔ COMPUTED, BECAUSE "24" WAS ONLY A THURSDAY IN 2026. This is a day-of-month
 * typed into a date picker, and the test's meaning depends on the weekday it
 * lands on, not on the number.
 */
async function skipDate(): Promise<Date> {
  const start = new Date(`${await fallStart()}T12:00:00Z`);
  const d = new Date(start);
  d.setUTCDate(d.getUTCDate() + 14); // well inside the window
  while (d.getUTCDay() !== 4) d.setUTCDate(d.getUTCDate() + 1); // 4 = Thursday
  return d;
}

async function skipDay(): Promise<string> {
  return String((await skipDate()).getUTCDate());
}

const MONTH_ABBR = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

/**
 * The "Month Day" chip the calendar renders for `skipDate()` (e.g. "Oct 8") —
 * matches `shortLabel()` in `schedule-generate-form.tsx`, which formats with
 * `{ month: "short", day: "numeric" }`.
 *
 * ⛔ COMPUTED FOR THE SAME REASON `skipDay` IS. The old literal "Sep 24" baked
 * in both the day AND the month; walking 14+ days to the next Thursday from a
 * moving anchor can land in a different month than the season's first night.
 */
async function skipChip(): Promise<string> {
  const d = await skipDate();
  return `${MONTH_ABBR[d.getUTCMonth()]} ${d.getUTCDate()}`;
}

/**
 * How many months after the season's first night `skipDate()` falls.
 *
 * ⛔ NEEDED BECAUSE THE PICKER OPENS ON THE FIRST NIGHT'S MONTH. The "Pick
 * dates" popover's calendar (`schedule-generate-form.tsx`) sets
 * `defaultMonth={parseKey(seasonStart)}` and shows one month at a time. If
 * `skipDate()` crosses into a later month, its day-of-month number belongs to
 * a day that ISN'T rendered yet — the calendar has to be advanced first, or a
 * same-numbered day in the wrong (visible) month gets clicked instead.
 */
async function skipMonthsAhead(): Promise<number> {
  const start = new Date(`${await fallStart()}T12:00:00Z`);
  const target = await skipDate();
  return (
    (target.getUTCFullYear() - start.getUTCFullYear()) * 12 +
    (target.getUTCMonth() - start.getUTCMonth())
  );
}

/**
 * A date inside the season, a week after its first night — used only to give
 * a `slot_on` request a valid date; nothing here checks which weekday it
 * lands on.
 *
 * ⛔ COMPUTED FOR THE SAME REASON `secondTuesday()` is, above. This used to be
 * the literal `"2026-09-22"`, a week after the old fixed `FIRST_NIGHT`. With a
 * moving anchor that literal can land before the season even starts.
 */
async function aWeekIntoSeason(): Promise<string> {
  const d = new Date(`${await fallStart()}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 7);
  return d.toISOString().slice(0, 10);
}

/** Fill every field on the generate form with something that is not its default. */
async function fillEverything(page: Page) {
  // Same hazard as `14-schedule-changes`'s repair seeding: with the builder
  // locked by a failed read there is no form here at all, and a bare `fill`
  // waits out the whole test budget saying only "waiting for getByLabel".
  await expectGenerateFormUsable(page);
  await page.getByLabel("First game night").fill(await fallStart());
  await page.getByLabel("Games per team").fill("4");
  await page.getByLabel(/Ice-time slots/).fill(SLOT_TIMES);
  await page.locator('label:has-text("Tue") input[name="weekdays"]').check();
  await page.locator('label:has-text("Thu") input[name="weekdays"]').check();

  // The skip chips are React state, not an input — the discriminator the
  // reproduction turns on. If these survive a generate and the inputs above do
  // not, the cause is React's form reset rather than a remount.
  await page.getByRole("button", { name: "Pick dates" }).click();
  const popover = page.locator('[data-slot="popover-content"]');
  // The popover opens on the first night's month — advance it if the skipped
  // Thursday landed in a later one.
  const monthsAhead = await skipMonthsAhead();
  for (let i = 0; i < monthsAhead; i++) {
    await popover.getByRole("button", { name: "Go to the Next Month" }).click();
  }
  // ⛔ EXCLUDE THE OUTSIDE DAYS, OR `.first()` CLICKS THE WRONG MONTH. The
  // calendar renders with `showOutsideDays` (the default in
  // `components/ui/calendar.tsx`), so the previous month's tail days appear as
  // gridcells BEFORE this month's own — and they carry day numbers in the high
  // twenties, exactly where a skipped Thursday can land. When the numbers
  // coincide, `.first()` picks the previous month's cell, which is `disabled`
  // (it is before the season start) and the click times out. Measured
  // 2026-09-07 against a fixture anchored to 2026-10-13: 3 tests failed with
  // "element is not enabled". It would have started happening on its own on
  // 2026-09-28, and on 105 of the following 800 days.
  await popover
    .locator('[role="gridcell"]:not([data-outside]) button')
    .filter({ hasText: new RegExp(`^${await skipDay()}$`) })
    .first()
    .click();
  await popover.getByRole("button", { name: "Add", exact: true }).click();
  await page.keyboard.press("Escape");
  await expect(page.getByText(await skipChip())).toBeVisible();
}

test.describe("Path 26 — the generate form's state", () => {
  // A generate can be ~25 s of search, and every test here runs one.
  test.describe.configure({ timeout: 150_000 });

  test.beforeEach(async ({ page }) => {
    await signInAs(page, "Manager", "/obhl/dashboard");
    await goToFallSeasonSetup(page);
  });

  test("a publish returns the form to defaults and clears the stored requests", async ({
    page,
  }) => {
    // A request to be cleared. `slot_on` for the reason above: this seeded
    // league has no bye budget at all.
    const teamSelect = page.getByLabel("Team", { exact: true });
    const teamValue = await teamSelect
      .locator("option")
      .nth(1)
      .getAttribute("value");
    await teamSelect.selectOption(teamValue!);
    await page.getByLabel("Request", { exact: true }).selectOption("slot_on");
    await page
      .getByLabel("Date", { exact: true })
      .fill(await aWeekIntoSeason());
    await page.getByLabel("Ice time").fill("20:00");
    await page.getByRole("button", { name: "Add request" }).click();
    await expect(requestList(page)).toHaveCount(1);

    await fillEverything(page);
    await page.getByRole("button", { name: "Generate schedule" }).click();
    await expect(page.getByText("Balance report")).toBeVisible(AFTER_GENERATE);

    await page.getByRole("button", { name: /^Publish/ }).click();
    // ⛔ The page, not the toast. A successful publish takes `draftCount` to 0,
    // and PublishControls is keyed on it — so it remounts, and its success toast
    // races that remount and often never renders at all. The live count is the
    // durable evidence.
    await expect(page.getByText(/^Published: \d+ games$/)).toBeVisible(
      AFTER_GENERATE,
    );

    // Everything back to its default: the chips gone, the ice times back to the
    // seeded three, the weekdays unchecked.
    await expect(page.getByText(await skipChip())).toHaveCount(0);
    await expect(page.getByLabel(/Ice-time slots/)).toHaveValue(
      "19:00, 20:20, 21:40",
    );
    await expect(
      page.locator('label:has-text("Tue") input[name="weekdays"]'),
    ).not.toBeChecked();

    // Server state, not form state: the rows are gone from the season.
    await expect(requestList(page)).toHaveCount(0);
    await page.reload();
    await expect(requestList(page)).toHaveCount(0);

    // ⛔ Put the fixture back. Fall 2026 is the season every schedule spec
    // generates against, and leaving it with a live schedule turns the builder's
    // mode from `published` to `replace` for the next run of `11` and `23`.
    // Removed through the app, not SQL — the seed's guards are the point.
    await page
      .getByRole("button", { name: "Remove published schedule" })
      .click();
    await page
      .getByRole("dialog")
      .getByRole("button", { name: "Remove", exact: true })
      .click();
    await expect(page.getByText(/^Published: \d+ games$/)).toHaveCount(
      0,
      AFTER_GENERATE,
    );
  });
});

/**
 * Path 29: a draft that AGED between generate and publish.
 *
 * ⛔ WHAT THIS SPEC IS REALLY GUARDING. `isPastGameNight` refuses a past first
 * night at GENERATE, and `season_is_started` (`0026`) locks a season the moment
 * a published game is in the past. Between them sits the case neither one sees:
 * a draft generated against a perfectly good FUTURE date, reviewed, and
 * published a week later — by which time its first night has passed. Publishing
 * it locks the season instantly and permanently. That window is the schedule
 * rebuild workflow (generate early in the week, publish later), not a mistake.
 *
 * ⚠️ THE DRAFT IS AGED BY MOVING IT BACKWARDS IN THE DATABASE, and it has to be:
 * the generate form refuses to produce a past-dated draft, so there is no route
 * through the UI to the state under test. What is generated is a REAL draft —
 * the generator's own matchups, nights and ice times — and only its dates are
 * moved, which is exactly what the passage of time would have done to it.
 *
 * Seeds its own season, the shape `14-schedule-changes`'s repair and manual-edit
 * seasons use, so every mutation stays inside it. That season is deleted afterwards
 * rather than left behind: the last test publishes a past-dated schedule on
 * purpose, which locks it for good, and a locked season is not something to
 * hand to the next run.
 */

/**
 * ⛔ COMPUTED, NEVER PINNED — the rule `14-schedule-changes` sets out. Every date
 * here is relative to the clock, because this spec is *about* the clock: a
 * fixed "stale" date stops being stale the moment it is compared against a
 * later today, and a fixed future one eventually is not future.
 */
const YEAR = new Date().getUTCFullYear() + 2;
const STALE_SEASON = `Stale Draft ${YEAR}`;

/** The league plays on US Eastern, and so does every date the app renders. */
const TZ = "America/New_York";

/**
 * ⚠️ THE SPEC DOES ITS OWN ZONE ARITHMETIC RATHER THAN IMPORTING THE APP'S.
 * Copied deliberately: a relative TypeScript import dies at load in this suite
 * (see `14-schedule-changes`), and reusing `@/lib/format` would in any case let a
 * bug in the app's own date handling agree with itself and pass.
 */
const dateKey = (iso: string) =>
  new Intl.DateTimeFormat("en-CA", {
    timeZone: TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(iso));

const timeKey = (iso: string) =>
  new Intl.DateTimeFormat("en-GB", {
    timeZone: TZ,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(new Date(iso));

/** That date's Eastern offset ("-04:00" in EDT, "-05:00" in EST). */
const offsetOn = (date: string) =>
  (
    new Intl.DateTimeFormat("en-US", {
      timeZone: TZ,
      timeZoneName: "longOffset",
    })
      .formatToParts(new Date(`${date}T12:00:00Z`))
      .find((p) => p.type === "timeZoneName")?.value ?? "GMT-05:00"
  ).replace("GMT", "");

/** A plain "YYYY-MM-DD", `days` later. UTC arithmetic, so DST cannot shift it. */
const plusDays = (date: string, days: number) => {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d) + days * 86_400_000)
    .toISOString()
    .slice(0, 10);
};

const today = () => dateKey(new Date().toISOString());

const WEEKDAY_LABEL = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/**
 * How far back the draft is dragged, and how far forward the app should then
 * move it — the same number, and that is the point of the arithmetic below.
 *
 * The generated draft starts `FIRST_NIGHT_IN` days from today. Dragged back
 * three weeks, its first night lands 21 − 4 = 17 days behind us, and the
 * smallest whole number of weeks that puts it back on or after today is 3 —
 * which restores every game to the exact timestamp the generator gave it. So
 * "the schedule the manager reviewed, just later" can be asserted as equality
 * rather than described.
 */
const AGE_WEEKS = 3;
const FIRST_NIGHT_IN = 4;

async function leagueId(): Promise<string> {
  const { data } = await admin()
    .from("leagues")
    .select("id")
    .eq("slug", "obhl")
    .single();
  return data!.id as string;
}

/** The seeded season, created fresh so a previous run's leftovers cannot skew it. */
async function seedStaleSeason(): Promise<string> {
  const db = admin();
  const league = await leagueId();

  // Cascades to its games and enrolments. Scoped to this spec's own season name
  // — nothing else in the fixture is named this — and it runs first so a run
  // that died mid-way (leaving a locked, published season behind) cannot make
  // the next one fail for a reason that has nothing to do with the feature.
  await db
    .from("seasons")
    .delete()
    .eq("league_id", league)
    .eq("name", STALE_SEASON);

  const { data: season, error } = await db
    .from("seasons")
    .insert({
      league_id: league,
      name: STALE_SEASON,
      // Wide enough that nothing here is refused for running past the season's
      // end, and never active: this spec drives the per-season setup page, so
      // the fixture's active season is left exactly as it was found.
      starts_on: plusDays(today(), -30),
      ends_on: plusDays(today(), 300),
    })
    .select("id")
    .single();
  if (error) throw new Error(`could not seed the season: ${error.message}`);

  const { data: teams } = await db
    .from("teams")
    .select("id")
    .eq("league_id", league)
    .order("name", { ascending: true });
  const enrol = (teams ?? []).slice(0, 6);
  if (enrol.length < 6) {
    throw new Error(`expected 6 obhl teams to enrol, found ${enrol.length}`);
  }
  await db
    .from("season_teams")
    .insert(enrol.map((t) => ({ season_id: season!.id, team_id: t.id })));

  return season!.id as string;
}

/** Every draft game in the season, by id, oldest first. */
async function draftGames(season: string) {
  const { data } = await admin()
    .from("games")
    .select("id, scheduled_at, home_team_id, away_team_id, is_draft")
    .eq("season_id", season)
    .eq("is_draft", true)
    .order("scheduled_at", { ascending: true });
  return data ?? [];
}

async function publishedGames(season: string) {
  const { data } = await admin()
    .from("games")
    .select("id, scheduled_at")
    .eq("season_id", season)
    .eq("is_draft", false)
    .order("scheduled_at", { ascending: true });
  return data ?? [];
}

/**
 * Drag every draft game back `weeks` whole weeks — what waiting would have done
 * to it.
 *
 * ⛔ WALL CLOCK, NOT INSTANT, for the same reason `moveNightTo` is: a game on
 * the ice at 19:00 must still be on the ice at 19:00 on the earlier date. Only
 * then is this the exact inverse of the move the app performs, and only then
 * does "the games came back to where the generator put them" mean anything
 * across a DST boundary.
 */
async function ageDraftBy(season: string, weeks: number) {
  const db = admin();
  for (const g of await draftGames(season)) {
    const date = plusDays(dateKey(g.scheduled_at!), -7 * weeks);
    const { error } = await db
      .from("games")
      .update({
        scheduled_at: `${date}T${timeKey(g.scheduled_at!)}:00${offsetOn(date)}`,
      })
      .eq("id", g.id);
    if (error) throw new Error(`could not age the draft: ${error.message}`);
  }
}

test.describe
  .serial("Path 29 — a draft that aged before it was published", () => {
  test.describe.configure({ timeout: 180_000 });

  let season = "";
  /** The generator's own timestamps, before the draft was dragged backwards. */
  let asGenerated: { id: string; scheduled_at: string | null }[] = [];

  test.beforeAll(async ({ browser }) => {
    season = await seedStaleSeason();

    const page = await browser.newPage();
    await signInAs(page, "Manager", "/obhl/dashboard");
    await page.goto(`/obhl/seasons/${season}`);
    await expectGenerateFormUsable(page);

    // A real draft, generated the way a manager generates one: a valid future
    // first night, which is the only kind the form accepts.
    const firstNight = plusDays(today(), FIRST_NIGHT_IN);
    const weekday =
      WEEKDAY_LABEL[new Date(`${firstNight}T12:00:00Z`).getUTCDay()];
    await page.getByLabel("First game night").fill(firstNight);
    await page.getByLabel("Games per team").fill("4");
    await page.getByLabel(/Ice-time slots/).fill("19:00, 20:15, 21:30");
    await page
      .locator(`label:has-text("${weekday}") input[name="weekdays"]`)
      .check();
    await page.getByRole("button", { name: "Generate schedule" }).click();
    await expect(page.getByText("Balance report")).toBeVisible(AFTER_GENERATE);
    await page.close();

    asGenerated = (await draftGames(season)).map((g) => ({
      id: g.id,
      scheduled_at: g.scheduled_at,
    }));
    expect(asGenerated.length).toBeGreaterThan(0);
    expect(dateKey(asGenerated[0].scheduled_at!)).toBe(firstNight);

    // …and now the wait. Three weeks pass; nobody publishes.
    await ageDraftBy(season, AGE_WEEKS);
  });

  test.afterAll(async () => {
    const db = admin();
    await db
      .from("seasons")
      .delete()
      .eq("league_id", await leagueId())
      .eq("name", STALE_SEASON);
  });

  test("the server refuses a stale publish that arrives without the acknowledgement", async ({
    page,
  }) => {
    // ⛔ THE ONE PATH THE SERVER GUARD EXISTS FOR, and nothing else here touches
    // it. Every other test in this file publishes through the dialog, which
    // supplies `stale_ok` correctly — so the whole check in `publishSchedule`
    // could be deleted and this spec would stay green without this test.
    //
    // What it stands in for: a manager whose tab was rendered while the draft
    // was still healthy. Their `PublishControls` has `stale === null`, renders
    // a plain one-click form, and posts no acknowledgement at all. Removing the
    // hidden input reproduces exactly that payload.
    await signInAs(page, "Manager", "/obhl/dashboard");
    await page.goto(`/obhl/seasons/${season}`);

    await page.getByRole("button", { name: /^Publish \d+ games$/ }).click();
    const dialog = page.getByRole("dialog");
    await expect(
      dialog.getByText("Publish a schedule that starts in the past?"),
    ).toBeVisible();
    await dialog
      .locator('input[name="stale_ok"]')
      .evaluate((el) => el.remove());

    await dialog.getByRole("button", { name: "Publish anyway" }).click();

    // The refusal is a toast, and it survives because PublishControls is keyed
    // on the draft count alone — see the note on that key. If the stale night
    // ever goes back into the key, this is the assertion that catches it.
    await expect(
      page.getByText("publishing it would start the season in the past"),
    ).toBeVisible();
    expect(await publishedGames(season)).toHaveLength(0);
    expect(await draftGames(season)).toHaveLength(asGenerated.length);
  });

  test("moving the draft forward restores every game the generator placed", async ({
    page,
  }) => {
    await signInAs(page, "Manager", "/obhl/dashboard");
    await page.goto(`/obhl/seasons/${season}`);

    await page.getByRole("button", { name: /^Move draft to / }).click();
    // ⚠️ ASSERTING A SUCCESS TOAST IS ONLY SAFE BECAUSE OF HOW THE BANNER IS
    // BUILT. `StaleDraftNotice` stays mounted when the draft stops being stale
    // and renders null instead, precisely so this message is not lost to the
    // remount race `11-schedule-build.spec.ts` documents. Move the action
    // state back inside something conditional and this is the assertion that
    // will start flapping.
    await expect(
      page.getByText(`Moved the draft forward ${AGE_WEEKS} weeks`),
    ).toBeVisible();

    // ⛔ EQUALITY, NOT "SOMETHING IN THE FUTURE". The promise the button makes
    // is that the schedule the manager reviewed survives the move — same
    // matchups, same nights, same ice times — and three weeks back then three
    // weeks on is exactly the schedule the generator produced.
    const after = await draftGames(season);
    expect(after.map((g) => g.id).sort()).toEqual(
      asGenerated.map((g) => g.id).sort(),
    );
    const byId = new Map(after.map((g) => [g.id, g.scheduled_at]));
    for (const g of asGenerated) {
      expect(dateKey(byId.get(g.id)!)).toBe(dateKey(g.scheduled_at!));
      expect(timeKey(byId.get(g.id)!)).toBe(timeKey(g.scheduled_at!));
    }
    expect(dateKey(after[0].scheduled_at!) >= today()).toBe(true);

    // And the warning is gone with it. ⚠️ Assert the string the banner ACTUALLY
    // renders: this read "has already passed" for one revision, which the
    // banner had stopped saying, so it passed against a banner still on screen.
    await expect(
      page.getByText("has already been played over", { exact: false }),
    ).toHaveCount(0);
  });

  test("publishing a stale draft anyway is still possible, and locks the season", async ({
    page,
  }) => {
    // Back to a staged, aged draft — the state a manager who really did play
    // those games arrives in. Done through the service role because no UI can
    // produce it, as at the top of this file.
    const db = admin();
    await db
      .from("games")
      .update({ is_draft: true })
      .eq("season_id", season)
      .eq("is_draft", false);
    await ageDraftBy(season, AGE_WEEKS);

    await signInAs(page, "Manager", "/obhl/dashboard");
    await page.goto(`/obhl/seasons/${season}`);

    await page.getByRole("button", { name: /^Publish \d+ games$/ }).click();
    const dialog = page.getByRole("dialog");
    await expect(
      dialog.getByText("Publish a schedule that starts in the past?"),
    ).toBeVisible();

    // ⚠️ THE POINT OF THE WHOLE DESIGN: this is a warning, not a refusal. A
    // manager whose games were genuinely played must be able to publish them.
    await dialog.getByRole("button", { name: "Publish anyway" }).click();

    // ⛔ THE PAGE, NOT THE TOAST. A successful publish empties the draft, so
    // PublishControls unmounts and its success toast races that — see the same
    // note in `11-schedule-build.spec.ts`. What lands here instead is the
    // one-way door itself: the published games are now in the past, so the
    // season is started and the builder locks on the spot.
    await expect(page.getByText("The season is under way")).toBeVisible();

    const live = await publishedGames(season);
    expect(live).toHaveLength(asGenerated.length);
    expect(dateKey(live[0].scheduled_at!) < today()).toBe(true);
    expect(await draftGames(season)).toHaveLength(0);
  });
});
