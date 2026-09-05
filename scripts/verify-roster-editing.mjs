// Runtime proof for 0040 and the shared move path, against a live local database.
//
// Two things that both fail SILENTLY if they are wrong:
//   1. the archive is league-scoped — archiving someone out of one league must
//      leave every other league's picker untouched;
//   2. a move keeps the old roster row, so the old team's goalie record survives
//      it (0036, and the reason `movePlayerToTeam` is the only implementation).
//
// ⛔ EACH ASSERTION IS PAIRED WITH ITS KNOCKOUT. Run with `KNOCKOUT=archive` or
// `KNOCKOUT=move` and the script does the WRONG thing on purpose — a global
// archive read (the shape a `players.archived_at` column forces), or the naive
// delete-then-insert — so the assertion that should catch it can be watched
// going red. A green assertion nobody has seen fail is not evidence.
//
// ⚠️ WHAT THIS DOES AND DOES NOT EXERCISE. `archivePlayer` and `movePlayerToTeam`
// are server actions in TypeScript, behind Next's runtime, so a plain node
// script cannot call them. What is exercised here is the DATABASE half — the
// real tables, the real `v_goalie_stats`, the real 0036 indexes — with the two
// candidate write orders and the two candidate archive reads applied over real
// data. The application half is covered by e2e/22-roster-editing.spec.ts, which
// drives the actual actions through the UI.
//
// Modelled on verify-transfers.mjs, including its refusal to run anywhere but a
// local database, and its non-zero exit on a failed assertion.
import { createClient } from "@supabase/supabase-js";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL || "http://127.0.0.1:54321";
const secret = process.env.SUPABASE_SECRET_KEY;
const KNOCKOUT = process.env.KNOCKOUT ?? "";

// This script finalizes a game and writes roster rows. `.env.local` can point
// NEXT_PUBLIC_SUPABASE_URL at a real deployment, so refuse outright rather than
// trusting the caller to have the right env loaded.
const isLocal = /^https?:\/\/(127\.0\.0\.1|localhost)(:|\/|$)/.test(url);
if (!isLocal) {
  console.error(`Refusing to run against ${url} — this script writes. Local only.`);
  process.exit(1);
}
if (!secret) {
  console.error("Missing SUPABASE_SECRET_KEY (it's in .env.local).");
  process.exit(1);
}

const admin = createClient(url, secret, { auth: { persistSession: false } });

let failures = 0;
const ok = (cond, label) => {
  if (!cond) failures++;
  console.log(`${cond ? "✓" : "✗ FAIL"} ${label}`);
  return cond;
};

if (KNOCKOUT) console.log(`\n⚠️  KNOCKOUT=${KNOCKOUT} — doing the wrong thing on purpose.\n`);

const activeSeason = async (slug) => {
  const { data: league } = await admin
    .from("leagues")
    .select("id, name")
    .eq("slug", slug)
    .single();
  const { data: season } = await admin
    .from("seasons")
    .select("id")
    .eq("league_id", league.id)
    .eq("is_active", true)
    .single();
  return { leagueId: league.id, leagueName: league.name, seasonId: season.id };
};

const nameOf = async (playerId) => {
  const { data } = await admin
    .from("players")
    .select("first_name, last_name")
    .eq("id", playerId)
    .single();
  return `${data.first_name} ${data.last_name}`;
};

// ── The two readings of "who is archived" ──────────────────────────────────
//
// The correct one takes a league. The knockout ignores it, which is exactly
// what a global `players.archived_at` column would have made unavoidable — and
// the whole point is that the two agree on the league that did the archiving
// and disagree everywhere else, which is where the damage is.
async function archivedIds(leagueId) {
  const q = admin.from("player_league_archive").select("player_id");
  const { data } =
    KNOCKOUT === "archive" ? await q : await q.eq("league_id", leagueId);
  return new Set((data ?? []).map((r) => r.player_id));
}

/**
 * The add-player picker's list for one team, as the page builds it: every person
 * in `players`, minus this team's active roster, minus this league's archive.
 */
async function pickerFor(leagueId, seasonId, teamId) {
  const [{ data: all }, archived, { data: roster }] = await Promise.all([
    admin.from("players").select("id"),
    archivedIds(leagueId),
    admin
      .from("team_players")
      .select("player_id")
      .eq("season_id", seasonId)
      .eq("team_id", teamId)
      .is("left_on", null),
  ]);
  const onRoster = new Set((roster ?? []).map((r) => r.player_id));
  return new Set(
    (all ?? []).map((p) => p.id).filter((id) => !onRoster.has(id) && !archived.has(id)),
  );
}

const obhl = await activeSeason("obhl");
const harbor = await activeSeason("harbor");

let archivedPlayerId = null;
const scratch = { playerId: null, rowA: null, rowB: null, gameId: null, gameBefore: null };

