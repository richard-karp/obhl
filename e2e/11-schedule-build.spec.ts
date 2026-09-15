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

// ⛔ Never restate the seeded Fall date: the seed owns it, and a spec repeating it disagrees with its
// fixture once that date passes and the season starts.
async function fallStart(): Promise<string> {
  const db = admin();
  const { data: league, error: le } = await db
    .from("leagues")
    .select("id")
    .eq("slug", "obhl")
    .single();
  // ⛔ Fail by name: an empty read otherwise fails every test in this file with nothing pointing at
  // the fixture. Scoped to obhl, since both leagues carry a "Spring 2026".
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

// Generate exists only on a season that hasn't started, and the active one has: drive Fall 2026.
async function goToFallSeasonSetup(page: Page) {
  await page.goto("/obhl/seasons");
  await page
    .getByRole("row", { name: /Fall 2026/ })
    .getByRole("link", { name: "Setup" })
    .click();
  await page.waitForURL(/\/seasons\//);
}

// ⛔ Not a retry: fails by name if the builder came up locked (`readFailed` or `started`), where a bare
// `fill()` times out naming only the locator. Call it before any gate that reads the panel.
async function expectGenerateFormUsable(page: Page) {
  // ⚠️ Copied on purpose: a relative TS import dies at load in this suite (`context.conditions
  // ?.includes is not a function`). Change one copy, change both; there are two, here and in 14.
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

// Only for assertions waiting on a generate: Phase S runs five candidates on their own 5 s budgets,
// so one can take ~25 s (`RUNBOOK.md` → Schedule generator). Anything else this slow is a bug.
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
    // Start on Fall's first night: a date outside the window still generates (drafts aren't bounded
    // by the season start), so a wrong one passes while drafting the wrong months.

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

    // Scoped to the Balance report card: the setup page's team roster table would match too.
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
    // ⛔ Refused at GENERATE: `season_is_started` ignores drafts, so a past-dated one looks fine until
    // publishing locks the season for good. `min` is stripped: only the server half can't be bypassed.

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

    // The published state must say that generating a new draft is how to replace it.
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

    // The live schedule stays visible in replace mode, on the screen that deletes it.
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
    // Asserted by shape and with its sentence: a bare date also appears in the header and night
    // headings, and a literal would pin the fixture's date and `formatLongDate`'s output.
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
    // Order-independent, so it works under `-g`. ⛔ Guard and wait before the `count()` probe, which
    // doesn't wait: reading 0 on a published or read-failed season sends it down the publish branch.
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
      // ⛔ Wait for the generate to LAND: otherwise the click's actionability wait covers the whole
      // search, capped by `actionTimeout` at 20 s, under the ~25 s Phase S can take.
      const publish = page.getByRole("button", { name: /Publish \d+ games/ });
      await expect(publish).toBeVisible(AFTER_GENERATE);
      await publish.click();
    }

    await expect(removeButton).toBeVisible();

    await removeButton.click();
    await expect(
      page.getByText("Remove the published schedule?"),
    ).toBeVisible();
    // Asserted by shape: the dialog carries no game count, since a pre-start removal destroys
    // nothing that can't be regenerated.
    await expect(
      page.getByText(/The season will have no games until you generate/),
    ).toBeVisible();
    // `exact` matters: without it this also matches the "Remove published
    // schedule" trigger behind the dialog.
    await page.getByRole("button", { name: "Remove", exact: true }).click();

    // All three: the count gone shows the games went, the control gone shows the mode moved, and
    // the empty state shows the panel recovered.
    await expect(page.getByText(/Published: \d+ games/)).toHaveCount(0);
    await expect(removeButton).toHaveCount(0);
    await expect(page.getByText("No draft schedule")).toBeVisible();
  });
});

