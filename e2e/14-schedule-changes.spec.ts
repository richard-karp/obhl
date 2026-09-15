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

/** A signed-in ANON-key client: the access a browser session has, so what RLS really permits. */
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

// ⛔ Computed, never pinned: a literal season year breaks once the clock reaches it.
const YEAR = new Date().getUTCFullYear() + 2;
const FIRST_NIGHT = `${YEAR}-01-05`;
const SEASON_END = `${YEAR}-06-30`;

/** See `11-schedule-build.spec.ts` — Phase S runs five candidates. */
const AFTER_GENERATE = { timeout: 45_000 };

// ⛔ Not a retry: fails by name if the builder came up locked (`readFailed` or `started`), where a bare
// `fill()` times out naming only the locator. Call it before any gate that reads the panel.
async function expectGenerateFormUsable(page: Page) {
  // ⚠️ Copied on purpose: a relative TS import dies at load in this suite (`context.conditions
  // ?.includes is not a function`). Change one copy, change both; there are two, here and in 11.
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

// ⛔ The Eastern date, not `toISOString().slice(0, 10)`: 19:00 EST is 00:00 UTC, and under EDT one
// night splits across two UTC dates, so `clashes` would pick a pair the server refuses.
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
    // Wait for `createSeason`'s redirect, then re-navigate: asserting on /seasons straight after the
    // click races that navigation, and the toast renders on the page being left.
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

  // Make it the live season and confirm it took: the builder works on the active season, so a miss
  // silently generates against the wrong one.
  await page.goto("/obhl/seasons");
  const setActive = row.getByRole("button", { name: "Set active" });
  if ((await setActive.count()) > 0) await setActive.click();
  // Only inactive seasons render "Set active", so its absence proves the switch. Not the "Active"
  // badge: `getByText` matches substrings, including "Set active".
  await expect(setActive).toHaveCount(0);

  // ⚠️ Redirects to the active season's setup page, whose heading names it.
  await page.goto("/obhl/schedule-builder");
  await expect(
    page.getByRole("heading", { name: `Season setup — ${ONE_OFF_SEASON}` }),
  ).toBeVisible();
  // ⛔ Before the gate, not inside it: the read-failed card makes the condition false, skipping the
  // seed and failing somewhere unrelated.
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
    // Wait for the publish to land: leaving mid-action shows the one-off page an all-draft season,
    // which renders "No published schedule" instead of the form.
    await expect(page.getByText("No draft schedule")).toBeVisible();
  }
}

