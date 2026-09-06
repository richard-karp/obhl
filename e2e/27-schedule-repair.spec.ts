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

/**
 * The league-local calendar date of a timestamp.
 *
 * ⚠️ A DELIBERATE COPY of `leagueDateKey` in `src/lib/format.ts`, not a second
 * rule. Importing the real one — by `@/lib/format` or by relative path — dies
 * at load with `context.conditions?.includes is not a function`: Playwright's
 * loader will not take a TypeScript module from outside `e2e/`, which is why no
 * spec in this suite imports from `src`. Both were tried on 2026-09-06.
 *
 * So it is the same three lines and the same timezone, copied rather than
 * re-derived — an earlier version of this helper invented its own "subtract a
 * day when the UTC hour is small" rule, which happened to agree for evening
 * games and would have gone on agreeing after the real one changed.
 */
const LEAGUE_TZ = "America/New_York";
const leagueDateKey = (iso: string) =>
  new Intl.DateTimeFormat("en-CA", {
    timeZone: LEAGUE_TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(iso));

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
  return season!.id;
}

/** Every published game id for this spec's season, for the id-stability check. */
async function publishedGameIds(): Promise<string[]> {
  const { data } = await admin()
    .from("games")
    .select("id")
    .eq("season_id", await seasonId())
    .eq("is_draft", false);
  return (data ?? []).map((g) => g.id).sort();
}

/**
 * Which enrolled teams play on `date` and which sit it out, by name.
 *
 * ⛔ Read from the database, never found by clicking every team in turn. A loop
 * that stops at the first team producing the message it hoped for cannot tell
 * "the branch works" from "the fixture has no byes and I never reached it", and
 * this fixture is built with two ice times precisely so byes exist. Both lists
 * are asserted non-empty at the call sites, so a fixture that stops producing
 * either fails loudly instead of passing quietly.
 */
