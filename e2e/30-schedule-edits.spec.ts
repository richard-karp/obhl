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
 * ⛔ COMPUTED, NEVER PINNED. `11-` and `23-` USED to hardcode 2026-09-15, which
 * would have broken the day after it passed; they now read the date from the
 * seed, and this spec seeds its own season from the clock for the same reason.
 * Far enough out that the season can never be "started" while this suite runs.
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
  // A scorekeeper lands on `/tonight`, not the picker.
  await page.waitForURL(role === "Scorekeeper" ? "/tonight" : "/");
  await page.goto("/obhl/dashboard");
}

/**
 * A signed-in ANON-key client — the same access a browser session has, and the
 * only way this suite can ask what RLS actually permits. Same shape as
 * `16-league-membership.spec.ts`.
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

/**
 * Path 28 addendum — the Schedule tab carries every in-season tool.
 *
 * ⛔ WHAT THIS TESTS IS PLACEMENT AND GATING, NOT THE FORM. `RescheduleNightForm`
 * itself is exercised on the builder side; what was missing until 2026-09-11 is
 * that a manager looking at `/schedule` — the only surface a STARTED season has
 * — could not move a night from there at all. It was the one control the locked
 * builder had and this page did not.
 */
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
    // scorekeeper's games are always tonight's and To score holds only
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
    expect(labels[0]).toMatch(/^To score \(\d+\)$/);
    expect(labels.indexOf("Upcoming")).toBe(1);

    await views.getByRole("link", { name: /^To score/ }).click();
    await expect(page).toHaveURL(/view=to-score/);
    await expect(page.getByRole("heading", { name: "To score" })).toBeVisible();
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
    await signedInAs(page, "Manager");
    await page.goto("/obhl/schedule");

    const section = page
      .locator("section")
      .filter({ has: page.getByRole("heading", { name: "Cancelled" }) });
    await expect(section).toBeVisible();
    await expect(
      section.getByRole("link", { name: "Manage" }).first(),
    ).toBeVisible();
  });

  test("nobody is offered a Score button on a game not yet played", async ({
    page,
  }) => {
    const db = admin();
    const { data: season } = await db
      .from("seasons")
      .select("id, leagues!inner(slug)")
      .eq("leagues.slug", "obhl")
      .eq("is_active", true)
      .single();
    const { data: teams } = await db
      .from("season_teams")
      .select("team_id")
      .eq("season_id", season!.id)
      .limit(2);

    // ⚠️ CREATED, NOT FOUND. The seed anchors everything ~120 days back and its
    // only "today" fixture is tonight's three games, so the active season has
    // no FUTURE game to assert against — the case being fixed is unreachable
    // without making one.
    const future = new Date();
    future.setDate(future.getDate() + 21);
    // ⛔ COUNTED BEFORE AND AFTER, NOT SCOPED TO THE ROW. The first attempt
    // located the row by its label and asserted no Score link inside it — and
    // that passed with the gate REMOVED, because the locator resolved to the
    // innermost element carrying the label (the badge), which never contains a
    // link. Mutation testing caught it. The number of Score buttons on the
    // page is not something a bad locator can satisfy by accident: adding a
    // future game must not add one.
    // ⚠️ THE LABELS AS `scoreLabel()` WRITES THEM. It is "Edit" on a final
    // game and "Manage" on a cancelled or postponed one — not "Edit score".
    // The first version of this matched none of them and read 0 buttons for a
    // manager who plainly has them; the control below is what said so.
    const scoreLinks = page.getByRole("link", {
      name: /^(Score|Edit|Manage)$/,
    });

    await signedInAs(page, "Manager");
    await page.goto("/obhl/schedule");
    // ⚠️ WAIT BEFORE COUNTING. `count()` does not auto-wait like an assertion
    // does, so reading it straight after `goto` returns 0 whether or not the
    // buttons are coming — which is how the control below first "failed".
    await expect(scoreLinks.first()).toBeVisible();
    const before = await scoreLinks.count();
    // The control: a manager DOES get buttons here, on games already played.
    // Without this the assertion below would also pass if the button had been
    // removed for everybody, which is a different bug.
    expect(before).toBeGreaterThan(0);

    const LABEL = "E2E future fixture";
    const { data: made, error } = await db
      .from("games")
      .insert({
        season_id: season!.id,
        home_team_id: teams![0].team_id,
        away_team_id: teams![1].team_id,
        scheduled_at: future.toISOString(),
        status: "scheduled",
        is_draft: false,
        label: LABEL,
      })
      .select("id")
      .single();
    expect(error, `could not seed a future game: ${error?.message}`).toBeNull();

    try {
      await page.reload();
      // It is on the page, under Upcoming...
      await expect(page.getByText(LABEL)).toBeVisible();
      // ...and brought no Score button with it.
      await expect(scoreLinks).toHaveCount(before);
    } finally {
      await db.from("games").delete().eq("id", made!.id);
    }
  });
});

