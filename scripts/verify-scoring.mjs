// E2E: as the scorekeeper, dress both teams + record goals on a scheduled game,
// finalize it, and verify the result propagates into standings and skater stats
// (including the GP-from-roster / dressed-but-didn't-score check).
import { createClient } from "@supabase/supabase-js";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL || "http://127.0.0.1:54321";
const anon = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
const secret = process.env.SUPABASE_SECRET_KEY;
if (!anon || !secret) {
  console.error("Missing Supabase keys (they're in .env.local). Run `npm run verify:scoring`.");
  process.exit(1);
}
const admin = createClient(url, secret, { auth: { persistSession: false } });

const sk = createClient(url, anon, { auth: { persistSession: false } });
const { data: login, error: lerr } = await sk.auth.signInWithPassword({
  email: "scorekeeper@obhl.test",
  password: "hockey123",
});
if (lerr) throw lerr;
const token = login.session.access_token;
const asSK = createClient(url, anon, {
  auth: { persistSession: false },
  global: { headers: { Authorization: `Bearer ${token}` } },
});

// Pick a scheduled game.
const { data: game } = await admin
  .from("games")
  .select("id, home_team_id, away_team_id, season_id")
  .eq("status", "scheduled")
  .order("scheduled_at", { ascending: true })
  .limit(1)
  .single();

const seasonId = game.season_id;
const rosterOf = async (teamId) => {
  const { data } = await admin
    .from("team_players")
    .select("player_id, position, jersey_number")
    .eq("season_id", seasonId)
    .eq("team_id", teamId)
    .order("jersey_number");
  return data;
};
const homeRoster = await rosterOf(game.home_team_id);
const awayRoster = await rosterOf(game.away_team_id);
const homeSkaters = homeRoster.filter((p) => p.position !== "G");

const standGP = async (teamId) => {
  const { data } = await admin
    .from("v_standings_raw")
    .select("gp, points")
    .eq("season_id", seasonId)
    .eq("team_id", teamId)
    .single();
  return data;
};
const skater = async (playerId) => {
  const { data } = await admin
    .from("v_skater_stats")
    .select("gp, g")
    .eq("season_id", seasonId)
    .eq("player_id", playerId)
    .maybeSingle();
  return data ?? { gp: 0, g: 0 };
};

const scorer = homeSkaters[1].player_id;
const bench = homeSkaters[4].player_id; // dressed, will NOT score
const awayScorer = awayRoster.filter((p) => p.position !== "G")[1].player_id;

const homeBefore = await standGP(game.home_team_id);
const awayBefore = await standGP(game.away_team_id);
const scorerBefore = await skater(scorer);
const benchBefore = await skater(bench);

// --- as scorekeeper: dress both teams (first 10 each) ---
const dress = (roster, teamId) =>
  roster.slice(0, 10).map((p) => ({ game_id: game.id, team_id: teamId, player_id: p.player_id }));
let r = await asSK.from("game_rosters").insert(dress(homeRoster, game.home_team_id));
if (r.error) throw new Error("dress home: " + r.error.message);
r = await asSK.from("game_rosters").insert(dress(awayRoster, game.away_team_id));
if (r.error) throw new Error("dress away: " + r.error.message);

// --- record goals as per-player counters: 3 home (distinct), 1 away ---
for (const p of [homeSkaters[1], homeSkaters[2], homeSkaters[3]]) {
  r = await asSK
    .from("game_rosters")
    .update({ goals: 1 })
    .eq("game_id", game.id)
    .eq("player_id", p.player_id);
  if (r.error) throw new Error("home goal: " + r.error.message);
}
r = await asSK
  .from("game_rosters")
  .update({ goals: 1 })
  .eq("game_id", game.id)
  .eq("player_id", awayScorer);
if (r.error) throw new Error("away goal: " + r.error.message);

// --- finalize (what finalizeGame does) ---
r = await asSK
  .from("games")
  .update({
    status: "final",
    home_goals: 3,
    away_goals: 1,
    result_type: "regulation",
    finalized_at: new Date().toISOString(),
  })
  .eq("id", game.id);
if (r.error) throw new Error("finalize: " + r.error.message);

// --- verify propagation ---
const homeAfter = await standGP(game.home_team_id);
const awayAfter = await standGP(game.away_team_id);
const scorerAfter = await skater(scorer);
const benchAfter = await skater(bench);

const ok = (cond, label) => console.log(`${cond ? "✓" : "✗ FAIL"} ${label}`);
console.log("propagation after finalize:");
ok(homeAfter.gp === homeBefore.gp + 1, `home GP ${homeBefore.gp} -> ${homeAfter.gp} (+1)`);
ok(awayAfter.gp === awayBefore.gp + 1, `away GP ${awayBefore.gp} -> ${awayAfter.gp} (+1)`);
ok(homeAfter.points === homeBefore.points + 2, `home PTS ${homeBefore.points} -> ${homeAfter.points} (+2 win)`);
ok(scorerAfter.g === scorerBefore.g + 1, `scorer G ${scorerBefore.g} -> ${scorerAfter.g} (+1)`);
ok(
  benchAfter.gp === benchBefore.gp + 1 && benchAfter.g === benchBefore.g,
  `dressed-but-didn't-score: GP ${benchBefore.gp} -> ${benchAfter.gp} (+1), G stayed ${benchAfter.g}`,
);

// --- revert so the seed isn't permanently mutated ---
await admin.from("game_rosters").delete().eq("game_id", game.id);
await admin
  .from("games")
  .update({
    status: "scheduled",
    home_goals: 0,
    away_goals: 0,
    result_type: "regulation",
    finalized_at: null,
    finalized_by: null,
  })
  .eq("id", game.id);

console.log("\nverify-scoring done (reverted test game)");
