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
 * Seeds its own season, the shape `29-schedule-repair` and `30-schedule-edits`
 * use, so every mutation stays inside it. That season is deleted afterwards
 * rather than left behind: the last test publishes a past-dated schedule on
 * purpose, which locks it for good, and a locked season is not something to
 * hand to the next run.
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
 * ⛔ COMPUTED, NEVER PINNED — the rule `30-schedule-edits` sets out. Every date
 * here is relative to the clock, because this spec is *about* the clock: a
 * fixed "stale" date stops being stale the moment it is compared against a
 * later today, and a fixed future one eventually is not future.
 */
const YEAR = new Date().getUTCFullYear() + 2;
const SEASON = `Stale Draft ${YEAR}`;

/** The league plays on US Eastern, and so does every date the app renders. */
const TZ = "America/New_York";

/**
 * ⚠️ THE SPEC DOES ITS OWN ZONE ARITHMETIC RATHER THAN IMPORTING THE APP'S.
 * Copied deliberately: a relative TypeScript import dies at load in this suite
 * (see `30-schedule-edits`), and reusing `@/lib/format` would in any case let a
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

/** "September 8, 2026" — what `formatLongDate` renders for a calendar date. */
const longDate = (date: string) =>
  new Date(`${date}T12:00:00Z`).toLocaleDateString("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });

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

/** See `11-schedule-builder.spec.ts` — Phase S runs five candidates. */
const AFTER_GENERATE = { timeout: 45_000 };

async function signedInAs(page: Page, role: "Manager") {
  await page.goto("/login");
  await page.getByRole("button", { name: role }).click();
  await page.waitForURL("/");
  await page.goto("/obhl/dashboard");
}

/**
 * Wait for the generate form, and fail IMMEDIATELY and by name if the builder
 * came up in either state that has no form on the page.
 *
 * ⚠️ COPIED, AND IT HAS TO BE. A shared `e2e/*.ts` module was built and measured
 * on 2026-09-06: every relative TypeScript import dies at load with
 * `context.conditions?.includes is not a function`. Change one copy, change all.
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

async function leagueId(): Promise<string> {
  const { data } = await admin()
    .from("leagues")
    .select("id")
    .eq("slug", "obhl")
    .single();
  return data!.id as string;
}

/** The seeded season, created fresh so a previous run's leftovers cannot skew it. */
async function seedSeason(): Promise<string> {
  const db = admin();
  const league = await leagueId();

  // Cascades to its games and enrolments. Scoped to this spec's own season name
  // — nothing else in the fixture is named this — and it runs first so a run
  // that died mid-way (leaving a locked, published season behind) cannot make
  // the next one fail for a reason that has nothing to do with the feature.
  await db.from("seasons").delete().eq("league_id", league).eq("name", SEASON);

  const { data: season, error } = await db
    .from("seasons")
    .insert({
      league_id: league,
      name: SEASON,
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
    season = await seedSeason();

    const page = await browser.newPage();
    await signedInAs(page, "Manager");
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
      .eq("name", SEASON);
  });

  test("warns that the draft's first night has passed, and confirms before publishing it", async ({
    page,
  }) => {
    // `generatedFirst` is where the generator put the first night; `staleFirst`
    // is where it sits now, three weeks earlier, and is the one the warning
    // names.
    const generatedFirst = dateKey(asGenerated[0].scheduled_at!);
    const staleFirst = plusDays(generatedFirst, -7 * AGE_WEEKS);

    await signedInAs(page, "Manager");
    await page.goto(`/obhl/seasons/${season}`);

    // The warning names the night, so a manager can tell it from the dates in
    // the list below it.
    await expect(
      page.getByText(`This draft's first game night (${longDate(staleFirst)})`),
    ).toBeVisible();

    // ⛔ THE ASSERTION THAT MATTERS. A first publish is one click on a healthy
    // draft; on this one it must stop and say what it costs. If this ever
    // publishes directly, the season is locked and there is no undo.
    await page.getByRole("button", { name: /^Publish \d+ games$/ }).click();
    const dialog = page.getByRole("dialog");
    await expect(
      dialog.getByText("Publish a schedule that starts in the past?"),
    ).toBeVisible();
    await expect(dialog.getByText("There is no undo.")).toBeVisible();

    await dialog.getByRole("button", { name: "Cancel" }).click();
    expect(await publishedGames(season)).toHaveLength(0);
    expect(await draftGames(season)).toHaveLength(asGenerated.length);
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
    await signedInAs(page, "Manager");
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
    await signedInAs(page, "Manager");
    await page.goto(`/obhl/seasons/${season}`);

    await page.getByRole("button", { name: /^Move draft to / }).click();
    // ⚠️ ASSERTING A SUCCESS TOAST IS ONLY SAFE BECAUSE OF HOW THE BANNER IS
    // BUILT. `StaleDraftNotice` stays mounted when the draft stops being stale
    // and renders null instead, precisely so this message is not lost to the
    // remount race `28-schedule-form-state.spec.ts` documents. Move the action
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

  test("a draft whose dates are ahead still publishes in one click", async ({
    page,
  }) => {
    await signedInAs(page, "Manager");
    await page.goto(`/obhl/seasons/${season}`);

    await page.getByRole("button", { name: /^Publish \d+ games$/ }).click();

    // No dialog: the confirmation exists for the stale case and for a replace,
    // and this is neither. A guard that also stopped healthy publishes would
    // pass every other assertion in this file.
    await expect(page.getByText("No draft schedule")).toBeVisible();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    expect(await publishedGames(season)).toHaveLength(asGenerated.length);
    expect(await draftGames(season)).toHaveLength(0);
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

    await signedInAs(page, "Manager");
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
    // note in `28-schedule-form-state.spec.ts`. What lands here instead is the
    // one-way door itself: the published games are now in the past, so the
    // season is started and the builder locks on the spot.
    await expect(page.getByText("The season is under way")).toBeVisible();

    const live = await publishedGames(season);
    expect(live).toHaveLength(asGenerated.length);
    expect(dateKey(live[0].scheduled_at!) < today()).toBe(true);
    expect(await draftGames(season)).toHaveLength(0);
  });
});
