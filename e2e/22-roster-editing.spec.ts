/**
 * Path 22: roster editing — number and position, the global name, the
 * league-scoped archive, and adding somebody who is already on another team.
 *
 * ⚠️ EVERY FIXTURE HERE IS DERIVED AT RUN TIME, never named. This file runs
 * last, after 04 and 19 have added, removed and transferred players, so any
 * hard-coded name or jersey number is a test that passes alone and fails in the
 * suite — the failure mode 19's own header records.
 *
 * Two of these need BOTH seeded leagues (`obhl` and `harbor`) and the two people
 * the seed rosters in each, because the questions they ask — "does archiving in
 * one league touch the other" and "may a one-league manager rename someone who
 * plays elsewhere" — are unanswerable inside a single league.
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

async function signInAs(page: Page, label: "Manager" | "One-league mgr") {
  await page.goto("/login");
  await page.getByRole("button", { name: label }).click();
  await page.waitForURL("/");
}

async function activeSeason(slug: string) {
  const db = admin();
  const { data: league } = await db.from("leagues").select("id").eq("slug", slug).single();
  const { data: season } = await db
    .from("seasons")
    .select("id")
    .eq("league_id", league!.id)
    .eq("is_active", true)
    .single();
  return { leagueId: league!.id as string, seasonId: season!.id as string };
}

async function teamName(teamId: string) {
  const { data } = await admin().from("teams").select("name").eq("id", teamId).single();
  return data!.name as string;
}

async function playerName(playerId: string) {
  const { data } = await admin()
    .from("players")
    .select("first_name, last_name")
    .eq("id", playerId)
    .single();
  return `${data!.first_name} ${data!.last_name}`;
}

/** Open a team's roster editor by name, from the rosters index. */
async function openRoster(page: Page, slug: string, team: string) {
  await page.goto(`/${slug}/manage/rosters`);
  await page.getByText(team, { exact: true }).first().click();
  await expect(page).toHaveURL(/\/rosters\//);
}

/** The row for one player on the open roster editor. */
function rowFor(page: Page, name: string) {
  return page.locator("table tbody tr").filter({ hasText: name });
}

/** Type into the combobox and wait for the list to narrow. */
async function search(page: Page, name: string) {
  const field = page.getByLabel("Existing person (optional)");
  await field.click();
  await field.fill(name);
}

/**
 * A person who exists only for the test that asked for them, rostered onto one
 * named team.
 *
 * ⛔ DERIVED-AT-RUN-TIME WAS NOT ENOUGH. The header above is right that a
 * hard-coded name cannot survive 04 and 19 — but "pick whatever the database
 * happens to hold" does not survive them either, and fails more confusingly:
 * these two tests passed 6/6 alone and 4/6 in the suite, because `.limit(1)`
 * picked a different person once earlier specs had moved people around, and one
 * of them looked for a Harbor-only player after another spec had put every
 * Harbor player into Oceanview too.
 *
 * Owning the fixture is the fix. The subject is created here, so no earlier
 * spec can change who it is or what has already happened to them.
 */
async function scratchSkater(opts: {
  seasonId: string;
  teamId: string;
  tag: string;
}): Promise<{ playerId: string; name: string }> {
  const db = admin();
  const first = "Probe";
  const last = `${opts.tag}-${Date.now().toString(36)}`;
  const { data: player, error } = await db
    .from("players")
    .insert({ first_name: first, last_name: last })
    .select("id")
    .single();
  if (error) throw new Error(`scratchSkater: ${error.message}`);
  const { error: rosterErr } = await db.from("team_players").insert({
    season_id: opts.seasonId,
    team_id: opts.teamId,
    player_id: player!.id,
    position: "F",
  });
  if (rosterErr) throw new Error(`scratchSkater roster: ${rosterErr.message}`);
  return { playerId: player!.id as string, name: `${first} ${last}` };
}

test.describe("Path 22 — Roster editing", () => {
  /**
   * The regression 0036 exists to prevent, reached through the new door.
   *
   * `v_goalie_stats` INNER JOINs `team_players`, so a move that deletes the old
   * roster row erases the old team's entire goalie record — GP, W/L, GAA,
   * shutouts — while the games stay on the schedule, and reports no error. This
   * asserts the record is byte-for-byte the same after the move, which is the
   * only way to see it: nothing in the UI would look wrong either way.
   */
  test("moving a goalie who has dressed leaves the old team's record intact", async ({
    page,
  }) => {
    const db = admin();
    const { seasonId } = await activeSeason("obhl");

    // A goalie with games behind them AND an active roster row. Both halves
    // matter: the stats view is what must survive, and only an active row has a
    // Transfer control to click.
    const { data: rows } = await db
      .from("v_goalie_stats")
      .select("player_id, team_id, gp, wins, losses, ties, ga, so, gaa")
      .eq("season_id", seasonId)
      .gt("gp", 0);
    const { data: active } = await db
      .from("team_players")
      .select("player_id, team_id")
      .eq("season_id", seasonId)
      .eq("position", "G")
      .is("left_on", null);
    const activeKeys = new Set((active ?? []).map((r) => `${r.player_id}:${r.team_id}`));
    const before = (rows ?? []).find((r) =>
      activeKeys.has(`${r.player_id}:${r.team_id}`),
    );
    expect(before, "the seed should leave at least one rostered goalie with games").toBeTruthy();

    const fromTeam = await teamName(before!.team_id!);
    const who = await playerName(before!.player_id!);

    // Somewhere to move them that is enrolled this season and is not their team.
    // Ids here, names resolved separately. An embedded select would be tidier
    // and this client is untyped, so PostgREST's to-one embed comes back typed
    // as an array and read as one — a runtime `undefined` that typechecks.
    const { data: enrolled } = await db
      .from("season_teams")
      .select("team_id")
      .eq("season_id", seasonId)
      // Ordered so `teams[0]`/`teams[1]` are the same pair every run — an
      // unordered query makes a failure here reproduce only by luck.
      .order("team_id", { ascending: true });
    const toTeam = await teamName(
      (enrolled ?? []).find((e) => e.team_id !== before!.team_id)!.team_id,
    );

    await signInAs(page, "Manager");
    await openRoster(page, "obhl", fromTeam);
    const row = rowFor(page, who);
    await row.getByRole("button", { name: /^transfer$/i }).click();
    await row.getByLabel(/to team/i).selectOption({ label: toTeam });
    // Cleared: any number might be taken on the destination by the time this
    // runs, and the number is not what this test is about.
    await row.getByLabel(/jersey number/i).fill("");
    await row.getByRole("button", { name: /confirm transfer/i }).click();
    await expect(page.getByRole("cell", { name: who })).toHaveCount(0);

    const { data: after } = await db
      .from("v_goalie_stats")
      .select("gp, wins, losses, ties, ga, so, gaa")
      .eq("season_id", seasonId)
      .eq("player_id", before!.player_id!)
      .eq("team_id", before!.team_id!)
      .maybeSingle();

    // `toBeTruthy` first and on its own: a null row here is the exact failure —
    // the record did not change, it VANISHED — and asserting equality against
    // null would report a confusing field-by-field diff instead.
    expect(after, `${fromTeam}'s goalie record for ${who} must survive the move`).toBeTruthy();
    expect(after).toEqual({
      gp: before!.gp,
      wins: before!.wins,
      losses: before!.losses,
      ties: before!.ties,
      ga: before!.ga,
      so: before!.so,
      gaa: before!.gaa,
    });

    // And the move actually happened, so the assertion above is not passing
    // because nothing was written.
    const { data: nowOn } = await db
      .from("team_players")
      .select("team_id")
      .eq("season_id", seasonId)
      .eq("player_id", before!.player_id!)
      .is("left_on", null)
      .single();
    expect(await teamName(nowOn!.team_id)).toBe(toTeam);
  });

  /**
   * The add form is the second door onto the same move, and it must go through
   * the same code. Before this, adding somebody already rostered elsewhere hit
   * `team_players_one_active_team` and came back as a bare 23505.
   */
  test("adding someone already on another team moves them off it", async ({ page }) => {
    const db = admin();
    const { seasonId } = await activeSeason("obhl");

    const { data: enrolled } = await db
      .from("season_teams")
      .select("team_id")
      .eq("season_id", seasonId);
    const teams = await Promise.all(
      (enrolled ?? []).map(async (e) => ({ id: e.team_id, name: await teamName(e.team_id) })),
    );

    // Our own skater on our own chosen team — see `scratchSkater`. Picking
    // "the first active row" made this test order-dependent: 04 and 19 move
    // people, so the row it landed on changed once the whole suite ran.
    const from = teams[0];
    const to = teams[1];
    const { playerId, name: who } = await scratchSkater({
      seasonId,
      teamId: from.id,
      tag: "move",
    });

    await signInAs(page, "Manager");
    await openRoster(page, "obhl", to.name);
    await search(page, who);
    await page.getByRole("option", { name: who }).click();
    await page.getByRole("button", { name: /add player/i }).click();

    // Said out loud. "I meant to add them, why did they leave the other team"
    // is the question this message exists to answer before it is asked.
    await expect(page.getByText(/already on another team this season/i)).toBeVisible();
    await expect(page.getByRole("cell", { name: who })).toBeVisible();

    await openRoster(page, "obhl", from.name);
    await expect(page.getByRole("cell", { name: who })).toHaveCount(0);

    // Exactly one active row — the property the whole design turns on.
    const { data:stillActive } = await db
      .from("team_players")
      .select("team_id")
      .eq("season_id", seasonId)
      .eq("player_id", playerId)
      .is("left_on", null);
    expect(stillActive).toHaveLength(1);
    expect(stillActive![0].team_id).toBe(to.id);
  });

  /**
   * ⛔ THE TWO-LEAGUE CASE, and the reason `player_league_archive` is a table
   * rather than a `players.archived_at` column.
   *
   * `players` is global — one human is one row — so a global flag would remove
   * an archived person from every OTHER league's picker too, silently, for
   * leagues that never touched them. A single-league test cannot see that: it
   * passes identically whichever shape the archive has.
   */
  test("archiving in one league leaves the person in the other league's picker", async ({
    page,
  }) => {
    const db = admin();
    const obhl = await activeSeason("obhl");
    const harbor = await activeSeason("harbor");

    // Somebody who plays ONLY in Harbor. Archiving them out of Oceanview is
    // therefore a statement about a league they have never appeared in, which
    // is the sharpest version of the question.
    //
    // ⛔ CREATED, NOT FOUND. This used to search for a Harbor player absent from
    // Oceanview, and that search comes back empty once an earlier spec has put
    // the seeded Harbor people into Oceanview too — a non-null assertion on
    // `undefined`, and a test that passed alone and failed in the suite.
    const { data: harborTeams } = await db
      .from("season_teams")
      .select("team_id")
      .eq("season_id", harbor.seasonId);
    const harborHome = harborTeams![0].team_id as string;
    const { name: who } = await scratchSkater({
      seasonId: harbor.seasonId,
      teamId: harborHome,
      tag: "harbor-only",
    });

    // A Harbor team that is NOT theirs, so the picker there offers them.
    const otherHarborTeam = await teamName(
      (harborTeams ?? []).find((t) => t.team_id !== harborHome)!.team_id,
    );

    const { data: obhlTeams } = await db
      .from("season_teams")
      .select("team_id")
      .eq("season_id", obhl.seasonId)
      .limit(1);
    const someObhlTeam = await teamName(obhlTeams![0].team_id);

    await signInAs(page, "Manager");

    // --- archive, from the picker, in Oceanview -----------------------------
    await openRoster(page, "obhl", someObhlTeam);
    await search(page, who);
    await page.getByRole("option", { name: who }).click();
    await search(page, who);
    await page
      .getByRole("option", { name: who })
      .getByRole("button", { name: "Archive" })
      .click();
    await expect(page.getByText(/archived from this league/i)).toBeVisible();

    // Gone from this league's picker…
    await search(page, who);
    await expect(page.getByRole("option", { name: who })).toHaveCount(0);
    // …but findable, here, by the person who went looking for them. The toggle
    // lives on the picker for exactly this moment.
    await page.getByLabel("Show archived").check();
    await expect(page.getByRole("option", { name: who })).toBeVisible();

    // --- and untouched in Harbor -------------------------------------------
    await openRoster(page, "harbor", otherHarborTeam);
    await search(page, who);
    await expect(
      page.getByRole("option", { name: who }),
      "a league-scoped archive must not reach the other league",
    ).toBeVisible();

    // --- restore, so the suite leaves the seed as it found it ---------------
    await openRoster(page, "obhl", someObhlTeam);
    await search(page, who);
    await page.getByLabel("Show archived").check();
    await page
      .getByRole("option", { name: who })
      .getByRole("button", { name: "Restore" })
      .click();
    await expect(page.getByText(/available in this league again/i)).toBeVisible();
  });

  /**
   * The accepted cost of a global `players` row, stated as a test.
   *
   * A one-league manager cannot rename somebody who also plays a league they do
   * not work, because there is one name and it would land in both. The refusal
   * has to SAY that and name the route out, or it reads as a broken button.
   */
  test("a cross-league rename is refused, and the refusal names the League Office", async ({
    page,
  }) => {
    const db = admin();
    const harbor = await activeSeason("harbor");
    const obhl = await activeSeason("obhl");

    const { data: harborRows } = await db
      .from("team_players")
      .select("player_id, team_id")
      .eq("season_id", harbor.seasonId)
      .is("left_on", null);
    const { data: obhlRows } = await db
      .from("team_players")
      .select("player_id")
      .eq("season_id", obhl.seasonId);
    const inOceanview = new Set((obhlRows ?? []).map((r) => r.player_id));

    const shared = (harborRows ?? []).find((r) => inOceanview.has(r.player_id))!;
    const local = (harborRows ?? []).find(
      (r) => !inOceanview.has(r.player_id) && r.team_id === shared.team_id,
    )!;
    const sharedName = await playerName(shared.player_id);
    const localName = await playerName(local.player_id);
    const team = await teamName(shared.team_id);

    // Harbor only — 16-league-membership derives the same confinement rather
    // than naming it, and for the same reason.
    await signInAs(page, "One-league mgr");
    await openRoster(page, "harbor", team);

    const sharedRow = rowFor(page, sharedName);
    await sharedRow.getByRole("button", { name: "Edit" }).click();
    await sharedRow.getByLabel("First name").fill("Renamed");
    await sharedRow.getByRole("button", { name: /rename everywhere/i }).click();

    const refusal = sharedRow.getByRole("status");
    await expect(refusal).toContainText(/League Office/i);
    // Not a generic "no": it names the league that put them out of reach and
    // says why one row means one name.
    await expect(refusal).toContainText(/Oceanview/i);
    await expect(refusal).toContainText(/shared by every league/i);

    // Nothing was written.
    expect(await playerName(shared.player_id)).toBe(sharedName);

    // And the same manager CAN rename somebody who only plays their league —
    // so the refusal above is containment doing its job, not the button being
    // broken for everyone.
    const localRow = rowFor(page, localName);
    await localRow.getByRole("button", { name: "Edit" }).click();
    await localRow.getByLabel("First name").fill("Renamed");
    await localRow.getByRole("button", { name: /rename everywhere/i }).click();
    await expect(localRow.getByRole("status")).toContainText(/Renamed/);
    expect(await playerName(local.player_id)).toMatch(/^Renamed /);
  });

  /** A number lives on `team_players`; a scoresheet lives on `game_rosters`. */
  test("editing a jersey number does not disturb game history", async ({ page }) => {
    const db = admin();
    const { seasonId } = await activeSeason("obhl");

    // Somebody who has actually dressed, or there is no history to disturb.
    const { data: candidates } = await db
      .from("v_skater_stats")
      .select("player_id, team_id, gp")
      .eq("season_id", seasonId)
      .gt("gp", 0);
    const { data: active } = await db
      .from("team_players")
      .select("player_id, team_id, jersey_number")
      .eq("season_id", seasonId)
      .is("left_on", null);
    const activeByKey = new Map(
      (active ?? []).map((r) => [`${r.player_id}:${r.team_id}`, r]),
    );
    const pick = (candidates ?? []).find((c) =>
      activeByKey.has(`${c.player_id}:${c.team_id}`),
    )!;
    const who = await playerName(pick.player_id!);
    const team = await teamName(pick.team_id!);

    const dressedBefore = await db
      .from("game_rosters")
      .select("game_id", { count: "exact", head: true })
      .eq("player_id", pick.player_id!)
      .eq("team_id", pick.team_id!);

    // A number nobody on the team is wearing, derived rather than guessed.
    const taken = new Set(
      (active ?? [])
        .filter((r) => r.team_id === pick.team_id)
        .map((r) => r.jersey_number),
    );
    const free = [...Array(100).keys()].find((n) => !taken.has(n))!;

    await signInAs(page, "Manager");
    await openRoster(page, "obhl", team);
    const row = rowFor(page, who);
    await row.getByRole("button", { name: "Edit" }).click();
    await row.getByLabel("Number").fill(String(free));
    await row.getByRole("button", { name: "Save" }).click();
    await expect(row.getByRole("status")).toContainText(/Updated/);

    const dressedAfter = await db
      .from("game_rosters")
      .select("game_id", { count: "exact", head: true })
      .eq("player_id", pick.player_id!)
      .eq("team_id", pick.team_id!);
    expect(dressedAfter.count).toBe(dressedBefore.count);

    const { data: statsAfter } = await db
      .from("v_skater_stats")
      .select("gp")
      .eq("season_id", seasonId)
      .eq("player_id", pick.player_id!)
      .eq("team_id", pick.team_id!)
      .maybeSingle();
    expect(statsAfter?.gp).toBe(pick.gp);
  });

  /** A number already worn is refused by name, not by a raw constraint error. */
  test("a clashing jersey number is refused with the wearer named", async ({ page }) => {
    const db = admin();
    const { seasonId } = await activeSeason("obhl");
    const { data: active } = await db
      .from("team_players")
      .select("player_id, team_id, jersey_number")
      .eq("season_id", seasonId)
      .is("left_on", null)
      .not("jersey_number", "is", null);

    // Two players on one team, one wearing a number the other will ask for.
    const byTeam = new Map<string, typeof active>();
    for (const r of active ?? []) {
      byTeam.set(r.team_id, [...(byTeam.get(r.team_id) ?? []), r]);
    }
    const [teamId, members] = [...byTeam.entries()].find(([, m]) => m!.length >= 2)!;
    const [subject, wearer] = members!;

    await signInAs(page, "Manager");
    await openRoster(page, "obhl", await teamName(teamId));
    const row = rowFor(page, await playerName(subject.player_id));
    await row.getByRole("button", { name: "Edit" }).click();
    await row.getByLabel("Number").fill(String(wearer.jersey_number));
    await row.getByRole("button", { name: "Save" }).click();

    await expect(row.getByRole("status")).toContainText(
      new RegExp(`already worn by ${await playerName(wearer.player_id)}`, "i"),
    );
  });
});
