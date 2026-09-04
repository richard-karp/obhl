// Runtime proof for 0037 and 0036, against a live local database.
//
// Four things that all fail silently if they are wrong:
//   1. the goalie of record and the empty-net subtraction 0024 reverted,
//   2. a transfer leaving the old team's goalie record untouched,
//   3. RLS reaching through one security_invoker view nested inside another,
//   4. anon/authenticated actually holding SELECT on the new views.
//
// Modelled on verify-scoring.mjs, with one difference that matters: this exits
// non-zero when an assertion fails. Assertion 1 is a hard stop — if the goalie
// of record is not being honoured, nothing downstream of it means anything.
import { createClient } from "@supabase/supabase-js";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL || "http://127.0.0.1:54321";
const anon = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
const secret = process.env.SUPABASE_SECRET_KEY;

// This script flips a league private and finalizes games. `.env.local` can
// point NEXT_PUBLIC_SUPABASE_URL at a real deployment, so refuse outright
// rather than trusting the caller to have the right env loaded.
const isLocal = /^https?:\/\/(127\.0\.0\.1|localhost)(:|\/|$)/.test(url);
if (!isLocal) {
  console.error(`Refusing to run against ${url} — this script writes. Local only.`);
  process.exit(1);
}
if (!anon || !secret) {
  console.error("Missing Supabase keys (they're in .env.local). Run `npm run verify:transfers`.");
  process.exit(1);
}

const admin = createClient(url, secret, { auth: { persistSession: false } });
const asAnon = createClient(url, anon, { auth: { persistSession: false } });

let failures = 0;
const ok = (cond, label) => {
  if (!cond) failures++;
  console.log(`${cond ? "✓" : "✗ FAIL"} ${label}`);
  return cond;
};

// --- fixtures -------------------------------------------------------------
// Two scheduled games for one home team: the first exercises the explicit
// goalie pick, the second the dressed-goalie fallback. Both are reverted at the
// end.
const { data: season } = await admin
  .from("seasons")
  .select("id, league_id")
  .eq("is_active", true)
  .limit(1)
  .single();

const { data: candidates } = await admin
  .from("games")
  .select("id, home_team_id, away_team_id")
  .eq("season_id", season.id)
  .eq("status", "scheduled")
  .eq("game_type", "regular")
  .eq("is_draft", false)
  .order("scheduled_at", { ascending: true })
  .limit(40);

const byHome = new Map();
for (const g of candidates ?? []) {
  byHome.set(g.home_team_id, [...(byHome.get(g.home_team_id) ?? []), g]);
}

const rosterOf = async (teamId) => {
  const { data } = await admin
    .from("team_players")
    .select("id, player_id, position, jersey_number")
    .eq("season_id", season.id)
    .eq("team_id", teamId)
    .is("left_on", null)
    .order("jersey_number");
  return data ?? [];
};

// A home team with two scheduled games: the first exercises the explicit pick,
// the second the fallback.
let teamA = null;
let games = null;
for (const [teamId, gs] of byHome) {
  if (gs.length < 2) continue;
  teamA = teamId;
  games = gs.slice(0, 2);
  break;
}
if (!teamA) {
  console.error("No seeded team has two scheduled games — cannot verify.");
  process.exit(1);
}

// TWO scratch goalies, created here rather than taken from the seed.
//
// Two are needed at all because assertion 1 would otherwise pass against the
// reverted view: with one candidate, "the explicit pick" and "the lowest
// player_id" are the same row. And both are created rather than one, because
// the seed's own goalie is not dependable — it rosters exactly one per team and
// the e2e suite transfers it away, which left this script picking a team with
// no active goalie at all when the two ran back to back.
const scratchPlayerIds = [];
const scratchRosterIds = [];
for (const suffix of ["Alpha", "Bravo"]) {
  const { data: p, error } = await admin
    .from("players")
    .insert({ first_name: "Verify", last_name: `Goalie ${suffix}` })
    .select("id")
    .single();
  if (error) throw new Error("scratch goalie: " + error.message);
  scratchPlayerIds.push(p.id);
  const { data: row, error: rErr } = await admin
    .from("team_players")
    .insert({
      season_id: season.id,
      team_id: teamA,
      player_id: p.id,
      position: "G",
      jersey_number: null,
    })
    .select("id")
    .single();
  if (rErr) throw new Error("scratch roster row: " + rErr.message);
  scratchRosterIds.push(row.id);
}

// Sorted by player_id, because that is the order the REVERTED view used to pick
// a goalie. Taking the second one as the goalie of record means crediting the
// lowest id — the old behaviour — is a visible failure rather than a coincidence.
const goalies = (await rosterOf(teamA))
  .filter((p) => scratchPlayerIds.includes(p.player_id))
  .sort((a, b) => (a.player_id < b.player_id ? -1 : 1));
if (goalies.length < 2) {
  console.error("Expected two scratch goalies on the test team.");
  process.exit(1);
}

