/** Changing a live schedule: one-off games, moving a night, repair, manual trades, and what a scorekeeper cannot do. */
/**
 * Path 22: Mid-season one-off games (tournament final / semifinals).
 *
 * The seeded season's games are all in the past, so every night is locked and
 * there's nothing to take over. This spec therefore builds its own season with
 * future dates first. It runs late on purpose: publishing games would otherwise
 * disturb `05-scoring-night`, which reads the seeded schedule.
 *
 * It is no longer LAST, though, and that used to matter. Making its own season
 * active left every later spec looking at a season with no rosters and no
 * games — the roster pages simply render "No players yet", which reads like a
 * broken page rather than a leaked fixture. `afterAll` below puts the seeded
 * season back.
 */
import { test, expect } from "@playwright/test";
import type { Page } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";

/** Service-role client, for reading ids and putting the seeded season back. */
function admin() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SECRET_KEY!,
    { auth: { autoRefreshToken: false, persistSession: false } },
  );
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
 * A signed-in ANON-key client — the same access a browser session has, and the
 * only way this suite can ask what RLS actually permits. Same shape as
 * `09-access.spec.ts`.
 */
async function signedInClient(email: string) {
  const client = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!,
    { auth: { autoRefreshToken: false, persistSession: false } },
  );
  const { error } = await client.auth.signInWithPassword({
    email,
    password: "hockey123",
  });
  if (error) throw new Error(`could not sign in as ${email}: ${error.message}`);
  return client;
}

async function seasonIdOf(name: string): Promise<string> {
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
    .eq("name", name)
    .single();
  return season!.id as string;
}