test.describe("Path 28 — moving a night from the Schedule tab", () => {
  test("a manager gets the control on /schedule; a scorekeeper does not", async ({
    page,
  }) => {
    await signedInAs(page, "Manager");
    await page.goto("/obhl/schedule");
    await expect(
      page.getByRole("heading", { name: "Move a game night" }),
    ).toBeVisible();

    // ⚠️ EITHER SHAPE, AND DELIBERATELY SO. Whether this season has a movable
    // night depends on which season is active when the test runs, and earlier
    // tests in this file seed future seasons and set them active — so pinning
    // one shape here makes the test order-dependent. Both are correct: a picker
    // when nights remain, the form's own explanation when they are all behind
    // us. What must hold either way is that the CARD is here, which is why it
    // is gated on the season having published games rather than movable ones —
    // gating on the latter would hide the explanation at the moment it is the
    // answer, and would diverge from the builder's `liveCount > 0`.
    const picker = page.locator('select[name="from_date"]');
    const nothingToMove = page.getByText(/none left to move/i);
    await expect(picker.or(nothingToMove).first()).toBeVisible();

    // ⛔ `canManageLeague`, NOT `canScore`. A scorekeeper can open this page —
    // the games list is public and they score from it — but `rescheduleNight`
    // refuses them, and a control whose only outcome is a refusal reads as a
    // broken page rather than as a boundary. Same call the edit panel makes.
    await signedInAs(page, "Scorekeeper");
    await page.goto("/obhl/schedule");
    await expect(
      page.getByRole("heading", { name: "Move a game night" }),
    ).toHaveCount(0);
  });
});

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
    const season = await seasonId();
    await signedInAs(page, "Manager");

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
    // ⛔ VIA `/tonight`, NOT VIA A LEAGUE'S SCHEDULE, AND BOTH HALVES OF
    // THAT MATTER.
    //
    // A scorekeeper may only open games dated TODAY, and `/obhl/schedule`
    // resolves to whatever season is ACTIVE — which, by the time this test runs,
    // is the "Edit Test 2028" season the tests above create and activate. Every
    // game in it is dated January 2028, so the scorekeeper correctly sees no
    // scoresheet link at all and this test found nothing. That is the feature
    // working, not a bug: measured against the real page, which showed an
    // "Upcoming" list of 2028 dates and zero buttons.
    //
    // Their own page is season-agnostic — it filters by DATE across every league
    // they keep score for — so it always has tonight's games regardless of which
    // season some other test left active.
    //
    // ⚠️ And by HREF rather than the "Score" label: `scoreLabel` renders a final
    // game as "Edit", and tonight's three games are a shared fixture that
    // `05-scoring` and `33-scorekeeper-day` each finalize one of.
    await signedInAs(page, "Scorekeeper");
    await page.goto("/tonight");
    const score = page.locator('a[href$="/score"]').first();
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

  /**
   * ⛔ THE OTHER HALF OF THE CLAIM ABOVE. Hiding four buttons proves only that
   * the page hides four buttons. The guard change moved `cancelGame`,
   * `postponeGame`, `restoreGame` and `rescheduleGame` from
   * `requireGameRole(id, "scorekeeper", "league_manager")` to manager-only, and
   * a browser cannot reach a server action without the page that renders it.
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
    const season = await seasonId();
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
    const season = await seasonId();
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
    const season = await seasonId();
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
