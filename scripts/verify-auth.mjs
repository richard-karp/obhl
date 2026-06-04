// Verifies the auth hook (JWT role claim) and role/write RLS end-to-end via
// real password logins. Local verification only.
import { createClient } from "@supabase/supabase-js";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL || "http://127.0.0.1:54321";
const anon = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
const secret = process.env.SUPABASE_SECRET_KEY;
const PW = "hockey123";
if (!anon || !secret) {
  console.error("Missing Supabase keys (they're in .env.local). Run `npm run verify:auth`.");
  process.exit(1);
}

const admin = createClient(url, secret, { auth: { persistSession: false } });
const decode = (jwt) =>
  JSON.parse(Buffer.from(jwt.split(".")[1], "base64").toString());

async function login(email) {
  const sb = createClient(url, anon, { auth: { persistSession: false } });
  const { data, error } = await sb.auth.signInWithPassword({ email, password: PW });
  if (error) throw new Error(`${email}: ${error.message}`);
  return data.session.access_token;
}
const asUser = (token) =>
  createClient(url, anon, {
    auth: { persistSession: false },
    global: { headers: { Authorization: `Bearer ${token}` } },
  });

async function check(label, query, wantOk) {
  const { error } = await query;
  const ok = !error;
  const pass = ok === wantOk;
  console.log(
    `${pass ? "✓" : "✗ FAIL"} ${label} -> ${ok ? "allowed" : "denied"}${
      error ? ` (${error.code ?? error.message})` : ""
    }`,
  );
}

// --- JWT role claims ---
const tokens = {};
for (const [role, email] of Object.entries({
  manager: "manager@obhl.test",
  scorekeeper: "scorekeeper@obhl.test",
  captain: "captain@obhl.test",
})) {
  const t = await login(email);
  tokens[role] = t;
  console.log(`jwt ${role}: app_metadata.role = ${decode(t).app_metadata?.role}`);
}

// --- fixtures ---
const { data: league } = await admin.from("leagues").select("id").limit(1).single();
const { data: sched } = await admin
  .from("games")
  .select("id, home_team_id, season_id")
  .eq("status", "scheduled")
  .limit(1)
  .single();
const { data: fin } = await admin.from("games").select("id, home_team_id").eq("status", "final").limit(1).single();
// A player on the scheduled game's home team (to dress).
const { data: schedPlayer } = await admin
  .from("team_players")
  .select("player_id")
  .eq("season_id", sched.season_id)
  .eq("team_id", sched.home_team_id)
  .limit(1)
  .single();

console.log("\n-- manager --");
await check(
  "manager inserts season",
  asUser(tokens.manager).from("seasons").insert({ league_id: league.id, name: "TEST DELETE", is_active: false }).select(),
  true,
);
await admin.from("seasons").delete().eq("name", "TEST DELETE");

console.log("\n-- scorekeeper --");
const sk = asUser(tokens.scorekeeper);
await check(
  "scorekeeper dresses a player in non-final game",
  sk.from("game_rosters").insert({ game_id: sched.id, team_id: sched.home_team_id, player_id: schedPlayer.player_id }).select(),
  true,
);
// A completed game stays editable for the scorekeeper (fix-after-the-fact).
const { data: finRow } = await admin
  .from("game_rosters")
  .select("id, goals")
  .eq("game_id", fin.id)
  .limit(1)
  .single();
await check(
  "scorekeeper edits a COMPLETED game (still allowed)",
  sk.from("game_rosters").update({ goals: finRow.goals }).eq("id", finRow.id).select(),
  true,
);
const { data: finScore } = await admin.from("games").select("home_goals").eq("id", fin.id).single();
await check(
  "scorekeeper re-syncs a COMPLETED game's score (games update)",
  sk.from("games").update({ home_goals: finScore.home_goals }).eq("id", fin.id).select(),
  true,
);
await check(
  "scorekeeper inserts season (should deny)",
  sk.from("seasons").insert({ league_id: league.id, name: "NOPE", is_active: false }).select(),
  false,
);
await admin.from("game_rosters").delete().eq("game_id", sched.id);

console.log("\n-- captain --");
const cap = asUser(tokens.captain);
const { data: capProf } = await admin.from("profiles").select("player_id").eq("role", "captain").single();
const { data: capTP } = await admin
  .from("team_players")
  .select("team_id, season_id")
  .eq("player_id", capProf.player_id)
  .eq("is_captain", true)
  .single();
const { data: capGame } = await admin
  .from("games")
  .select("id, home_team_id, away_team_id")
  .eq("status", "scheduled")
  .or(`home_team_id.eq.${capTP.team_id},away_team_id.eq.${capTP.team_id}`)
  .limit(1)
  .single();
const { data: capPlayer } = await admin
  .from("team_players")
  .select("player_id")
  .eq("team_id", capTP.team_id)
  .eq("season_id", capTP.season_id)
  .limit(1)
  .single();
const otherTeam = capGame.home_team_id === capTP.team_id ? capGame.away_team_id : capGame.home_team_id;
const { data: otherPlayer } = await admin
  .from("team_players")
  .select("player_id")
  .eq("team_id", otherTeam)
  .eq("season_id", capTP.season_id)
  .limit(1)
  .single();

// Scoring now lives on game_rosters counters; captains can write their own
// team's lineup (the stat counters are UI-gated, not RLS-gated).
await check(
  "captain sets roster for OWN team",
  cap.from("game_rosters").insert({ game_id: capGame.id, team_id: capTP.team_id, player_id: capPlayer.player_id }).select(),
  true,
);
await check(
  "captain sets roster for OTHER team (should deny)",
  cap.from("game_rosters").insert({ game_id: capGame.id, team_id: otherTeam, player_id: otherPlayer.player_id }).select(),
  false,
);
// Captains lock out once the game is finalized (unlike scorekeepers). Note: an
// UPDATE blocked by a policy's USING clause affects 0 rows WITHOUT raising an
// error, so "denied" here means error OR zero rows changed.
const { data: capFinGame } = await admin
  .from("games")
  .select("id")
  .eq("status", "final")
  .or(`home_team_id.eq.${capTP.team_id},away_team_id.eq.${capTP.team_id}`)
  .limit(1)
  .single();
const { data: capFinRow } = await admin
  .from("game_rosters")
  .select("id, goals")
  .eq("game_id", capFinGame.id)
  .eq("team_id", capTP.team_id)
  .limit(1)
  .single();
const capEdit = await cap
  .from("game_rosters")
  .update({ goals: capFinRow.goals })
  .eq("id", capFinRow.id)
  .select();
const capDenied = !!capEdit.error || (capEdit.data?.length ?? 0) === 0;
console.log(
  `${capDenied ? "✓" : "✗ FAIL"} captain edits a COMPLETED game (should deny) -> ${capDenied ? "denied" : "allowed"}`,
);
await admin.from("game_rosters").delete().eq("game_id", capGame.id);

console.log("\nverify-auth done");