const picked = goalies[1];
const other = goalies[0];
const EMPTY_NET = 2;
const AWAY_GOALS = 5;

const teamARoster = await rosterOf(teamA);
const dress = (roster, gameId, teamId, take = 10) =>
  roster.slice(0, take).map((p) => ({ game_id: gameId, team_id: teamId, player_id: p.player_id }));

/**
 * Team A's lineup, with the goalies named explicitly.
 *
 * `dress` takes the first N by jersey number, and the scratch goalie has none,
 * so it would sort last and fall outside the cut — leaving "the other dressed
 * goalie was not credited" true for the wrong reason.
 */
const dressTeamA = (gameId, goalieIds) => [
  ...teamARoster
    .filter((p) => p.position !== "G")
    .slice(0, 8)
    .map((p) => ({ game_id: gameId, team_id: teamA, player_id: p.player_id })),
  ...goalieIds.map((id) => ({ game_id: gameId, team_id: teamA, player_id: id })),
];

const ZERO = { gp: 0, wins: 0, losses: 0, ties: 0, ga: 0, so: 0, gaa: null };
const goalieRow = async (playerId, teamId) => {
  const { data } = await admin
    .from("v_goalie_stats")
    .select("gp, wins, losses, ties, ga, so, gaa")
    .eq("season_id", season.id)
    .eq("player_id", playerId)
    .eq("team_id", teamId)
    .maybeSingle();
  return data ?? ZERO;
};

let transferRowId = null;
let teamB = null;

