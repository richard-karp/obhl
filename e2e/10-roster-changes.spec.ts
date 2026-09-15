import { test, expect } from "@playwright/test";
import type { Locator, Page } from "@playwright/test";
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

async function activeSeason(slug: string) {
  const db = admin();
  const { data: league } = await db
    .from("leagues")
    .select("id")
    .eq("slug", slug)
    .single();
  const { data: season } = await db
    .from("seasons")
    .select("id")
    .eq("league_id", league!.id)
    .eq("is_active", true)
    .single();
  return { leagueId: league!.id as string, seasonId: season!.id as string };
}

async function teamName(teamId: string) {
  const { data } = await admin()
    .from("teams")
    .select("name")
    .eq("id", teamId)
    .single();
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

// ⚠️ `/teams`, not `/manage/rosters`: the editor is a section of the team page, and following the
// 308 would test the redirect as much as the page.
async function openRoster(page: Page, slug: string, team: string) {
  await page.goto(`/${slug}/teams`);
  await page.getByText(team, { exact: true }).first().click();
  await expect(page).toHaveURL(/\/teams\//);
  await expect(manageRoster(page)).toBeVisible();
}

/** The editor's region — the public roster table sits above it on the same page. */
function manageRoster(page: Page) {
  return page.getByRole("region", { name: "Manage roster" });
}

// ⛔ The dialog is a portal, not inside the `<tr>`: `row.getByLabel(...)` finds nothing, so scope to
// the dialog.
async function openDialogFor(page: Page, row: Locator) {
  await row.getByRole("button", { name: "Edit" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  return dialog;
}

function rowFor(page: Page, name: string) {
  return manageRoster(page).locator("table tbody tr").filter({ hasText: name });
}

/** Type into the combobox and wait for the list to narrow. */
async function search(page: Page, name: string) {
  const field = page.getByLabel("Existing person (optional)");
  await field.click();
  await field.fill(name);
}

// ⛔ A person owned by the test that asked for them: a hard-coded name, or a `.limit(1)` pick, changes
// once other specs move people, and passes alone but fails in the suite.
async function scratchSkater(opts: {
  seasonId: string;
  teamId: string;
  tag: string;
  position?: "F" | "D" | "G";
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
    position: opts.position ?? "F",
  });
  if (rosterErr) throw new Error(`scratchSkater roster: ${rosterErr.message}`);
  return { playerId: player!.id as string, name: `${first} ${last}` };
}

// ⛔ Not the first row: that is Sharks' seeded captain, whose account `05-scoring-night` signs in as,
// and a transfer clears `is_captain`. Defence carries no captain in the seed.
function subjectRow(page: Page) {
  return manageRoster(page)
    .getByRole("region", { name: "Manage Defence" })
    .locator("tbody tr")
    .first();
}

// ⛔ Badges stripped, not `.split("\n")[0]`: captain, rookie, suspended and injury badges sit inline in
// the name cell with no newline, so a split returns "Taylor GauthierC".
async function subjectName(page: Page) {
  const cell = subjectRow(page).locator("td").nth(1);
  const badges = await cell.locator('[data-slot="badge"]').allInnerTexts();
  let name = (await cell.innerText()).trim();
  for (const b of badges) name = name.replace(b, "").trim();
  return name;
}

// A scheduled regular game with nobody dressed, read with every column a test writes, so
// `restoreGame` can put it back exactly.
async function emptyScoresheetGame(seasonId: string) {
  const db = admin();
  const { data: games } = await db
    .from("games")
    .select(
      "id, home_team_id, away_team_id, status, home_goals, away_goals, result_type, home_goalie_id, away_goalie_id, home_empty_net_against, finalized_at, finalized_by",
    )
    .eq("season_id", seasonId)
    .eq("status", "scheduled")
    .eq("game_type", "regular")
    .eq("is_draft", false)
    .order("scheduled_at", { ascending: false });
  for (const g of games ?? []) {
    const { count } = await db
      .from("game_rosters")
      .select("id", { count: "exact", head: true })
      .eq("game_id", g.id);
    if (!count) return g;
  }
  throw new Error("no scheduled game in this season has an empty scoresheet");
}

async function restoreGame(g: Awaited<ReturnType<typeof emptyScoresheetGame>>) {
  const db = admin();
  await db.from("game_rosters").delete().eq("game_id", g.id);
  await db
    .from("games")
    .update({
      status: g.status,
      home_goals: g.home_goals,
      away_goals: g.away_goals,
      result_type: g.result_type,
      home_goalie_id: g.home_goalie_id,
      away_goalie_id: g.away_goalie_id,
      home_empty_net_against: g.home_empty_net_against,
      finalized_at: g.finalized_at,
      finalized_by: g.finalized_by,
    })
    .eq("id", g.id);
}

test.describe("Transfers", () => {
  test("a transferred player leaves one roster and joins the other", async ({
    page,
  }) => {
    await signInAs(page, "Manager");
    await openRoster(page, "obhl", "Sharks");
    const name = await subjectName(page);
    const row = subjectRow(page);

    const dialog = await openDialogFor(page, row);
    await dialog.getByLabel(/to team/i).selectOption({ label: "Bears" });
    // Cleared, which means "no number on the new team" — the one deterministic
    // choice here, since any number might be taken by the time this runs.
    await dialog.getByLabel(/jersey number/i).fill("");
    await dialog.getByRole("button", { name: /confirm transfer/i }).click();
    await page.waitForLoadState("networkidle");
    await expect(dialog.getByRole("status")).toHaveCount(0);
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();

    // ⚠️ Scoped to the editor: the public table lists anyone with stats for the team (0036's soft
    // departures), so the transferred player is legitimately still named there.
    await expect(manageRoster(page).getByRole("cell", { name })).toHaveCount(0);

    await openRoster(page, "obhl", "Bears");
    await expect(manageRoster(page).getByRole("cell", { name })).toBeVisible();
  });
});

// ⚠️ Every fixture is derived at run time: other specs add, remove and transfer players. Two tests
// need both seeded leagues, since their questions are unanswerable inside one.
test.describe("Path 22 — Roster editing", () => {
  // ⛔ A goalie with NO pick, the fixture's point: `v_goalie_stats`' explicit-pick branch joins no
  // roster row, so only the dressed-goalie fallback inner-joins `team_players`.
  test("moving a goalie who has dressed leaves the old team's record intact", async ({
    page,
  }) => {
    const db = admin();
    const { seasonId } = await activeSeason("obhl");
    const game = await emptyScoresheetGame(seasonId);
    const fromId = game.home_team_id as string;
    const { data: enrolled } = await db
      .from("season_teams")
      .select("team_id")
      .eq("season_id", seasonId)
      .order("team_id", { ascending: true });
    const toId = (enrolled ?? [])
      .map((e) => e.team_id as string)
      .find((t) => t !== fromId && t !== game.away_team_id)!;
    const fromTeam = await teamName(fromId);
    const toTeam = await teamName(toId);
    const { playerId, name: who } = await scratchSkater({
      seasonId,
      teamId: fromId,
      tag: "goalie",
      position: "G",
    });

    const record = async () => {
      const { data } = await db
        .from("v_goalie_stats")
        .select("gp, wins, losses, ties, ga, so, gaa")
        .eq("season_id", seasonId)
        .eq("player_id", playerId)
        .eq("team_id", fromId)
        .maybeSingle();
      return data;
    };

    try {
      await db
        .from("game_rosters")
        .insert({ game_id: game.id, team_id: fromId, player_id: playerId });
      // No `home_goalie_id`: the record has to come through the fallback.
      await db
        .from("games")
        .update({
          status: "final",
          home_goals: 2,
          away_goals: 1,
          result_type: "regulation",
          finalized_at: new Date().toISOString(),
        })
        .eq("id", game.id);
      const before = await record();
      expect(before, "the fallback should credit the only dressed goalie").toMatchObject({
        gp: 1,
        wins: 1,
      });

      await signInAs(page, "Manager");
      await openRoster(page, "obhl", fromTeam);
      const dialog = await openDialogFor(page, rowFor(page, who));
      await dialog.getByLabel(/to team/i).selectOption({ label: toTeam });
      await dialog.getByLabel(/jersey number/i).fill("");
      await dialog.getByRole("button", { name: /confirm transfer/i }).click();
      await page.waitForLoadState("networkidle");
      // ⛔ Shut the dialog before reading anything behind it: Radix marks the
      // rest of the document `aria-hidden` while a modal is open.
      await expect(dialog.getByRole("status")).toHaveCount(0);
      await page.keyboard.press("Escape");
      await expect(dialog).toBeHidden();
      await expect(
        manageRoster(page).getByRole("cell", { name: who }),
      ).toHaveCount(0);

      expect(
        await record(),
        `${fromTeam}'s goalie record for ${who} must survive the move`,
      ).toEqual(before);

      // The season totals roll the teams into one row, under the goalie's current team.
      const { data: totals } = await db
        .from("v_goalie_season_totals")
        .select("gp, gaa, team_id")
        .eq("season_id", seasonId)
        .eq("player_id", playerId)
        .maybeSingle();
      expect(totals?.gp).toBe(before!.gp);
      expect(totals?.team_id, "the totals row names the current team").toBe(toId);
      expect(Number(totals?.gaa)).toBe(
        Math.round((before!.ga / before!.gp) * 100) / 100,
      );
    } finally {
      await restoreGame(game);
      await db.from("team_players").delete().eq("player_id", playerId);
      await db.from("players").delete().eq("id", playerId);
    }
  });

  test("the goalie of record is credited, and empty-net goals are not charged to him", async () => {
    // Two goalies dressed, so the pick decides. Both created here, because other specs move the
    // seed's one goalie per team.
    const db = admin();
    const { seasonId } = await activeSeason("obhl");
    const game = await emptyScoresheetGame(seasonId);
    const teamId = game.home_team_id as string;
    const picked = await scratchSkater({ seasonId, teamId, tag: "picked", position: "G" });
    const other = await scratchSkater({ seasonId, teamId, tag: "benched", position: "G" });
    const AWAY_GOALS = 5;
    const EMPTY_NET = 2;
    const record = async (playerId: string) => {
      const { data } = await db
        .from("v_goalie_stats")
        .select("gp, ga, gaa")
        .eq("season_id", seasonId)
        .eq("player_id", playerId)
        .eq("team_id", teamId)
        .maybeSingle();
      return data;
    };

    try {
      await db.from("game_rosters").insert(
        [picked, other].map((g) => ({
          game_id: game.id,
          team_id: teamId,
          player_id: g.playerId,
        })),
      );
      await db
        .from("games")
        .update({
          status: "final",
          home_goals: 1,
          away_goals: AWAY_GOALS,
          result_type: "regulation",
          home_goalie_id: picked.playerId,
          home_empty_net_against: EMPTY_NET,
          finalized_at: new Date().toISOString(),
        })
        .eq("id", game.id);

      const credited = await record(picked.playerId);
      expect(credited, "the picked goalie is credited").toMatchObject({
        gp: 1,
        ga: AWAY_GOALS - EMPTY_NET,
      });
      expect(Number(credited!.gaa), "GAA comes from the adjusted GA").toBe(
        AWAY_GOALS - EMPTY_NET,
      );
      expect(
        (await record(other.playerId))?.gp ?? 0,
        "the other dressed goalie is not credited",
      ).toBe(0);
    } finally {
      await restoreGame(game);
      for (const g of [picked, other]) {
        await db.from("team_players").delete().eq("player_id", g.playerId);
        await db.from("players").delete().eq("id", g.playerId);
      }
    }
  });

  // The add form must go through the same move: otherwise adding someone rostered elsewhere hits
  // `team_players_one_active_team` as a bare 23505.
  test("adding someone already on another team moves them off it", async ({
    page,
  }) => {
    const db = admin();
    const { seasonId } = await activeSeason("obhl");

    const { data: enrolled } = await db
      .from("season_teams")
      .select("team_id")
      .eq("season_id", seasonId);
    const teams = await Promise.all(
      (enrolled ?? []).map(async (e) => ({
        id: e.team_id,
        name: await teamName(e.team_id),
      })),
    );

    // Our own skater on our own team (`scratchSkater`): other specs move people, so "the first
    // active row" changes under a full run.
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
    await expect(
      page.getByText(/already on another team this season/i),
    ).toBeVisible();
    // ⚠️ Scoped to the editor: the public table above also lists anyone with stats for the team, so an
    // unscoped `cell` is a strict-mode error on arrival and a false negative after a removal.
    await expect(
      manageRoster(page).getByRole("cell", { name: who }),
    ).toBeVisible();

    await openRoster(page, "obhl", from.name);
    await expect(
      manageRoster(page).getByRole("cell", { name: who }),
    ).toHaveCount(0);

    // Exactly one active row — the property the whole design turns on.
    const { data: stillActive } = await db
      .from("team_players")
      .select("team_id")
      .eq("season_id", seasonId)
      .eq("player_id", playerId)
      .is("left_on", null);
    expect(stillActive).toHaveLength(1);
    expect(stillActive![0].team_id).toBe(to.id);
  });

  // ⛔ THE TWO-LEAGUE CASE: `players` is global, so a global archive flag would remove the person from
  // every other league's picker too. A single-league test passes whichever shape the archive has.
  test("archiving in one league leaves the person in the other league's picker", async ({
    page,
  }) => {
    const db = admin();
    const obhl = await activeSeason("obhl");
    const harbor = await activeSeason("harbor");

    // Somebody who plays ONLY in Harbor. ⛔ Created, not found: other specs put the seeded Harbor
    // people into Oceanview too, and the search then comes back empty.
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
    await expect(
      page.getByText(/available in this league again/i),
    ).toBeVisible();
  });

  // One global name: a one-league manager cannot rename someone who also plays elsewhere, and the
  // refusal must say so and name the route out, or it reads as a broken button.
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

    const shared = (harborRows ?? []).find((r) =>
      inOceanview.has(r.player_id),
    )!;
    const local = (harborRows ?? []).find(
      (r) => !inOceanview.has(r.player_id) && r.team_id === shared.team_id,
    )!;
    const sharedName = await playerName(shared.player_id);
    const localName = await playerName(local.player_id);
    const team = await teamName(shared.team_id);

    // Harbor only — 09-access derives the same confinement rather
    // than naming it, and for the same reason.
    await signInAs(page, "One-league mgr");
    await openRoster(page, "harbor", team);

    const sharedRow = rowFor(page, sharedName);
    const sharedDialog = await openDialogFor(page, sharedRow);
    await sharedDialog.getByLabel("First name").fill("Renamed");
    await sharedDialog
      .getByRole("button", { name: /rename everywhere/i })
      .click();

    const refusal = sharedDialog.getByRole("status");
    await expect(refusal).toContainText(/League Office/i);
    // Not a generic "no": it names the league that put them out of reach and
    // says why one row means one name.
    await expect(refusal).toContainText(/Oceanview/i);
    await expect(refusal).toContainText(/shared by every league/i);

    // Nothing was written.
    expect(await playerName(shared.player_id)).toBe(sharedName);

    // ⛔ SHUT THE FIRST DIALOG FIRST: Radix marks the document behind a modal `aria-hidden`, so the
    // next `Edit` click times out.
    await page.keyboard.press("Escape");
    await expect(sharedDialog).toBeHidden();

    // The POSITIVE control: the same manager CAN rename someone who plays only their league, so the
    // refusal above is containment, not a broken button.
    const localRow = rowFor(page, localName);
    const localDialog = await openDialogFor(page, localRow);
    await localDialog.getByLabel("First name").fill("Renamed");
    await localDialog
      .getByRole("button", { name: /rename everywhere/i })
      .click();
    await expect(localDialog.getByRole("status")).toContainText(/Renamed/);
    expect(await playerName(local.player_id)).toMatch(/^Renamed /);
  });

  /** A number lives on `team_players`; a scoresheet lives on `game_rosters`. */
  test("editing a jersey number does not disturb game history", async ({
    page,
  }) => {
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
    const dialog = await openDialogFor(page, row);
    await dialog.getByLabel("Number", { exact: true }).fill(String(free));
    await dialog.getByRole("button", { name: "Save" }).click();
    await expect(dialog.getByRole("status")).toContainText(/Updated/);

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
});