try {
  // ═══ 1. the archive is LEAGUE-SCOPED ═════════════════════════════════════
  console.log("── 1. archive scope ──");

  // Somebody who plays only in Harbor. Archiving them out of Oceanview is then
  // a statement about a league they have never appeared in — the sharpest form
  // of the question, and the one a global flag gets wrong.
  const { data: harborRows } = await admin
    .from("team_players")
    .select("player_id, team_id")
    .eq("season_id", harbor.seasonId)
    .is("left_on", null);
  const { data: obhlRows } = await admin
    .from("team_players")
    .select("player_id")
    .eq("season_id", obhl.seasonId);
  const inOcean = new Set((obhlRows ?? []).map((r) => r.player_id));
  const subject = harborRows.find((r) => !inOcean.has(r.player_id));
  if (!subject) {
    console.error("No Harbor-only player in the seed — cannot verify league scope.");
    process.exit(1);
  }
  const who = await nameOf(subject.player_id);

  const { data: obhlTeam } = await admin
    .from("season_teams")
    .select("team_id")
    .eq("season_id", obhl.seasonId)
    .limit(1)
    .single();
  const { data: harborTeams } = await admin
    .from("season_teams")
    .select("team_id")
    .eq("season_id", harbor.seasonId);
  // A Harbor team that is NOT theirs, so their own roster row does not remove
  // them from the list for an unrelated reason.
  const harborTeam = harborTeams.find((t) => t.team_id !== subject.team_id).team_id;

  ok(
    (await pickerFor(obhl.leagueId, obhl.seasonId, obhlTeam.team_id)).has(subject.player_id),
    `${who} starts out in ${obhl.leagueName}'s picker`,
  );
  ok(
    (await pickerFor(harbor.leagueId, harbor.seasonId, harborTeam)).has(subject.player_id),
    `${who} starts out in ${harbor.leagueName}'s picker`,
  );

  await admin
    .from("player_league_archive")
    .upsert(
      { player_id: subject.player_id, league_id: obhl.leagueId },
      { onConflict: "player_id,league_id" },
    );
  archivedPlayerId = subject.player_id;
  console.log(`   … archived ${who} out of ${obhl.leagueName} only`);

  ok(
    !(await pickerFor(obhl.leagueId, obhl.seasonId, obhlTeam.team_id)).has(subject.player_id),
    `${who} is gone from ${obhl.leagueName}'s picker`,
  );
  // ⛔ THE ONE THAT MATTERS. A global archive passes the line above and fails
  // this one — which is why KNOCKOUT=archive exists.
  ok(
    (await pickerFor(harbor.leagueId, harbor.seasonId, harborTeam)).has(subject.player_id),
    `${who} is STILL in ${harbor.leagueName}'s picker (the archive is league-scoped)`,
  );

  // ═══ 2. a move keeps the old team's goalie record ════════════════════════
  console.log("\n── 2. the move path ──");

  // A scratch goalie of our own, on a team with a game left to play. Borrowing a
  // seeded goalie would make the assertion depend on whatever the e2e suite did
  // to them last, which is the trap verify-transfers.mjs records hitting.
  const { data: game } = await admin
    .from("games")
    .select("id, home_team_id, away_team_id, status, home_goals, away_goals, result_type, home_goalie_id, home_empty_net_against, finalized_at, finalized_by")
    .eq("season_id", obhl.seasonId)
    .eq("status", "scheduled")
    .eq("game_type", "regular")
    .eq("is_draft", false)
    .limit(1)
    .single();
  if (!game) {
    console.error("No scheduled Oceanview game left to finalize — cannot verify the move.");
    process.exit(1);
  }
  scratch.gameId = game.id;
  scratch.gameBefore = game;
  const teamA = game.home_team_id;
  const { data: otherTeam } = await admin
    .from("season_teams")
    .select("team_id")
    .eq("season_id", obhl.seasonId)
    .neq("team_id", teamA)
    .neq("team_id", game.away_team_id)
    .limit(1)
    .single();
  const teamB = otherTeam.team_id;

  const { data: p } = await admin
    .from("players")
    .insert({ first_name: "Verify", last_name: "Mover" })
    .select("id")
    .single();
  scratch.playerId = p.id;
  const { data: rowA } = await admin
    .from("team_players")
    .insert({
      season_id: obhl.seasonId,
      team_id: teamA,
      player_id: p.id,
      position: "G",
      jersey_number: null,
    })
    .select("id")
    .single();
  scratch.rowA = rowA.id;

  await admin.from("game_rosters").insert({
    game_id: game.id,
    team_id: teamA,
    player_id: p.id,
  });
  // ⛔ NO `home_goalie_id`, AND THAT IS THE WHOLE FIXTURE. `v_goalie_stats` has
  // two branches (0037): an EXPLICIT pick, which reads `games.home_goalie_id`
  // and joins no roster row at all, and a DRESSED position='G' FALLBACK, which
  // inner-joins `team_players`. Only the fallback can be destroyed by deleting
  // that row — a picked goalie keeps their games regardless, which is one of the
  // things restoring 0015 bought.
  //
  // A first version of this script set the explicit pick and watched the
  // KNOCKOUT pass: the assertion was real, the fixture was immune to it. Leaving
  // the pick null is what puts the join under test.
  await admin
    .from("games")
    .update({
      status: "final",
      home_goals: 3,
      away_goals: 1,
      result_type: "regulation",
      finalized_at: new Date().toISOString(),
    })
    .eq("id", game.id);

  const goalieRow = async () => {
    const { data } = await admin
      .from("v_goalie_stats")
      .select("gp, wins, losses, ties, ga, so, gaa")
      .eq("season_id", obhl.seasonId)
      .eq("player_id", p.id)
      .eq("team_id", teamA)
      .maybeSingle();
    return data;
  };

  const before = await goalieRow();
  ok(
    before?.gp === 1 && before?.wins === 1,
    `the scratch goalie has a record with the old team via the roster-row join ` +
      `(gp=${before?.gp}, W=${before?.wins})`,
  );

  if (KNOCKOUT === "move") {
    // ⛔ THE NAIVE MOVE — delete the old row, insert a new one. This is what the
    // shared helper exists to stop anyone writing a second time, and neither
    // statement below reports an error.
    console.log("   … moving by DELETE + INSERT (the version 0036 exists to prevent)");
    await admin.from("team_players").delete().eq("id", scratch.rowA);
    scratch.rowA = null;
  } else {
    // The shipped order: depart the old row FIRST — `team_players_one_active_team`
    // rejects the insert while it is still active — and keep it, because that row
    // IS the record `v_goalie_stats` inner-joins.
    console.log("   … moving by DEPART + JOIN (movePlayerToTeam's order)");
    await admin
      .from("team_players")
      .update({
        left_on: new Date().toISOString().slice(0, 10),
        is_captain: false,
        is_default_goalie: false,
      })
      .eq("id", scratch.rowA);
  }
  const { data: rowB, error: joinErr } = await admin
    .from("team_players")
    .insert({
      season_id: obhl.seasonId,
      team_id: teamB,
      player_id: p.id,
      position: "G",
      jersey_number: null,
    })
    .select("id")
    .single();
  if (joinErr) throw new Error("join failed: " + joinErr.message);
  scratch.rowB = rowB.id;

  const after = await goalieRow();
  ok(
    after !== null,
    `the old team's goalie record still EXISTS after the move (row ${after ? "present" : "GONE"})`,
  );
  ok(
    after !== null &&
      after.gp === before.gp &&
      after.wins === before.wins &&
      after.losses === before.losses &&
      after.so === before.so &&
      String(after.gaa) === String(before.gaa),
    `and is unchanged (gp ${before.gp}, W ${before.wins}, L ${before.losses}, ` +
      `SO ${before.so}, GAA ${before.gaa})`,
  );

  // The games themselves never moved, which is what makes a vanished record a
  // silent corruption rather than a visible one.
  const { count: stillDressed } = await admin
    .from("game_rosters")
    .select("game_id", { count: "exact", head: true })
    .eq("player_id", p.id)
    .eq("team_id", teamA);
  ok(stillDressed === 1, `the game they played for the old team is still on the schedule`);
} finally {
  // ── revert ───────────────────────────────────────────────────────────────
  if (archivedPlayerId) {
    await admin
      .from("player_league_archive")
      .delete()
      .eq("player_id", archivedPlayerId)
      .eq("league_id", obhl.leagueId);
  }
  if (scratch.gameId && scratch.gameBefore) {
    await admin.from("game_rosters").delete().eq("game_id", scratch.gameId);
    const g = scratch.gameBefore;
    await admin
      .from("games")
      .update({
        status: g.status,
        home_goals: g.home_goals,
        away_goals: g.away_goals,
        result_type: g.result_type,
        home_goalie_id: g.home_goalie_id,
        home_empty_net_against: g.home_empty_net_against,
        finalized_at: g.finalized_at,
        finalized_by: g.finalized_by,
      })
      .eq("id", scratch.gameId);
  }
  for (const id of [scratch.rowA, scratch.rowB]) {
    if (id) await admin.from("team_players").delete().eq("id", id);
  }
  // After their roster rows: `game_rosters.player_id` cascades, so a player
  // deleted first would take their game rows with them.
  if (scratch.playerId) await admin.from("players").delete().eq("id", scratch.playerId);
}

console.log(
  failures === 0
    ? "\nverify-roster-editing done (everything reverted)"
    : `\nverify-roster-editing FAILED: ${failures} assertion(s) (everything reverted)`,
);
process.exit(failures === 0 ? 0 : 1);
