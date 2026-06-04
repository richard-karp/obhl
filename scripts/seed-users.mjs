// Seeds the staff accounts for local dev via the Supabase admin API.
// Run after `supabase db reset`: `npm run seed:users`.
import { createClient } from "@supabase/supabase-js";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL || "http://127.0.0.1:54321";
const secret = process.env.SUPABASE_SECRET_KEY;
if (!secret) {
  console.error("Missing SUPABASE_SECRET_KEY (it's in .env.local). Run `npm run seed:users`.");
  process.exit(1);
}

const admin = createClient(url, secret, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const staff = [
  { email: "manager@obhl.test", role: "league_manager", display_name: "League Manager" },
  { email: "scorekeeper@obhl.test", role: "scorekeeper", display_name: "Score Keeper" },
  {
    email: "captain@obhl.test",
    role: "captain",
    display_name: "Sharks Captain",
    captainTeamSlug: "sharks",
  },
];

async function findCaptainPlayer(slug) {
  const { data } = await admin
    .from("team_players")
    .select("player_id, is_captain, teams!team_players_team_id_fkey(slug)")
    .eq("is_captain", true);
  const row = (data || []).find((r) => r.teams?.slug === slug);
  return row?.player_id ?? null;
}

// Local-only password so the accounts can be tested programmatically. The real
// sign-in flow is magic link; this just makes local verification easy.
const LOCAL_PASSWORD = "hockey123";

async function ensureUser(email) {
  const { data, error } = await admin.auth.admin.createUser({
    email,
    password: LOCAL_PASSWORD,
    email_confirm: true,
  });
  if (!error) return data.user.id;
  // Already exists — find it and (re)set the local password.
  const { data: list } = await admin.auth.admin.listUsers();
  const id = list.users.find((u) => u.email === email)?.id ?? null;
  if (id) await admin.auth.admin.updateUserById(id, { password: LOCAL_PASSWORD });
  return id;
}

for (const s of staff) {
  const userId = await ensureUser(s.email);
  if (!userId) {
    console.error("could not create/find user", s.email);
    continue;
  }
  const player_id = s.captainTeamSlug
    ? await findCaptainPlayer(s.captainTeamSlug)
    : null;
  const { error } = await admin
    .from("profiles")
    .upsert({ id: userId, role: s.role, display_name: s.display_name, player_id });
  console.log(`${s.email} -> ${s.role}${error ? ` ERROR: ${error.message}` : " ok"}`);
}
console.log("seed-users done");
