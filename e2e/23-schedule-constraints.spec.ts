/**
 * Path 24: Manager schedule constraints — telling the generator what to do,
 * and being told what it could not do.
 *
 * Driven through Fall 2026's setup page for the same reason `11-schedule-builder`
 * is: the generate flow only exists on a season that has not started, and the
 * active season is in the past. Both pages render the same
 * `ScheduleBuilderPanel`, so the card under test is identical either way.
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

async function signedInAsManager(page: Page) {
  await page.goto("/login");
  await page.getByRole("button", { name: "Manager" }).click();
  await page.waitForURL("/");
  await page.goto("/obhl/manage/dashboard");
}

async function goToFallSeasonSetup(page: Page) {
  await page.goto("/obhl/manage/seasons");
  await page
    .getByRole("row", { name: /Fall 2026/ })
    .getByRole("link", { name: "Setup" })
    .click();
  await page.waitForURL(/\/seasons\//);
}

/** See `11-schedule-builder.spec.ts` — Phase S runs five candidates. */
const AFTER_GENERATE = { timeout: 45_000 };

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

test.describe("Path 24 — schedule constraints", () => {
  // A generate can be ~25 s of search, and two of these run one.
  test.describe.configure({ timeout: 150_000 });

  test.beforeEach(async ({ page }) => {
    await signedInAsManager(page);
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

  test("the constraints card sits inside the generate form", async ({
    page,
  }) => {
    // ⚠️ Inside the form, not beside it: the season's game nights do not exist
    // until the form above is filled in, so a card rendered elsewhere would have
    // no calendar to talk about.
    const form = page.locator("form").filter({ hasText: "Manager requests" });
    await expect(
      form.getByRole("button", { name: "Generate schedule" }),
    ).toBeVisible();
    await expect(form.getByLabel("Request", { exact: true })).toBeVisible();
    await expect(
      form.getByRole("button", { name: "Add request" }),
    ).toBeVisible();
  });

  test("the request picker offers all six kinds", async ({ page }) => {
    const kinds = page.getByLabel("Request", { exact: true });
    for (const label of [
      "Bye on a night",
      "Bye the whole week",
      "Bye once in a week",
      "Play on a night",
      "Play at an ice time",
      "Prefer early/late ice",
    ]) {
      await expect(kinds.locator("option", { hasText: label })).toHaveCount(1);
    }
  });

  test("adding a request lists it, and removing it takes it away", async ({
    page,
  }) => {
    const name = await firstTeamName(page);
    await page.getByLabel("Request", { exact: true }).selectOption("bye_on");
    await page.getByLabel("Date", { exact: true }).fill(await fallStart());
    await page.getByRole("button", { name: "Add request" }).click();

    await expect(
      requestList(page).filter({
        hasText: `${name} byes on ${await fallStart()}`,
      }),
    ).toBeVisible();

    await page
      .getByRole("button", { name: /^Remove request:/ })
      .first()
      .click();
    await expect(
      requestList(page).filter({
        hasText: `${name} byes on ${await fallStart()}`,
      }),
    ).toHaveCount(0);
  });

  test("a request with nothing filled in is refused, not silently dropped", async ({
    page,
  }) => {
    await firstTeamName(page);
    await page.getByLabel("Request", { exact: true }).selectOption("slot_on");
    await page.getByLabel("Date", { exact: true }).fill(await fallStart());
    // No ice time.
    await page.getByRole("button", { name: "Add request" }).click();
    await expect(page.getByText("Enter the ice time as HH:MM.")).toBeVisible();
  });

  test("two requests that contradict each other are refused by name", async ({
    page,
  }) => {
    // The likeliest thing a manager actually does wrong, and the reason
    // contradictions are checked before the arithmetic: the message names both
    // offending requests rather than saying "infeasible".
    const name = await firstTeamName(page);
    await page.getByLabel("Request", { exact: true }).selectOption("bye_on");
    await page.getByLabel("Date", { exact: true }).fill(await fallStart());
    await page.getByRole("button", { name: "Add request" }).click();
    await expect(
      requestList(page).filter({
        hasText: `${name} byes on ${await fallStart()}`,
      }),
    ).toBeVisible();

    await firstTeamName(page);
    await page.getByLabel("Request", { exact: true }).selectOption("play_on");
    await page.getByLabel("Date", { exact: true }).fill(await fallStart());
    await page.getByRole("button", { name: "Add request" }).click();
    await expect(
      requestList(page).filter({
        hasText: `${name} plays on ${await fallStart()}`,
      }),
    ).toBeVisible();

    await page.getByLabel("First game night").fill(await fallStart());
    await page.getByLabel("Games per team").fill("4");
    await page.locator('label:has-text("Tue") input[name="weekdays"]').check();
    await page.locator('label:has-text("Thu") input[name="weekdays"]').check();
    await page.getByRole("button", { name: "Generate schedule" }).click();

    // Refused on arithmetic in milliseconds, not by a search running its budget
    // out — and the message names both requests.
    await expect(page.getByText(/contradict each other/)).toBeVisible();
    await expect(page.getByText("No draft schedule")).toBeVisible();
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
    await page.getByLabel("Ice time").fill("21:30");
    await page.getByRole("button", { name: "Add request" }).click();
    const description = `${name} plays at 21:30 on ${requestDate}`;
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

  test("the requests card is absent when nothing has been asked for", async ({
    page,
  }) => {
    await page.getByLabel("First game night").fill(await fallStart());
    await page.getByLabel("Games per team").fill("4");
    await page.locator('label:has-text("Tue") input[name="weekdays"]').check();
    await page.locator('label:has-text("Thu") input[name="weekdays"]').check();
    await page.getByRole("button", { name: "Generate schedule" }).click();

    await expect(page.getByText("Balance report")).toBeVisible(AFTER_GENERATE);
    await expect(outcomeCard(page)).toHaveCount(0);

    await page.getByRole("button", { name: "Discard draft" }).click();
    await expect(page.getByText("No draft schedule")).toBeVisible();
  });
});