// ⛔ Computed, never pinned: a `slot_on` date not derived from `fallStart()` lands outside the
// generated season once the clock moves.
async function secondTuesday(): Promise<string> {
  const d = new Date(`${await fallStart()}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 7);
  return d.toISOString().slice(0, 10);
}

async function firstTeamName(page: Page): Promise<string> {
  const select = page.getByLabel("Team", { exact: true });
  const value = await select.locator("option").nth(1).getAttribute("value");
  const name = (await select.locator("option").nth(1).textContent())!.trim();
  await select.selectOption(value!);
  return name;
}

// ⛔ Never assert a request's description against the whole page: sonner toasts it too, so a bare
// `getByText` is a strict-mode violation exactly when the add worked.
function requestList(page: Page) {
  return page
    .locator("li")
    .filter({ has: page.getByRole("button", { name: /^Remove request:/ }) });
}

// ⛔ Match the card TITLE exactly, not a card filtered on "Manager requests": the constraints card is
// titled "Manager requests (optional)", so that filter always matches two.
function outcomeCard(page: Page) {
  // `:scope >` pins the card whose OWN header has the title; otherwise every enclosing Card matches
  // too, and a 2-element match is a strict-mode violation.
  return page.locator('[data-slot="card"]').filter({
    has: page.locator(':scope > [data-slot="card-header"]', {
      hasText: /^Manager requests$/,
    }),
  });
}

// ⛔ Wait on the list shrinking, not the toast: sonner lingers, so the first removal's toast satisfies
// the second wait and the loop clicks a still-disabled, detaching button.
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
    // ⛔ Here, not before each `fill`: the constraints card is inside the generate form, so
    // `firstTeamName` would time out on it before a later guard ran.
    await expectGenerateFormUsable(page);
  });

  test.afterEach(async ({ page }) => {
    await clearRequests(page);
  });

  // ⛔ `slot_on`, not `bye_on`: six teams on three sheets all play every night, so the season has no
  // bye budget and every bye request is correctly refused. `slot_on` must survive Phases P and S.
  test("a honoured request shows as met on the preview", async ({ page }) => {
    const name = await firstTeamName(page);
    const requestDate = await secondTuesday();
    await page.getByLabel("Request", { exact: true }).selectOption("slot_on");
    await page.getByLabel("Date", { exact: true }).fill(requestDate);
    // ⚠️ The latest DEFAULT slot: this test inherits the form's `slot_times` default, and a time the
    // season does not run is unsatisfiable. Change them together.
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

    // ⛔ Assert the TICK, not the listing: an unmet request is listed too, with a ✗.
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

// Generate keeps every field (a manager iterates); publish resets the form and clears the requests.
// Non-default ice times, so "still what I typed" cannot pass by accident.
const SLOT_TIMES = "18:45, 20:00";

// ⛔ Computed: a typed day-of-month is a Thursday in only one year, and the test needs the weekday.
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

// Matches `shortLabel()` in `schedule-generate-form.tsx`. ⛔ Computed, like `skipDay`: the walk to
// Thursday can cross into another month.
async function skipChip(): Promise<string> {
  const d = await skipDate();
  return `${MONTH_ABBR[d.getUTCMonth()]} ${d.getUTCDate()}`;
}

// ⛔ The picker opens on the first night's month (`defaultMonth`) and shows one month, so a later
// month must be advanced to, or a same-numbered day in the visible month gets clicked.
async function skipMonthsAhead(): Promise<number> {
  const start = new Date(`${await fallStart()}T12:00:00Z`);
  const target = await skipDate();
  return (
    (target.getUTCFullYear() - start.getUTCFullYear()) * 12 +
    (target.getUTCMonth() - start.getUTCMonth())
  );
}

// ⛔ Computed, like `secondTuesday()`: a pinned date can land before the season starts.
async function aWeekIntoSeason(): Promise<string> {
  const d = new Date(`${await fallStart()}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 7);
  return d.toISOString().slice(0, 10);
}