/** The league-local wall-clock time of an instant, as "HH:MM". */
const easternTime = (iso: string) =>
  new Intl.DateTimeFormat("en-GB", {
    timeZone: "America/New_York",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(new Date(iso));

/**
 * ⛔ COMPUTED, NEVER PINNED. This spec seeded `One-Off Test 2027` at a literal
 * 2027-01-05 and would have broken in January 2027 exactly as `11-` was about to
 * break in September 2026. Same defect, further out.
 */
const YEAR = new Date().getUTCFullYear() + 2;
const FIRST_NIGHT = `${YEAR}-01-05`;
const SEASON_END = `${YEAR}-06-30`;

/** See `11-schedule-build.spec.ts` — Phase S runs five candidates. */
const AFTER_GENERATE = { timeout: 45_000 };

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

/**
 * The Eastern calendar date a game belongs to — the bucketing the server does
 * with `leagueDateKey`.
 *
 * ⛔ NOT `toISOString().slice(0, 10)`, WHICH IS ONLY ACCIDENTALLY RIGHT. The
 * comment this replaces said the seeded evenings sit "well clear of a UTC day
 * boundary flip". They do not: 19:00 EST IS 00:00 UTC, exactly on it. The UTC
 * slice agrees with the server today only because every game of a night crosses
 * that boundary TOGETHER, so the partition into nights is isomorphic and merely
 * mislabelled by a day. Under EDT that stops holding — 19:00 EDT is 23:00 UTC
 * the same day while 20:15 EDT is 00:15 UTC the next — and one Eastern night
 * splits across two UTC dates, so `clashes` would see two nights where the
 * server sees one and pick a pair the server then refuses, surfacing as "element
 * not found" rather than as anything nameable. The fixture stays in EST only
 * because six games a team on Tue+Thu from January finishes in early February;
 * raising "Games per team" walks it into March.
 *
 * Inlined rather than imported: no spec in this directory imports app code, for
 * the reason the header note records.
 */
const easternDate = new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/New_York",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});
const nightKey = (iso: string) => easternDate.format(new Date(iso));

const ONE_OFF_SEASON = `One-Off Test ${YEAR}`;

/** A live season with future game nights, published. Idempotent across runs. */
async function seedOneOffSeason(page: Page) {
  await page.goto("/obhl/seasons");
  // Match the table row, not the success banner, which also carries the name.
  const row = page.getByRole("row", { name: new RegExp(ONE_OFF_SEASON) });
  if ((await row.count()) === 0) {
    await page.getByLabel("Name").fill(ONE_OFF_SEASON);
    await page.getByLabel("Season starts").fill(FIRST_NIGHT);
    await page.getByLabel("Season ends (incl. playoffs)").fill(SEASON_END);
    await page.getByRole("button", { name: /Create season/i }).click();
    // Wait for the redirect, then re-navigate before looking for the row.
    //
    // `createSeason` sends the browser to the new season's setup page, so
    // asserting anything on /seasons straight after the click is a race between
    // that navigation and the revalidation — the row assertion that used to be
    // here won it most of the time and lost it in a full run. The success toast
    // is no better: it renders on the page being navigated away from.
    await expect(page).toHaveURL(/\/seasons\/[0-9a-f-]{36}/);
    await page.goto("/obhl/seasons");
    await expect(row).toBeVisible();
  }

  // Re-navigate before clicking through: creating the season revalidates
  // /seasons, and clicking into a table that's mid-re-render detaches the link.
  await page.goto("/obhl/seasons");
  await row.getByRole("link", { name: "Setup" }).click();
  await expect(page).toHaveURL(/\/seasons\//);

  // Enroll the same teams as the seeded season.
  if ((await page.locator("table tbody tr").count()) === 0) {
    await page
      .getByRole("button", { name: "Same teams as last season" })
      .click();
    await expect(page.locator("table tbody tr").first()).toBeVisible();
  }

  // Make it the live season from the list, where the row scopes the button, and
  // confirm it took — the builder works on whichever season is active, so
  // getting this wrong silently generates against the wrong one.
  await page.goto("/obhl/seasons");
  const setActive = row.getByRole("button", { name: "Set active" });
  if ((await setActive.count()) > 0) await setActive.click();
  // The list only renders that button for inactive seasons, so its absence is
  // proof the switch landed. Don't assert on the "Active" badge text: getByText
  // matches case-insensitive substrings, so it also matches "Set active" and
  // would pass before the click took.
  //
  // Racing `setActiveSeason` used to land on "No active season", because it
  // clears every season before setting one. That empty state is gone: the
  // builder now resolves a season of its own and, with nothing active, falls
  // back to the newest by `starts_on` — which is this future season. So the race
  // resolves to the right season either way, and the assertion below is about
  // the switch having landed rather than about surviving it.
  await expect(setActive).toHaveCount(0);

  // ⚠️ REDIRECTS TO THE ACTIVE SEASON'S SETUP PAGE. Building a schedule became
  // a step of creating a season (2026-09-11), so the standalone builder — and
  // the "<season> · N teams enrolled" description this used to assert — is
  // gone. The season was just set active above, so the redirect resolves to it;
  // the setup page's own heading is what names it now.
  await page.goto("/obhl/schedule-builder");
  await expect(
    page.getByRole("heading", { name: `Season setup — ${ONE_OFF_SEASON}` }),
  ).toBeVisible();
  // ⛔ Before the gate, not inside it. The read-failed card makes the
  // condition below FALSE, so a read failure would skip the seed entirely
  // and surface as an unrelated assertion further down. Fail here instead.
  await expectGenerateFormUsable(page);
  if ((await page.getByText("No draft schedule").count()) > 0) {
    await page.getByLabel("First game night").fill(FIRST_NIGHT);
    await page.getByLabel("Games per team").fill("6");
    await page.locator('label:has-text("Tue") input[name="weekdays"]').check();
    await page.locator('label:has-text("Thu") input[name="weekdays"]').check();
    await page.getByRole("button", { name: "Generate schedule" }).click();
    // Generation is a solver, not a query: it runs to a wall-clock budget and is
    // the slowest thing in the suite, so it needs more than the default timeout.
    await expect(page.getByText("Balance report")).toBeVisible({
      timeout: 30_000,
    });
    await page.getByRole("button", { name: /Publish \d+ games/ }).click();
    // Wait for the publish to land. Navigating away while the action is still in
    // flight leaves the one-off page reading a season whose games are all still
    // drafts, and it renders "No published schedule" instead of the form. The
    // panel drops back to its empty state once the drafts are live.
    await expect(page.getByText("No draft schedule")).toBeVisible();
  }
}

test.describe("Path 22 — one-off games", () => {
  /**
   * Hand obhl back to the seeded season.
   *
   * Not a delete: the one-off season and its published schedule are what these
   * tests built and are worth keeping for a post-mortem. Only which season is
   * ACTIVE is restored, because that is the single piece of state every later
   * spec reads. A partial unique index allows one active season per league, and
   * `is_active = true` on the seeded row clears the other by itself.
   */
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
      .eq("name", ONE_OFF_SEASON);
    await db
      .from("seasons")
      .update({ is_active: true })
      .eq("league_id", league.id)
      .eq("name", "Spring 2026");
  });

  test("manager can schedule a one-off and pick how the season absorbs it", async ({
    page,
  }) => {
    test.slow();
    await signInAs(page, "Manager", "/obhl/dashboard");
    await seedOneOffSeason(page);

    await page.goto("/obhl/schedule-builder/one-off");
    await expect(page.getByText("Schedule a one-off game")).toBeVisible();

    // The date field stays shut until the teams are known — eligibility is a
    // function of who's already playing that night.
    const date = page.getByLabel("Date");
    await expect(date).toBeDisabled();

    const options = await page
      .getByLabel("Team 1")
      .first()
      .locator("option")
      .all();
    const teamValues: string[] = [];
    for (const o of options) {
      const v = await o.getAttribute("value");
      if (v) teamValues.push(v);
    }
    expect(teamValues.length).toBeGreaterThan(1);

    await page.getByLabel("Team 1").first().selectOption(teamValues[0]);
    await page.getByLabel("Team 2").first().selectOption(teamValues[1]);
    await expect(date).toBeEnabled();

    // Only nights where both teams already play are offered.
    const dateOptions = await date.locator("option:not([disabled])").count();
    expect(dateOptions).toBeGreaterThan(0);
    await date.selectOption({ index: 1 });

    await page.getByRole("button", { name: "Preview" }).click();

    // Either there's a repair to choose between, or the two teams already meet
    // that night and it's just a label — both are valid outcomes.
    const picker = page.getByText("Pick how to absorb it");
    const relabel = page.getByText("Nothing to repair");
    await expect(picker.or(relabel)).toBeVisible({ timeout: 30000 });

    if (await picker.isVisible()) {
      await expect(
        page.getByText(/opponent balance restored/).first(),
      ).toBeVisible();
      await page.getByRole("button", { name: "Apply this plan" }).click();
    } else {
      await page.getByRole("button", { name: "Label the game" }).click();
    }

    await expect(
      page.getByText(/Scheduled the game|Labelled the game/),
    ).toBeVisible({
      timeout: 30000,
    });

    // The success is audited, under this league. An entry filed under a null
    // league is hidden from every view that would show it.
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
      .eq("name", ONE_OFF_SEASON)
      .single();
    const { data: entries } = await db
      .from("audit_log")
      .select("league_id")
      .eq("action", "schedule_one_off")
      .eq("entity_id", season!.id);
    expect(entries, "a one-off that landed wrote no audit entry").toHaveLength(1);
    expect(entries![0].league_id).toBe(league!.id);

    await page.goto("/obhl/audit");
    await expect(
      page.getByText(/Scheduled a one-off game on \d{4}-\d{2}-\d{2}/).first(),
    ).toBeVisible();
  });

  test("scorekeeper cannot reach the one-off page", async ({ page }) => {
    await signInAs(page, "Scorekeeper", "/obhl/dashboard");
    await page.goto("/obhl/schedule-builder/one-off");
    await expect(page).toHaveURL("/");
  });
});

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
 * work on. This spec builds its own future season, the same way the one-off
 * games tests above do, for the same reason. It runs after them so its own
 * mutations cannot reach theirs.
 */

/** Every published game id for this spec's season, for the id-stability check. */
async function publishedGameIds(): Promise<string[]> {
  const { data } = await admin()
    .from("games")
    .select("id")
    .eq("season_id", await seasonIdOf(REPAIR_SEASON))
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
  const season = await seasonIdOf(REPAIR_SEASON);
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
  // ⛔ `nightKey`, not a rule re-derived here. A night's games spill past
  // midnight UTC, so grouping them needs the league zone — and a test that
  // reimplements that rule is one that keeps passing after the real one changes.
  const playingIds = new Set(
    (games ?? [])
      .filter((g) => g.scheduled_at && nightKey(g.scheduled_at) === date)
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

const REPAIR_SEASON = `Repair Test ${YEAR}`;

/**
 * A live season with future game nights, published. Idempotent across runs —
 * the same shape the one-off season above uses, with its own season so this
 * spec's mutations stay inside it.
 */
async function seedRepairSeason(page: Page) {
  await page.goto("/obhl/seasons");
  const row = page.getByRole("row", { name: new RegExp(REPAIR_SEASON) });
  if ((await row.count()) === 0) {
    await page.getByLabel("Name").fill(REPAIR_SEASON);
    await page.getByLabel("Season starts").fill(FIRST_NIGHT);
    await page.getByLabel("Season ends (incl. playoffs)").fill(SEASON_END);
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

  // ⚠️ REDIRECTS TO THE ACTIVE SEASON'S SETUP PAGE. Building a schedule became
  // a step of creating a season (2026-09-11), so the standalone builder — and
  // the "<season> · N teams enrolled" description this used to assert — is
  // gone. The season was just set active above, so the redirect resolves to it;
  // the setup page's own heading is what names it now.
  await page.goto("/obhl/schedule-builder");
  await expect(
    page.getByRole("heading", { name: `Season setup — ${REPAIR_SEASON}` }),
  ).toBeVisible();
  // ⛔ THE GUARD IS "IS IT PUBLISHED", NOT "IS THERE NO DRAFT". A published
  // season also has no draft, so the draft-shaped guard sent the second test
  // through a second generate — and then looked for a "Publish N games" button
  // that, with a live schedule already there, reads "Replace published
  // schedule". It cost a wasted generate per test and then failed on the button.
  if ((await page.getByText(/^Published: \d+ games$/).count()) === 0) {
    await expectGenerateFormUsable(page);
    await page.getByLabel("First game night").fill(FIRST_NIGHT);
    await page.getByLabel("Games per team").fill("6");
    // ⛔ TWO ice times, not the default three, AND THAT IS THE FIXTURE'S POINT.
    // Six teams over three sheets is three games a night, so every team plays
    // every night and the season has NO BYES AT ALL. Two sheets means four
    // teams play and two sit out, which the repair test below relies on.
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

  /** Hand obhl back to the seeded season — see the one-off season's `afterAll` above. */
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
      .eq("name", REPAIR_SEASON);
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
    await signInAs(page, "Manager", "/obhl/dashboard");
    await seedRepairSeason(page);

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

    // A free date. ⚠️ NOT because of its weekday — that reason is wrong and
    // cost a reviewer a false finding on 2026-09-07. `YEAR` floats with the
    // clock, so June 16 lands on a Tue or Thu in 2033, 2037, 2039, 2043 and
    // 2044 (an earlier revision of this comment said 2041 and 2042; those are a
    // Sunday and a Monday). It is free because this fixture generates only 18 games from
    // `FIRST_NIGHT` (6 per team, 2 sheets = 9 nights), which run Jan 11 to
    // Feb 3 — measured. June is four months past the last night, on every
    // weekday. If games_per_team ever grows enough to reach June, derive this
    // date instead of pinning the month and day.
    const before = await publishedGameIds();
    await page.getByLabel("New date").fill(`${YEAR}-06-16`);
    await page.getByRole("button", { name: "Move night" }).click();
    await expect(page.getByText(/^Moved \d+ games? from /)).toBeVisible();

    // The night is on its new date, and the picker no longer offers the old one.
    await page.goto("/obhl/schedule-builder");
    await expect(
      page.getByLabel("Night to move").locator("option", {
        hasText: `June 16, ${YEAR}`,
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
    await signInAs(page, "Manager", "/obhl/dashboard");
    await seedRepairSeason(page);

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
});

/**
 * Path 28b — the schedule page tells the truth about time.
 *
 * Two faults reported together on 2026-09-11: a game whose night had passed
 * without being scored stayed under "Upcoming" for the rest of the season, and
 * a manager was offered a Score button on fixtures months away — an invitation
 * to record the result of a game nobody has played.
 */
test.describe("Path 28b — past and future on the schedule", () => {
  test("a played game with no score leaves Upcoming for its own section", async ({
    page,
  }) => {
    const db = admin();
    const { data: past } = await db
      .from("games")
      .select(
        "id, scheduled_at, status, seasons!inner(is_active, leagues!inner(slug))",
      )
      .eq("status", "scheduled")
      .eq("is_draft", false)
      .eq("seasons.leagues.slug", "obhl")
      .eq("seasons.is_active", true)
      .lt("scheduled_at", new Date().toISOString())
      .limit(1);
    expect(
      past?.length,
      "seed has no past unscored game — the fixture leaves rounds 4 and 5 scheduled",
    ).toBeGreaterThan(0);

    await page.goto("/obhl/schedule");

    // ⛔ THE POSITION IS STILL THE POINT, AND IT MOVED. These games used to
    // have a section above Upcoming on one long page; they now have a view of
    // their own, so "first" is about the view row rather than the headings —
    // only one view renders at a time.
    //
    // ⚠️ AND THIS IS A WEAKER GUARANTEE THAN THE ONE IT REPLACES. A view is
    // further away than a section below the fold, which is how these games got
    // forgotten in the first place. The default stays Upcoming because a
    // scorekeeper's games are always tonight's and Pending holds only
    // previous nights — every row of which their day guard bounces — so the
    // COUNT on the label is what carries the urgency now. Assert it: a link
    // that lost its count would be indistinguishable from a section nobody
    // looks at.
    const views = page.getByRole("navigation", { name: "Schedule views" });
    // ⚠️ WAIT FIRST. `allInnerTexts()` does not auto-wait — it returns whatever
    // matches at the instant it runs — and this page streams, so reading it
    // straight after `goto` returns `[]` and the assertion below fails on
    // `undefined` rather than on the thing it is about.
    await expect(views.getByRole("link", { name: "Upcoming" })).toBeVisible();
    const labels = await views.getByRole("link").allInnerTexts();
    expect(labels[0]).toMatch(/^Pending \(\d+\)$/);
    expect(labels.indexOf("Upcoming")).toBe(1);

    await views.getByRole("link", { name: /^Pending/ }).click();
    await expect(page).toHaveURL(/view=pending/);
    await expect(page.getByRole("heading", { name: "Pending" })).toBeVisible();
    // The past unscored game asserted above is what fills it.
    await expect(
      page.getByText(/played with no result recorded yet/),
    ).toBeVisible();
  });

  test("a cancelled game keeps its Manage button even though it is future-dated", async ({
    page,
  }) => {
    // ⛔ THE REGRESSION THIS EXISTS FOR. The future-game gate above was first
    // written as a blanket date check, which also stripped the button off
    // CANCELLED games — whose button is "Manage", the only route to
    // `restoreGame`, not an offer to record a result. A game is normally called
    // off in advance, so that took the restore control off exactly the games
    // that have it.
    //
    // ⚠️ `7fda0e3` ("put cancelled games back on the list that absorbed them")
    // fixed the same loss from the other direction once already, and nothing
    // caught this one because the seed had no cancelled game at all. It has one
    // now, dated a fortnight out, and this is what watches it.
    await signInAs(page, "Manager", "/obhl/dashboard");
    await page.goto("/obhl/schedule");

    const section = page
      .locator("section")
      .filter({ has: page.getByRole("heading", { name: "Cancelled" }) });
    await expect(section).toBeVisible();
    await expect(
      section.getByRole("link", { name: "Manage" }).first(),
    ).toBeVisible();
  });
});

/**
 * Path 28: manual schedule edits — every one of them a trade.
 *
 * ⛔ WHAT THIS SPEC IS REALLY GUARDING: the user's constraint that total games
 * per team and games per night are non-negotiable. The UI cannot be allowed to
 * produce a schedule that breaks either, so the assertions below read the
 * COUNTS out of the database before and after each edit rather than trusting a
 * success message.
 *
 * Seeds its own future season, the shape used by the one-off and repair tests
 * above, so its mutations stay inside it.
 */

const EDIT_SEASON = `Edit Test ${YEAR}`;

/**
 * The two numbers the whole feature promises to keep, for ONE set of rows.
 *
 * `isDraft` defaults to the published side, so every caller written before the
 * draft test reads exactly as it did. A draft-side edit is only proved correct
 * by measuring both sets: the draft must keep its counts, and the published
 * schedule must not move at all.
 */
async function counts(season: string, isDraft = false) {
  const db = admin();
  const { data } = await db
    .from("games")
    .select("scheduled_at, status, home_team_id, away_team_id")
    .eq("season_id", season)
    .eq("is_draft", isDraft);
  const perTeam: Record<string, number> = {};
  const perNight: Record<string, number> = {};
  for (const g of data ?? []) {
    perTeam[g.home_team_id] = (perTeam[g.home_team_id] ?? 0) + 1;
    perTeam[g.away_team_id] = (perTeam[g.away_team_id] ?? 0) + 1;
    if (g.status !== "scheduled" || !g.scheduled_at) continue;
    const night = nightKey(g.scheduled_at);
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
    .eq("name", EDIT_SEASON)
    .maybeSingle();
  if (!season) return 0;
  const { count } = await db
    .from("games")
    .select("id", { count: "exact", head: true })
    .eq("season_id", season.id)
    .eq("is_draft", false);
  return count ?? 0;
}

type PairRow = {
  id: string;
  scheduled_at: string | null;
  status: string;
  home_team_id: string;
  away_team_id: string;
};

/**
 * The first pair of games, as indices into the panel's own list, whose night
 * swap `want` accepts: "legal" for one the server must allow, "colliding" for
 * one it must refuse.
 *
 * ⛔ COMPUTED, NOT GUESSED. A first attempt picked the first and last games and
 * the app refused it — correctly: swapping them put Bears on a night Bears
 * already played. With six teams and two games a night, most arbitrary pairs
 * collide, so a test that picks blind is testing the refusal path by accident
 * and calling it the success path.
 *
 * ⛔ AND THE COLLIDING HALF IS WHAT MAKES THE DRAFT TEST BITE, measured
 * 2026-09-08. A night swap is count-preserving whatever rows the guard read, so
 * "the counts survived" stays green even when the guard read the wrong side
 * entirely: scoping `seasonRows` to `is_draft = false` was tried, and the draft
 * test PASSED. The touched rows are then absent from `rows`, `after` comes back
 * identical, and `legalAfter`/`preserved` degrade to no-ops that permit
 * anything. Only asserting a REFUSAL tells that apart from a working guard.
 */
async function findPair(
  season: string,
  isDraft: boolean,
  want: "legal" | "colliding",
): Promise<[number, number]> {
  const db = admin();
  const { data } = await db
    .from("games")
    .select("id, scheduled_at, status, home_team_id, away_team_id")
    .eq("season_id", season)
    .eq("is_draft", isDraft)
    .order("scheduled_at", { ascending: true });

  // ⛔ THE SAME LIST THE PANEL BUILDS — and the panel filters `status ===
  // "scheduled"`, not `!== "final"`. This read `!== "final"` for one review
  // cycle and passed anyway, because the fixture happens to hold nothing but
  // scheduled games. One cancelled row and the index arithmetic below picks
  // different games than the ones it reports.
  const games = ((data ?? []) as PairRow[]).filter(
    (g) => g.scheduled_at && g.status === "scheduled",
  );
  const night = (g: PairRow) => nightKey(g.scheduled_at!);
  const teams = (g: PairRow) => [g.home_team_id, g.away_team_id];

  /** Would this night hold a team twice once `incoming` replaces `outgoing`? */
  const clashes = (on: string, outgoing: PairRow, incoming: PairRow) => {
    const others = games.filter(
      (g) => night(g) === on && g.id !== outgoing.id && g.id !== incoming.id,
    );
    const seen = new Set(others.flatMap(teams));
    return teams(incoming).some((t) => seen.has(t));
  };

  for (let i = 0; i < games.length; i++) {
    for (let j = i + 1; j < games.length; j++) {
      if (night(games[i]) === night(games[j])) continue;
      // Legal means NEITHER direction clashes; colliding means either does.
      const collides =
        clashes(night(games[i]), games[i], games[j]) ||
        clashes(night(games[j]), games[j], games[i]);
      if (collides === (want === "colliding")) return [i, j];
    }
  }
  throw new Error(
    want === "legal"
      ? "No pair of games in this fixture can legally trade nights."
      : "No pair of games in this fixture collides on a night swap.",
  );
}

const tradeablePair = (season: string, isDraft = false) =>
  findPair(season, isDraft, "legal");
const collidingPair = (season: string, isDraft = false) =>
  findPair(season, isDraft, "colliding");

/** id → scheduled_at, so "the refusal wrote nothing" is checked per row. */
async function layout(
  season: string,
  isDraft = false,
): Promise<Record<string, string>> {
  const db = admin();
  const { data } = await db
    .from("games")
    .select("id, scheduled_at")
    .eq("season_id", season)
    .eq("is_draft", isDraft);
  const out: Record<string, string> = {};
  for (const g of data ?? []) out[g.id] = g.scheduled_at ?? "";
  return out;
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
  const night = (g: (typeof games)[number]) => nightKey(g.scheduled_at!);
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

async function seedEditSeason(page: Page) {
  await page.goto("/obhl/seasons");
  const row = page.getByRole("row", { name: new RegExp(EDIT_SEASON) });
  if ((await row.count()) === 0) {
    await page.getByLabel("Name").fill(EDIT_SEASON);
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
    await signInAs(page, "Manager", "/obhl/dashboard");
    await seedEditSeason(page);
    await page.close();
  });

  test.afterAll(async () => {
    // Hand obhl back to the seeded season — see the one-off season's `afterAll` above.
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
      .eq("name", EDIT_SEASON);
  });

  test("a manager can trade two games' nights, and both counts survive", async ({
    page,
  }) => {
    const season = await seasonIdOf(EDIT_SEASON);
    const before = await counts(season);

    await signInAs(page, "Manager", "/obhl/dashboard");
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
    const season = await seasonIdOf(EDIT_SEASON);
    const before = await counts(season);

    await signInAs(page, "Manager", "/obhl/dashboard");
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
    await signInAs(page, "Manager", "/obhl/dashboard");
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

  test("a manager can move a game's time within its night, and the new time is stored", async ({
    page,
  }) => {
    const season = await seasonIdOf(EDIT_SEASON);
    const before = await counts(season);

    await signInAs(page, "Manager", "/obhl/dashboard");
    await page.goto("/obhl/schedule");
    await page.locator("#rg-game").selectOption({ index: 1 });
    const gameId = await page.locator("#rg-game").inputValue();
    const { data: original } = await admin()
      .from("games")
      .select("scheduled_at")
      .eq("id", gameId)
      .single();

    // Five minutes later on the same night: no other game holds that time.
    const at = await page.locator("#rg-at").inputValue(); // "YYYY-MM-DDTHH:MM", league-local
    const [date, time] = at.split("T");
    const [h, m] = time.split(":").map(Number);
    const minutes = h * 60 + m + 5;
    const moved = `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;

    try {
      await page.locator("#rg-at").fill(`${date}T${moved}`);
      await page.getByRole("button", { name: "Move the time" }).click();
      await expect(page.getByText("Time changed.")).toBeVisible();

      // ⛔ The STORED row, not the message: a write that did nothing reads
      // "Time changed." too if the action lies about it.
      const { data: after } = await admin()
        .from("games")
        .select("scheduled_at")
        .eq("id", gameId)
        .single();
      expect(nightKey(after!.scheduled_at!)).toBe(date);
      expect(easternTime(after!.scheduled_at!)).toBe(moved);

      const now = await counts(season);
      expect(now.perTeam).toEqual(before.perTeam);
      expect(now.perNight).toEqual(before.perNight);
    } finally {
      await admin()
        .from("games")
        .update({ scheduled_at: original!.scheduled_at })
        .eq("id", gameId);
    }
  });

  test("apply_game_writes refuses a write whose expected state has moved, and writes nothing", async () => {
    // ⚠️ AT THE FUNCTION, NOT THROUGH A PAGE: every app caller reads and writes
    // in one request, so this branch of 0045 is reachable only by a race. The
    // manager's words for it are pinned in gameWrites.test.ts.
    const db = admin();
    const season = await seasonIdOf(EDIT_SEASON);
    const { data: game } = await db
      .from("games")
      .select("id, scheduled_at, label")
      .eq("season_id", season)
      .eq("is_draft", false)
      .eq("status", "scheduled")
      .limit(1)
      .single();
    const write = (expectedAt: string) => ({
      id: game!.id,
      expect: { scheduled_at: expectedAt, label: game!.label },
      next: { label: "stale-edit-probe" },
    });
    const stale = new Date(
      new Date(game!.scheduled_at!).getTime() - 3_600_000,
    ).toISOString();

    try {
      const { data: refused, error } = await db.rpc("apply_game_writes", {
        p_season: season,
        p_writes: [write(stale)],
        p_statuses: ["scheduled"],
        p_is_draft: false,
      });
      expect(error).toBeNull();
      expect(refused).toEqual([
        { applied: 0, refused: game!.id, reason: "conflict" },
      ]);
      const { data: untouched } = await db
        .from("games")
        .select("label")
        .eq("id", game!.id)
        .single();
      expect(untouched!.label, "a refused batch wrote anyway").toBe(game!.label);

      // The control: the same write, against the time the row really holds.
      const { data: applied } = await db.rpc("apply_game_writes", {
        p_season: season,
        p_writes: [write(game!.scheduled_at!)],
        p_statuses: ["scheduled"],
        p_is_draft: false,
      });
      expect(applied).toEqual([{ applied: 1, refused: null, reason: null }]);
    } finally {
      await db.from("games").update({ label: game!.label }).eq("id", game!.id);
    }
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
    const season = await seasonIdOf(EDIT_SEASON);
    await signInAs(page, "Manager", "/obhl/dashboard");

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

  /**
   * ⛔ THE DRAFT SIDE OF THE SAME PANEL, and until this test nothing drove it.
   * Every other edit test in this file scopes to `is_draft = false`, and the one
   * above stages a draft only to edit the PUBLISHED rows underneath it — which
   * is the state that broke once, but is not the same thing as editing a draft.
   * The builder renders `ScheduleEditPanel` over `editableDrafts`
   * (`schedule-builder-panel.tsx:940`) and every action in `schedule-edits.ts`
   * derives its scope from the game's own `is_draft`, so this path shipped
   * scoped and unexercised. The manual-schedule-edits spec admits it against
   * itself: "the components render there and the actions are scoped for it, but
   * no test drives it."
   *
   * ⛔ THE SECOND ASSERTION IS THE ONE THAT EARNS ITS KEEP. A draft-side trade
   * must leave the PUBLISHED schedule completely unmoved. Reading both sets as
   * one is the exact bug this feature already had, and it is invisible from the
   * draft's own counts — they balance perfectly while the published side is
   * quietly wrong. Both `before` sets are asserted non-empty first, because
   * comparing two empty objects passes and proves nothing.
   */
  test("a manager can trade two draft games' nights, and the published schedule is untouched", async ({
    page,
  }) => {
    const season = await seasonIdOf(EDIT_SEASON);
    await signInAs(page, "Manager", "/obhl/dashboard");

    // Stage a draft over the live schedule, exactly as the test above does.
    await page.goto("/obhl/schedule-builder");
    await expectGenerateFormUsable(page);
    await page.getByLabel("First game night").fill(FIRST_NIGHT);
    await page.getByLabel("Games per team").fill("6");
    await page.getByLabel(/Ice-time slots/).fill("19:00, 20:15");
    await page.locator('label:has-text("Tue") input[name="weekdays"]').check();
    await page.locator('label:has-text("Thu") input[name="weekdays"]').check();
    await page.getByRole("button", { name: "Generate schedule" }).click();
    await expect(page.getByText("Balance report")).toBeVisible(AFTER_GENERATE);

    try {
      const publishedBefore = await counts(season);
      const draftBefore = await counts(season, true);
      // Controls: an edit that moved nothing would satisfy every equality below
      // if either set were empty.
      expect(Object.keys(draftBefore.perTeam).length).toBeGreaterThan(0);
      expect(Object.keys(publishedBefore.perTeam).length).toBeGreaterThan(0);

      // A fresh load, so the panel is rendered from the draft the server can
      // actually see rather than from whatever the generate response left up.
      await page.goto("/obhl/schedule-builder");
      await expect(page.getByText("Change this schedule")).toBeVisible();

      // ⛔ THE DRAFT'S OWN LIST. `editableDrafts` filters `status ===
      // "scheduled"` and orders by `scheduled_at` — the same shape
      // `tradeablePair` walks — so these indices address the panel's select only
      // when it reads the DRAFT rows. Omitting the `true` here picks from the
      // published set and silently swaps the wrong two games.
      const [i, j] = await tradeablePair(season, true);
      // ⛔ ROW-LEVEL, AND CAPTURED BEFORE THE CLICK. The count assertions below
      // cannot see whether this edit happened at all: a night swap preserves
      // per-team and per-night totals by construction, so they hold just as well
      // when nothing was written. Measured 2026-09-08 — making `exchangeSlots`
      // return `{ ok: true }` without calling `writeGames` for a draft row left
      // the whole spec green. The two ids below are the only thing that notices.
      const before = await layout(season, true);
      // Option 0 is the placeholder, so game `k` sits at `k + 1`; `#tn-y` drops
      // whatever `#tn-x` holds, so for `j > i` that game shifts down to `j`.
      await page.locator("#tn-x").selectOption({ index: i + 1 });
      await page.locator("#tn-y").selectOption({ index: j });
      await page.getByRole("button", { name: "Swap their nights" }).click();
      await expect(page.getByText("Nights traded.")).toBeVisible();

      // The two games actually traded nights, and nothing else in the draft
      // moved. `swapped` is asserted non-empty so a lookup that found neither
      // id cannot pass as "both unchanged".
      const traded = await layout(season, true);
      const swapped = Object.keys(before).filter(
        (id) => before[id] !== traded[id],
      );
      expect(swapped).toHaveLength(2);
      const [a, b] = swapped;
      // ⛔ THE WHOLE TIMESTAMP, NOT THE NIGHT KEY. `exchangeSlots` swaps entire
      // `scheduled_at` values, so comparing them is exactly as true as comparing
      // nights and strictly stronger: a write that lands the right NIGHTS but
      // loses the ice times passes a night-level check. Measured 2026-09-08 —
      // moving both rows to the other's night 30 minutes later kept this test
      // green until it compared timestamps. It also makes a vanished row fail as
      // a named assertion rather than throwing `RangeError` inside `nightKey`.
      expect(traded[a]).toBe(before[b]);
      expect(traded[b]).toBe(before[a]);

      const draftAfter = await counts(season, true);
      expect(draftAfter.perTeam).toEqual(draftBefore.perTeam);
      expect(draftAfter.perNight).toEqual(draftBefore.perNight);

      const publishedAfter = await counts(season);
      expect(publishedAfter.perTeam).toEqual(publishedBefore.perTeam);
      expect(publishedAfter.perNight).toEqual(publishedBefore.perNight);

      // ⛔ THE ASSERTION THAT ACTUALLY PROVES THE SCOPING — see `collidingPair`
      // for the measurement that showed everything above this line stays green
      // against a guard reading the published set. An illegal DRAFT trade has to
      // be refused by name, and a guard reading the wrong rows cannot see the
      // collision at all: it would report "Nights traded." and this goes red.
      await page.goto("/obhl/schedule-builder");
      await expect(page.getByText("Change this schedule")).toBeVisible();
      const settled = await layout(season, true);
      const settledPublished = await layout(season);
      const [ci, cj] = await collidingPair(season, true);
      await page.locator("#tn-x").selectOption({ index: ci + 1 });
      await page.locator("#tn-y").selectOption({ index: cj });
      await page.getByRole("button", { name: "Swap their nights" }).click();
      await expect(page.getByText(/would play twice on/)).toBeVisible();

      // And a refusal writes nothing — per row, not per count, because the
      // counts would survive the write it must not have made. Both sides are
      // checked: a wrongly-scoped refusal that wrote to the PUBLISHED schedule
      // would leave the draft untouched and slip past a draft-only assertion.
      expect(await layout(season, true)).toEqual(settled);
      expect(await layout(season)).toEqual(settledPublished);
    } finally {
      // Put the fixture back for whatever runs next.
      await page.goto("/obhl/schedule-builder");
      const discard = page.getByRole("button", { name: "Discard draft" });
      if ((await discard.count()) > 0) await discard.click();
      await expect(page.getByText("No draft schedule")).toBeVisible();
    }
  });

  /**
   * ⛔ THE HIDDEN-BUTTON HALF AND THE GUARD HALF ARE DIFFERENT CLAIMS. Hiding a
   * control is not a permission; the action has to refuse too. The user's rule
   * as of 2026-09-07: scorekeepers "can only score games".
   *
   * ⚠️ SO THIS TESTS THE BACKSTOP, NOT THE GUARD. Playwright cannot post a Next
   * server action — the action id is a build artefact — so what is asserted
   * here is the RLS half from `ACCESS_CONTROL_HANDOFF.md`.
   *
   * ⛔ THIS WAS A `fixme` FOR ONE COMMIT, AND THE REASON IS WORTH KEEPING. It
   * failed when written: a scorekeeper's own anon-key session cancelled a
   * published game outright, with no error. `0032`'s "scorekeeper update games"
   * policy is `for update` over the WHOLE ROW — RLS cannot restrict columns —
   * so a scorekeeper of that league wrote `status`, `scheduled_at` and both
   * team ids as freely as goals.
   *
   * The policy was PRE-EXISTING (0009, revised in 0032) and correct while
   * scorekeepers were legitimate cancellers. The 2026-09-07 rule — scorekeepers
   * "can only score games" — is what made it a hole, by moving four actions to
   * manager-only guards with nothing behind them.
   *
   * `0046`'s BEFORE UPDATE trigger closes it. ⚠️ IF THIS TEST FAILS AGAIN, THE
   * TRIGGER IS GONE OR HAS BEEN NARROWED — it is not a flake, and the fix is
   * never to skip it.
   */
  test("a scorekeeper's own session cannot change a game's schedule state", async () => {
    const season = await seasonIdOf(EDIT_SEASON);
    const { data: game } = await admin()
      .from("games")
      .select("id, status, scheduled_at")
      .eq("season_id", season)
      .eq("is_draft", false)
      .eq("status", "scheduled")
      .limit(1)
      .single();
    expect(game, "the fixture has no scheduled published game").toBeTruthy();

    const scorer = await signedInClient("scorekeeper@obhl.test");
    const { error } = await scorer
      .from("games")
      .update({ status: "cancelled" })
      .eq("id", game!.id);

    // ⚠️ READ THE ROW BACK, DO NOT TRUST `error`. Which of the two mechanisms
    // refuses this decides whether `error` is even set: RLS refuses by matching
    // NO ROWS and reports success, while `0046`'s trigger raises 42501. Today
    // the trigger fires first, so `error` is non-null — but an assertion built
    // on that would silently stop testing anything if the trigger were narrowed
    // and RLS became the only thing left. The row's own state is the fact.
    const { data: after } = await admin()
      .from("games")
      .select("status")
      .eq("id", game!.id)
      .single();
    expect(
      after!.status,
      `scorekeeper changed a game's status (update error: ${error?.message ?? "none"})`,
    ).toBe("scheduled");
  });

  /**
   * ⚠️ THE TEST ABOVE COVERS ONE ARM OF `0046`. The trigger protects eight
   * columns and the status transition; asserting only `status` would let any of
   * the others be dropped without a failure, which is how `label` came to be
   * missing from the list in the first place.
   */
  test("a scorekeeper cannot move a game, re-team it, or hide it in a draft", async () => {
    const season = await seasonIdOf(EDIT_SEASON);
    const { data: game } = await admin()
      .from("games")
      .select("id, scheduled_at, home_team_id, away_team_id, label, is_draft")
      .eq("season_id", season)
      .eq("is_draft", false)
      .eq("status", "scheduled")
      .limit(1)
      .single();
    expect(game, "the fixture has no scheduled published game").toBeTruthy();

    const scorer = await signedInClient("scorekeeper@obhl.test");
    const arms: [string, Record<string, unknown>][] = [
      ["scheduled_at", { scheduled_at: "2031-01-01T19:00:00+00:00" }],
      ["home_team_id", { home_team_id: game!.away_team_id }],
      ["is_draft", { is_draft: true }],
      ["label", { label: "scorekeeper-was-here" }],
    ];

    for (const [name, patch] of arms) {
      await scorer.from("games").update(patch).eq("id", game!.id);
      const { data: after } = await admin()
        .from("games")
        .select("scheduled_at, home_team_id, is_draft, label")
        .eq("id", game!.id)
        .single();
      // Read the row back rather than trusting the error — see the note above.
      expect(after, `scorekeeper changed ${name}`).toMatchObject({
        scheduled_at: game!.scheduled_at,
        home_team_id: game!.home_team_id,
        is_draft: game!.is_draft,
        label: game!.label,
      });
    }
  });

  /**
   * ⛔ THE SECOND DOOR, WHICH `0046`'s COMMIT MESSAGE CLAIMED TO CLOSE AND NO
   * TEST TOUCHED. `postpone_game` and `restore_game` (`0025`) are
   * `security invoker` and granted to `authenticated`, so a scorekeeper can call
   * them directly and never go near the `games` table themselves. Being invoker,
   * their UPDATE runs as the caller and lands in the trigger — but that is a
   * claim, and it was worth making it executable.
   */
  test("a scorekeeper cannot postpone a game through the RPC either", async () => {
    const season = await seasonIdOf(EDIT_SEASON);
    const { data: game } = await admin()
      .from("games")
      .select("id, status")
      .eq("season_id", season)
      .eq("is_draft", false)
      .eq("status", "scheduled")
      .limit(1)
      .single();

    const scorer = await signedInClient("scorekeeper@obhl.test");
    await scorer.rpc("postpone_game", { p_game: game!.id });

    const { data: after } = await admin()
      .from("games")
      .select("status")
      .eq("id", game!.id)
      .single();
    expect(after!.status, "scorekeeper postponed a game via RPC").toBe(
      "scheduled",
    );
  });
});