test.describe("Path 22 — one-off games", () => {
  // Hand obhl back to the seeded season. Only which season is ACTIVE is restored, since other specs
  // read it; the one-off season is kept for a post-mortem.
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

    const since = new Date(Date.now() - 5_000).toISOString();
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
      .eq("entity_id", season!.id)
      .gte("created_at", since);
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

// ⛔ Every write here is an in-place `games` UPDATE, never `replace_published_schedule`: these tools
// must work on a started season, and the id-stability checks hold that line.

async function publishedGameIds(): Promise<string[]> {
  const { data } = await admin()
    .from("games")
    .select("id")
    .eq("season_id", await seasonIdOf(REPAIR_SEASON))
    .eq("is_draft", false);
  return (data ?? []).map((g) => g.id).sort();
}

// ⛔ Read from the database, never found by clicking teams: a loop stopping at the first hit cannot
// tell a working branch from a fixture with no byes.
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
  // ⛔ `nightKey`, not a rule re-derived here: a test reimplementing it keeps passing after the real
  // one changes.
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

/** A live, published season with future nights, idempotent; its own, so mutations stay inside it. */
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

  // ⚠️ Redirects to the active season's setup page, whose heading names it.
  await page.goto("/obhl/schedule-builder");
  await expect(
    page.getByRole("heading", { name: `Season setup — ${REPAIR_SEASON}` }),
  ).toBeVisible();
  // ⛔ Guard on "is it published", not "no draft": a published season has no draft either, and a
  // second generate then finds "Replace published schedule" where it expects "Publish N games".
  if ((await page.getByText(/^Published: \d+ games$/).count()) === 0) {
    await expectGenerateFormUsable(page);
    await page.getByLabel("First game night").fill(FIRST_NIGHT);
    await page.getByLabel("Games per team").fill("6");
    // ⛔ TWO ice times, the fixture's point: on three, all six teams play every night and there are no
    // byes; on two, two sit out, which the repair test relies on.
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

    // Free because this fixture's 18 games end in early February, not because of its weekday (`YEAR`
    // floats). ⚠️ If games per team grows enough to reach June, derive this date.
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

    // ⛔ Pending is a view, further away than a section, so the COUNT on its label carries the urgency.
    // Assert it, or a link that lost its count passes.
    const views = page.getByRole("navigation", { name: "Schedule views" });
    // ⚠️ Wait first: `allInnerTexts()` doesn't auto-wait, and this page streams, so it would read `[]`.
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
    // ⛔ A future-date gate must not strip "Manage" off CANCELLED games: it is the only route to
    // `restoreGame`, and games are called off in advance. The seed's fortnight-out cancellation is it.
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

// ⛔ Games per team and games per night are non-negotiable, so every edit test reads the COUNTS from
// the database before and after rather than trusting a success message.

const EDIT_SEASON = `Edit Test ${YEAR}`;

// Games per team and per night for ONE set of rows, published by default. A draft-side edit is proved
// only by measuring both: the draft keeps its counts and the published side doesn't move.
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

// ⛔ Computed, not guessed: most pairs collide, so a blind pick tests the refusal path as success.
// ⛔ The colliding half is what catches a guard reading the wrong side: a night swap keeps every count.
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

  // ⛔ The same list the panel builds: it filters `status === "scheduled"`, and one cancelled row
  // otherwise shifts the indices onto different games.
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

// [gameIndexA, gameIndexB, teamNameA, teamNameB] for two teams that can legally trade places;
// computed for the same reason as `tradeablePair`.
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
  // ⛔ Gate on the database, not the page: a fully published season also shows "No draft schedule",
  // and regenerating over it finds "Replace published schedule" instead of "Publish N games".
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
    // ⚠️ Option 0 is the placeholder, so game `k` is at `k + 1`; `#tn-y` drops what `#tn-x` holds, so
    // for `j > i` that game lands at index `j`.
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

    // ⛔ A deterministic pair, and the success path asserted: accepting a refusal too would pass
    // against a feature that refused everything.
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

    // ⛔ Assert the action's sentence, not the panel's: the form's static help says "Same night only",
    // so `/same night/i` matched before any click.
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
    // ⚠️ At the function, not a page: every app caller reads and writes in one request, so this
    // branch of 0045 is reachable only by a race.
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

  // ⛔ A published schedule AND a staged draft at once, which nothing else creates: reading both sets as
  // one refused every edit, and let a trade pair a published game with a draft one.
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

  // ⛔ The draft side of the panel: a draft trade must also leave the PUBLISHED schedule unmoved,
  // which the draft's own counts cannot show.
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

      // ⛔ The DRAFT's own list (`true`): the indices address the panel's select only when read from
      // the draft rows; omitting it silently swaps the wrong two games.
      const [i, j] = await tradeablePair(season, true);
      // ⛔ Row-level, captured before the click: a night swap preserves every count, so the counts
      // hold when nothing was written. These ids are the only thing that notices.
      const before = await layout(season, true);
      // Option 0 is the placeholder, so game `k` sits at `k + 1`; `#tn-y` drops
      // whatever `#tn-x` holds, so for `j > i` that game shifts down to `j`.
      await page.locator("#tn-x").selectOption({ index: i + 1 });
      await page.locator("#tn-y").selectOption({ index: j });
      await page.getByRole("button", { name: "Swap their nights" }).click();
      await expect(page.getByText("Nights traded.")).toBeVisible();

      // The two games traded nights and nothing else moved; `swapped` has length 2, so a lookup that
      // found neither id cannot pass as "both unchanged".
      const traded = await layout(season, true);
      const swapped = Object.keys(before).filter(
        (id) => before[id] !== traded[id],
      );
      expect(swapped).toHaveLength(2);
      const [a, b] = swapped;
      // ⛔ The whole timestamp, not the night key: a write landing the right nights but losing the
      // ice times passes a night-level check.
      expect(traded[a]).toBe(before[b]);
      expect(traded[b]).toBe(before[a]);

      const draftAfter = await counts(season, true);
      expect(draftAfter.perTeam).toEqual(draftBefore.perTeam);
      expect(draftAfter.perNight).toEqual(draftBefore.perNight);

      const publishedAfter = await counts(season);
      expect(publishedAfter.perTeam).toEqual(publishedBefore.perTeam);
      expect(publishedAfter.perNight).toEqual(publishedBefore.perNight);

      // ⛔ The assertion that proves the scoping (see `findPair`): a guard reading the wrong rows
      // cannot see this collision and would report "Nights traded.".
      await page.goto("/obhl/schedule-builder");
      await expect(page.getByText("Change this schedule")).toBeVisible();
      const settled = await layout(season, true);
      const settledPublished = await layout(season);
      const [ci, cj] = await collidingPair(season, true);
      await page.locator("#tn-x").selectOption({ index: ci + 1 });
      await page.locator("#tn-y").selectOption({ index: cj });
      await page.getByRole("button", { name: "Swap their nights" }).click();
      await expect(page.getByText(/would play twice on/)).toBeVisible();

      // A refusal writes nothing, per row (counts would survive the write), on both sides: a wrongly
      // scoped refusal writing the PUBLISHED schedule would slip past a draft-only check.
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

  // ⛔ Hiding a control is not a permission; a server action can't be posted from here, so this tests `0046`'s
  // trigger (`RUNBOOK.md` → Access control → Traps). ⚠️ If it fails the trigger was narrowed: never skip it.
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

    // ⚠️ Read the row back, not `error`: RLS refuses silently and only the trigger raises 42501, so an
    // assertion on `error` stops testing anything once the trigger is narrowed.
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

  // ⚠️ The test above covers one arm of `0046`: assert each protected column, or one can be dropped
  // from the trigger with no failure.
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

  // ⛔ The second door: `postpone_game` and `restore_game` (`0025`) are security invoker and granted
  // to `authenticated`, so a scorekeeper can call them directly; their UPDATE must hit the trigger.
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