/** Fill every field on the generate form with something that is not its default. */
async function fillEverything(page: Page) {
  await expectGenerateFormUsable(page);
  await page.getByLabel("First game night").fill(await fallStart());
  await page.getByLabel("Games per team").fill("4");
  await page.getByLabel(/Ice-time slots/).fill(SLOT_TIMES);
  await page.locator('label:has-text("Tue") input[name="weekdays"]').check();
  await page.locator('label:has-text("Thu") input[name="weekdays"]').check();

  // The skip chips are React state, not an input: if they survive a generate and the inputs don't,
  // the cause is React's form reset, not a remount.
  await page.getByRole("button", { name: "Pick dates" }).click();
  const popover = page.locator('[data-slot="popover-content"]');
  // The popover opens on the first night's month — advance it if the skipped
  // Thursday landed in a later one.
  const monthsAhead = await skipMonthsAhead();
  for (let i = 0; i < monthsAhead; i++) {
    await popover.getByRole("button", { name: "Go to the Next Month" }).click();
  }
  // ⛔ Exclude outside days: `showOutsideDays` renders the previous month's tail first, and when its
  // day number matches, `.first()` clicks a disabled cell and times out.
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
    // A request to be cleared; `slot_on` because this league has no bye budget.
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
    // ⛔ The page, not the toast: a publish zeroes `draftCount`, which keys PublishControls, so it
    // remounts and its success toast often never renders.
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

    // ⛔ Put the fixture back: a live schedule on Fall 2026 turns the builder's mode to `replace` for
    // the next run of `11`. Removed through the app, not SQL.
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

// ⛔ A draft published after its first night passed locks the season for good. Aged in the database
// (the form refuses a past date), in its own season. ⛔ Every date is relative to the clock, never fixed.
const YEAR = new Date().getUTCFullYear() + 2;
const STALE_SEASON = `Stale Draft ${YEAR}`;

/** The league plays on US Eastern, and so does every date the app renders. */
const TZ = "America/New_York";

// ⚠️ Own zone arithmetic, not `@/lib/format`: a relative import dies at load here, and reusing the
// app's would let a bug in its date handling agree with itself.
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

// Dragged back three weeks from 4 days out, the first night is 17 days past, so the app moves it
// forward exactly three weeks: every game returns to its generated timestamp, asserted as equality.
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

  // Cascades to its games and enrolments. Scoped to this spec's season name, and run first so a run
  // that died mid-way, leaving a locked season, cannot fail the next.
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
      // Wide, so nothing is refused for running past the end; never active, so the fixture's active
      // season is left as found.
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

// ⛔ Wall clock, not instant: a 19:00 game must stay at 19:00 on the earlier date, or this is not the
// inverse of the app's move across a DST boundary.
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
    // ⛔ The one path the server guard exists for: every other publish here posts `stale_ok` from the
    // dialog. A tab rendered while the draft was healthy posts none; removing the input reproduces it.
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

    // The refusal toast survives because PublishControls is keyed on the draft count alone; if the
    // stale night goes into the key, this fails.
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
    // ⚠️ A success toast is safe only because `StaleDraftNotice` stays mounted and renders null once
    // the draft stops being stale; make its action state conditional and this flaps.
    await expect(
      page.getByText(`Moved the draft forward ${AGE_WEEKS} weeks`),
    ).toBeVisible();

    // ⛔ EQUALITY, not "in the future": the reviewed schedule must survive the move, and three weeks
    // back then forward is exactly what the generator produced.
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

    // And the warning is gone. ⚠️ Assert the string the banner ACTUALLY renders, or this passes
    // against a banner still on screen.
    await expect(
      page.getByText("has already been played over", { exact: false }),
    ).toHaveCount(0);
  });

  test("publishing a stale draft anyway is still possible, and locks the season", async ({
    page,
  }) => {
    // Back to a staged, aged draft, as a manager who really played those games has it. Service
    // role, because no UI can produce it.
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

    // ⛔ The page, not the toast (the draft empties and PublishControls remounts): the builder locks,
    // because the published games are in the past.
    await expect(page.getByText("The season is under way")).toBeVisible();

    const live = await publishedGames(season);
    expect(live).toHaveLength(asGenerated.length);
    expect(dateKey(live[0].scheduled_at!) < today()).toBe(true);
    expect(await draftGames(season)).toHaveLength(0);
  });
});