try {
  // --- 1. goalie of record + empty net ------------------------------------
  const g1 = games[0];
  const awayRoster = await rosterOf(g1.away_team_id);
  // The seed already has final games, so every assertion below is a DELTA. An
  // absolute figure here would have said "gp=4" and meant nothing.
  const pickedBefore = await goalieRow(picked.player_id, teamA);
  const otherBefore = await goalieRow(other.player_id, teamA);

  // Both goalies dressed, so the fallback has something to pick wrongly.
  await admin.from("game_rosters").insert([
    ...dressTeamA(g1.id, [picked.player_id, other.player_id]),
    ...dress(awayRoster, g1.id, g1.away_team_id),
  ]);
  await admin
    .from("games")
    .update({
      status: "final",
      home_goals: 1,
      away_goals: AWAY_GOALS,
      result_type: "regulation",
      home_goalie_id: picked.player_id,
      home_empty_net_against: EMPTY_NET,
      finalized_at: new Date().toISOString(),
    })
    .eq("id", g1.id);

  const pickedAfter = await goalieRow(picked.player_id, teamA);
  const otherAfter = await goalieRow(other.player_id, teamA);
  const hard =
    ok(
      pickedAfter.gp === pickedBefore.gp + 1,
      `goalie of record credited the PICKED goalie (gp ${pickedBefore.gp} -> ${pickedAfter.gp})`,
    ) &
    ok(
      otherAfter.gp === otherBefore.gp,
      `the other DRESSED goalie was not credited (gp ${otherBefore.gp} -> ${otherAfter.gp})`,
    ) &
    ok(
      pickedAfter.ga === pickedBefore.ga + (AWAY_GOALS - EMPTY_NET),
      `empty-net goals excluded from GA (${AWAY_GOALS} against, ${EMPTY_NET} empty-net, ` +
        `GA ${pickedBefore.ga} -> ${pickedAfter.ga})`,
    ) &
    ok(
      Number(pickedAfter.gaa) === Math.round((pickedAfter.ga / pickedAfter.gp) * 100) / 100,
      `GAA computed from the adjusted GA (gaa=${pickedAfter.gaa})`,
    );
  if (!hard) {
    console.error("\n⛔ Assertion 1 failed — the 0015 restore in 0037 is incomplete. Stopping.");
    throw new Error("goalie of record");
  }

  // --- 2. a transfer must not touch the old team's record ------------------
  // Second game with NO explicit pick, so this one goes through the dressed
  // position='G' fallback — the branch that joins team_players, and therefore
  // the branch a departure could silently erase.
  const g2 = games[1];
  const away2 = await rosterOf(g2.away_team_id);
  // Only the one goalie dressed, so the fallback has exactly one answer.
  await admin.from("game_rosters").insert([
    ...dressTeamA(g2.id, [picked.player_id]),
    ...dress(away2, g2.id, g2.away_team_id),
  ]);
  await admin
    .from("games")
    .update({
      status: "final",
      home_goals: 4,
      away_goals: 0,
      result_type: "regulation",
      finalized_at: new Date().toISOString(),
    })
    .eq("id", g2.id);

  const before = await goalieRow(picked.player_id, teamA);
  ok(
    before.gp === pickedAfter.gp + 1,
    `fallback credited the only dressed goalie too (gp ${pickedAfter.gp} -> ${before.gp})`,
  );
  ok(
    before.so === pickedAfter.so + 1,
    `shutout recorded on the second game (so ${pickedAfter.so} -> ${before.so})`,
  );

  const { data: otherTeams } = await admin
    .from("season_teams")
    .select("team_id")
    .eq("season_id", season.id)
    .neq("team_id", teamA)
    .limit(1);
  teamB = otherTeams?.[0]?.team_id;

  // The transfer itself, in B6's order: depart first, then join, or 0036's
  // one-active-team index rejects the insert.
  await admin
    .from("team_players")
    .update({ left_on: new Date().toISOString().slice(0, 10), is_captain: false })
    .eq("id", picked.id);
  const { data: joined, error: jErr } = await admin
    .from("team_players")
    .insert({
      season_id: season.id,
      team_id: teamB,
      player_id: picked.player_id,
      position: "G",
      jersey_number: null,
    })
    .select("id")
    .single();
  if (jErr) throw new Error("transfer insert: " + jErr.message);
  transferRowId = joined.id;

  const after = await goalieRow(picked.player_id, teamA);
  ok(
    after.gp === before.gp &&
      after.wins === before.wins &&
      after.losses === before.losses &&
      after.so === before.so &&
      String(after.gaa) === String(before.gaa),
    `team A's goalie record survived the transfer (gp ${before.gp}, W ${before.wins}, ` +
      `L ${before.losses}, SO ${before.so}, GAA ${before.gaa})`,
  );

  const { data: totals } = await admin
    .from("v_goalie_season_totals")
    .select("gp, ga, gaa, team_id")
    .eq("season_id", season.id)
    .eq("player_id", picked.player_id)
    .maybeSingle();
  ok(totals?.gp === before.gp, `season totals roll the teams up into one row (gp=${totals?.gp})`);
  ok(
    totals?.team_id === teamB,
    "the totals row shows the CURRENT team, not the one the games were played for",
  );
  ok(
    Number(totals?.gaa) === Math.round((before.ga / before.gp) * 100) / 100,
    `season GAA recomputed from totals, not averaged (gaa=${totals?.gaa})`,
  );

  // --- 3. RLS through the nested views ------------------------------------
  const publicRows = await asAnon
    .from("v_skater_season_totals")
    .select("player_id")
    .eq("season_id", season.id);
  ok(
    (publicRows.data?.length ?? 0) > 0,
    `anon reads the totals view for a public league (${publicRows.data?.length ?? 0} rows)`,
  );

  try {
    await admin.from("leagues").update({ is_public: false }).eq("id", season.league_id);
    const privateRows = await asAnon
      .from("v_skater_season_totals")
      .select("player_id")
      .eq("season_id", season.id);
    ok(
      (privateRows.data?.length ?? 0) === 0,
      `anon reads nothing once the league is private (${privateRows.data?.length ?? 0} rows)`,
    );
  } finally {
    // In a finally of its own: a failed assertion above must not leave a live
    // league dark.
    await admin.from("leagues").update({ is_public: true }).eq("id", season.league_id);
  }

  // --- 4. grants ----------------------------------------------------------
  // Supabase's default privileges appear to cover new objects — team_goalie_days
  // (0023) has anon SELECT with no grant in its migration — but
  // 0034_league_office.sql asserts the opposite for tables, so settle it here
  // rather than trusting either.
  // Probed rather than read out of information_schema: what matters is whether
  // an anonymous request gets rows or 42501, and that is the same question the
  // browser asks.
  for (const view of ["v_skater_season_totals", "v_goalie_season_totals"]) {
    const r = await asAnon.from(view).select("season_id").limit(1);
    ok(
      r.error?.code !== "42501",
      `anon holds SELECT on ${view}${r.error ? ` (${r.error.code} ${r.error.message})` : ""}`,
    );
  }
} finally {
  // --- revert ------------------------------------------------------------
  if (transferRowId) await admin.from("team_players").delete().eq("id", transferRowId);
  await admin.from("team_players").update({ left_on: null }).eq("id", picked.id);
  if (scratchRosterIds.length) {
    await admin.from("team_players").delete().in("id", scratchRosterIds);
  }
  // Deleted after their roster rows: game_rosters.player_id cascades, so a
  // player deleted first would take their game rows with it.
  if (scratchPlayerIds.length) {
    await admin.from("players").delete().in("id", scratchPlayerIds);
  }
  for (const g of games) {
    await admin.from("game_rosters").delete().eq("game_id", g.id);
    await admin
      .from("games")
      .update({
        status: "scheduled",
        home_goals: 0,
        away_goals: 0,
        result_type: "regulation",
        home_goalie_id: null,
        home_empty_net_against: 0,
        finalized_at: null,
        finalized_by: null,
      })
      .eq("id", g.id);
  }
}

console.log(
  failures === 0
    ? "\nverify-transfers done (reverted test games)"
    : `\nverify-transfers FAILED: ${failures} assertion(s) (reverted test games)`,
);
process.exit(failures === 0 ? 0 : 1);