async function teamsOn(
  date: string,
): Promise<{ playing: string[]; bye: string[] }> {
  const db = admin();
  const season = await seasonId();
  const [{ data: enrolled }, { data: games }] = await Promise.all([
    db
      .from("season_teams")
      .select("team_id, teams(name)")
      .eq("season_id", season),
    db
      .from("games")
      .select("home_team_id, away_team_id, scheduled_at")
      .eq("season_id", season)
      .eq("is_draft", false),
  ]);
  // ⛔ `leagueDateKey`, not a rule re-derived here. A night's games spill past
  // midnight UTC, so grouping them needs the league zone — and a test that
  // reimplements that rule is one that keeps passing after the real one changes.
  const playingIds = new Set(
    (games ?? [])
      .filter((g) => g.scheduled_at && leagueDateKey(g.scheduled_at) === date)
      .flatMap((g) => [g.home_team_id, g.away_team_id]),
  );
  const name = (e: { teams: unknown }) =>
    (e.teams as { name: string } | null)?.name ?? "";
  return {
    playing: (enrolled ?? [])
      .filter((e) => playingIds.has(e.team_id))
      .map(name),
    bye: (enrolled ?? []).filter((e) => !playingIds.has(e.team_id)).map(name),
  };
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
  // ⛔ THE GUARD IS "IS IT PUBLISHED", NOT "IS THERE NO DRAFT". A published
  // season also has no draft, so the draft-shaped guard sent the second test
  // through a second generate — and then looked for a "Publish N games" button
  // that, with a live schedule already there, reads "Replace published
  // schedule". It cost a wasted generate per test and then failed on the button.
  if ((await page.getByText(/^Published: \d+ games$/).count()) === 0) {
    await page.getByLabel("First game night").fill(FIRST_NIGHT);
    await page.getByLabel("Games per team").fill("6");
    // ⛔ TWO ice times, not the default three, AND THAT IS THE FIXTURE'S POINT.
    // Six teams over three sheets is three games a night, so every team plays
    // every night and the season has NO BYES AT ALL — which would make the
    // unmet-pin test below unreachable, and it would pass by never getting
    // there. Two sheets means four teams play and two sit out.
    await page.getByLabel(/Ice-time slots/).fill("19:00, 20:15");
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
      page.getByLabel("Night to move").locator(`option[value="${first}"]`),
    ).toHaveCount(0);

    // ⛔ No new game ids. Moving a night is an update, not a republish.
    expect(await publishedGameIds()).toEqual(before);
  });

  test("a pin against a live season gives ranked plans, a diff, and no new ids", async ({
    page,
  }) => {
    test.slow();
    await signedInAsManager(page);
    await seedFutureSeason(page);

    await page.goto("/obhl/schedule-builder/repair");
    await expect(
      page.getByRole("heading", { name: "Repair the schedule" }),
    ).toBeVisible();

    // A team, a night, and an ice time that night actually runs — the picker is
    // built from the PUBLISHED games, so every option in it is resolvable.
    const nightPicker = page.getByLabel("Night", { exact: true });
    const nightValue = (await nightPicker
      .locator("option")
      .nth(1)
      .getAttribute("value"))!;
    await nightPicker.selectOption(nightValue);

    const timePicker = page.getByLabel("Ice time (optional)");
    await expect(timePicker).toBeEnabled();
    const times = await timePicker.locator("option").allTextContents();
    // "Any time that night" plus the night's real slots.
    expect(times.length).toBeGreaterThan(1);

    // A team that actually plays that night, read from the schedule.
    const { playing } = await teamsOn(nightValue);
    expect(playing.length).toBeGreaterThan(0);
    await page
      .getByLabel("Team", { exact: true })
      .selectOption({ label: playing[0] });
    await timePicker.selectOption({ index: 1 });

    await page.getByRole("button", { name: "Preview the repair" }).click();
    // A repair, or an honest "there is nothing to improve" — both are real
    // outcomes of a search under a wall clock, and only the first can be applied.
    const plans = page.getByText("Pick a repair");
    const idle = page.getByText("Nothing to improve");
    await expect(plans.or(idle)).toBeVisible(AFTER_GENERATE);
    if (await idle.isVisible()) return;

    // ⛔ THE DIFF IS ON SCREEN BEFORE THE APPLY. Every plan says which nights
    // change and what they change to.
    await expect(
      page.getByText(/opponent balance restored|left off target/).first(),
    ).toBeVisible();
    await page
      .getByRole("button", { name: /Show the \d+ nights? that change/ })
      .first()
      .click();
    await expect(page.getByText(" @ ").first()).toBeVisible();

    const before = await publishedGameIds();
    await page.getByRole("button", { name: "Apply this plan" }).click();
    await expect(page.getByText(/^Repaired \d+ nights?/)).toBeVisible(
      AFTER_GENERATE,
    );

    // ⛔ Applying a repair changes no game ids — that is what keeps 144
    // subscribers' calendar events intact where a regenerate would replace them.
    expect(await publishedGameIds()).toEqual(before);
  });

  /**
   * ⛔ The most likely thing to be got wrong, asserted in the UI. "X needs to
   * play that night" reads as though repair will ADD them to it. It will not —
   * that changes participation, which changes byes — and the page has to say so
   * rather than quietly dropping the pin.
   */
  test("an unsatisfiable pin says why, in terms a manager can act on", async ({
    page,
  }) => {
    test.slow();
    await signedInAsManager(page);
    await seedFutureSeason(page);

    await page.goto("/obhl/schedule-builder/repair");
    const nightPicker = page.getByLabel("Night", { exact: true });
    const nightValue = (await nightPicker
      .locator("option")
      .nth(1)
      .getAttribute("value"))!;
    await nightPicker.selectOption(nightValue);

    // The team that byes that night, read from the schedule rather than found
    // by clicking around — see `teamsOn`.
    const { bye } = await teamsOn(nightValue);
    expect(bye.length).toBeGreaterThan(0);
    await page
      .getByLabel("Team", { exact: true })
      .selectOption({ label: bye[0] });

    await page.getByRole("button", { name: "Preview the repair" }).click();
    await expect(
      page.getByText("That isn't something a repair can do"),
    ).toBeVisible(AFTER_GENERATE);
    await expect(page.getByText(/bye that night/)).toBeVisible();
    await expect(page.getByText(/changes every team's byes/)).toBeVisible();
    // And it points at what the manager CAN do instead.
    await expect(page.getByText(/Reschedule/)).toBeVisible();
  });

  /**
   * Item 4: the same engine with no pin at all — what a manager reaches for
   * after a run of manual reschedules has left the ice-time share lopsided.
   */
  test("repair with no pin either improves the schedule or says there is nothing to do", async ({
    page,
  }) => {
    test.slow();
    await signedInAsManager(page);
    await seedFutureSeason(page);

    // ⛔ The entry point is on the builder, and it has to be there in the mode
    // this feature exists for. This fixture's season has not started, so it is
    // reachable here in `published` mode; the locked card carries the same link,
    // asserted below on the seeded season, which HAS started.
    await page.goto("/obhl/schedule-builder");
    await page.getByRole("link", { name: "repair the schedule" }).click();
    await expect(page).toHaveURL(/\/schedule-builder\/repair/);

    const before = await publishedGameIds();
    await page
      .getByRole("button", { name: "Just repair the schedule" })
      .click();

    const plans = page.getByText("Pick a repair");
    const idle = page.getByText("Nothing to improve");
    await expect(plans.or(idle)).toBeVisible(AFTER_GENERATE);

    if (await idle.isVisible()) {
      // ⚠️ A real outcome, not a failure: the season is already as good as the
      // search can make it, and it says so instead of offering churn.
      await expect(page.getByText(/nothing worth applying/)).toBeVisible();
      return;
    }

    await page.getByRole("button", { name: "Apply this plan" }).click();
    await expect(page.getByText(/^Repaired \d+ nights?/)).toBeVisible(
      AFTER_GENERATE,
    );
    expect(await publishedGameIds()).toEqual(before);
  });

  /**
   * ⛔ `locked` IS THE MODE THIS FEATURE EXISTS FOR. The seeded season's games
   * are all in the past, so its builder renders the locked card — which used to
   * offer per-game edits and the one-off planner and stop there.
   */
  test("the locked builder offers repair alongside the one-off planner", async ({
    page,
  }) => {
    await signedInAsManager(page);
    // The seeded season, explicitly: `seedFutureSeason` may have left this
    // spec's own 2027 season active.
    await page.goto("/obhl/seasons");
    await page
      .getByRole("row", { name: /Spring 2026/ })
      .getByRole("link", { name: "Setup" })
      .click();
    await page.waitForURL(/\/seasons\//);

    await expect(page.getByText("The season is under way")).toBeVisible();
    await expect(
      page.getByRole("link", { name: "schedule a one-off game" }),
    ).toBeVisible();
    await expect(
      page.getByRole("link", { name: "repair the schedule" }),
    ).toBeVisible();
  });
});
