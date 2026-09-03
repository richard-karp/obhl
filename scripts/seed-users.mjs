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

// `leagues` is the list of league slugs each account is a MEMBER of
// (profile_leagues, 0032). A role says what an account may do; membership says
// where. The three original accounts belong to every seeded league, which is
// what they could already reach before membership existed.
//
// The last two are the exception, and the reason they exist: staff accounts
// confined to ONE league each. Without them the whole suite runs as a manager
// who belongs to everything, and every cross-league guard passes whether or not
// it is there.
//
// Their addresses deliberately do not contain any other account's address as a
// substring. `obhl-scorekeeper@` did, and it broke two long-standing People &
// Roles tests that locate a row by `hasText: "scorekeeper@obhl.test"` — the
// leak they were written to catch and a second seeded account look identical
// to a substring match.
//
// `ALL` is resolved against whatever seed.sql actually created, rather than a
// list of slugs repeated here. A third seeded league would otherwise quietly
// leave these accounts out of it, and the failures would surface as unrelated
// tests losing access to a league nobody remembered they had to be added to.
const ALL = "all";

const staff = [
  {
    email: "manager@obhl.test",
    role: "league_manager",
    display_name: "League Manager",
    leagues: ALL,
  },
  {
    email: "scorekeeper@obhl.test",
    role: "scorekeeper",
    display_name: "Score Keeper",
    leagues: ALL,
  },
  {
    email: "captain@obhl.test",
    role: "captain",
    display_name: "Sharks Captain",
    captainTeamSlug: "sharks",
    leagues: ALL,
  },
  {
    email: "single-league-lead@obhl.test",
    role: "league_manager",
    display_name: "Single League Manager",
    // WHICH league is fixture detail, and belongs here rather than in the app.
    leagues: ["harbor"],
  },
  {
    email: "single-league-scorer@obhl.test",
    role: "scorekeeper",
    display_name: "Single League Scorer",
    leagues: ["obhl"],
  },
  // ⛔ SIX AND SEVEN ARE NEW ACCOUNTS, NEVER AN ELEVATED FIXTURE. Giving
  // `manager@obhl.test` a tier would hand office powers to every test that signs
  // in as Manager, and the cross-league guards would stop being exercised while
  // still reporting green — the same failure the note above describes for the
  // one-league accounts. All five above stay exactly as they are.
  //
  // `leagues: []` is the whole point of them. The office reaches every league
  // WITHOUT a `profile_leagues` row, so an account with memberships would prove
  // nothing about implicit membership — it would pass whether the office branch
  // worked or not.
  //
  // Both are `league_manager`, and must be: 0034's trigger refuses a tier for
  // any other role, and the tier multiplies reach rather than granting a role,
  // so a captain in the office would have no manager powers at all.
  {
    email: "commissioner@obhl.test",
    role: "league_manager",
    display_name: "League Commissioner",
    leagues: [],
    office: "commissioner",
    // A commissioner who also plays — see `findNonCaptainPlayer`.
    playsAsNonCaptain: true,
  },
  {
    email: "deputy@obhl.test",
    role: "league_manager",
    display_name: "Deputy Commissioner",
    leagues: [],
    office: "deputy",
  },
];

/** slug -> league id, for the membership rows below. */
async function leagueIdsBySlug() {
  const { data, error } = await admin.from("leagues").select("id, slug");
  if (error) throw new Error(`could not read leagues: ${error.message}`);
  return new Map((data || []).map((l) => [l.slug, l.id]));
}

/**
 * A player who captains nothing, for the commissioner.
 *
 * A commissioner may also PLAY, and this is where that stops being an assumption:
 * `profiles.player_id` is what the captain surfaces key on, not `role`, so the
 * office account carries a real player link.
 *
 * It must not be a CAPTAIN's player. Both consumers of `player_id`
 * (`manage/score/[gameId]` and `games.ts`) join `team_players` on
 * `is_captain = true`, so pointing two profiles at one captain's player would
 * hand the commissioner that team's captain surface and change what the captain
 * fixtures mean. A non-captain link is inert to both.
 */
async function findNonCaptainPlayer() {
  const { data: caps } = await admin
    .from("team_players")
    .select("player_id")
    .eq("is_captain", true);
  const captains = new Set((caps || []).map((r) => r.player_id));
  const { data: players } = await admin.from("players").select("id").order("id");
  return (players || []).find((p) => !captains.has(p.id))?.id ?? null;
}

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
  if (!error) return { id: data.user.id };
  // Already exists — find it and (re)set the local password.
  const { data: list, error: listError } = await admin.auth.admin.listUsers();
  const id = list?.users.find((u) => u.email === email)?.id ?? null;
  if (id) await admin.auth.admin.updateUserById(id, { password: LOCAL_PASSWORD });
  return { id, error: id ? null : (listError ?? error) };
}

/**
 * `supabase db reset` restarts the containers, and e2e's global-setup runs this
 * immediately afterwards. Auth answers before it can write, so the first attempt
 * can fail against a stack that is seconds from working — retry rather than
 * treat that as a verdict.
 */
async function ensureUserReady(email, attempts = 10, delayMs = 1000) {
  let last;
  for (let i = 1; i <= attempts; i++) {
    last = await ensureUser(email);
    if (last.id) return last;
    if (i < attempts) await new Promise((r) => setTimeout(r, delayMs));
  }
  return last;
}

let failures = 0;
const leagueId = await leagueIdsBySlug();

for (const s of staff) {
  const { id: userId, error: userError } = await ensureUserReady(s.email);
  if (!userId) {
    console.error(
      `could not create/find user ${s.email}: ${userError?.message ?? "unknown error"}`,
    );
    failures++;
    continue;
  }
  const player_id = s.captainTeamSlug
    ? await findCaptainPlayer(s.captainTeamSlug)
    : s.playsAsNonCaptain
      ? await findNonCaptainPlayer()
      : null;
  const { error } = await admin
    .from("profiles")
    .upsert({ id: userId, role: s.role, display_name: s.display_name, player_id });
  if (error) failures++;

  // The tier, after the profile exists and holds `league_manager` — 0034's
  // trigger reads the role and refuses otherwise, so the order here is not
  // cosmetic. Idempotent, so re-seeding an existing office account is a no-op
  // rather than a primary-key error.
  let officeError = null;
  if (s.office) {
    const { error: oErr } = await admin
      .from("league_office")
      .upsert({ profile_id: userId, tier: s.office }, { onConflict: "profile_id" });
    if (oErr) {
      officeError = oErr.message;
      failures++;
    }
  }

  // Membership. 0032's backfill cannot do this: `db reset` runs the migrations
  // and seed.sql (which creates the leagues) before this script creates the
  // profiles, so there is nothing to cross-join at migration time.
  const wanted = s.leagues === ALL ? [...leagueId.keys()] : s.leagues || [];
  const unknown = wanted.filter((slug) => !leagueId.get(slug));
  let memberError = unknown.length
    ? `unknown league slug(s): ${unknown.join(", ")}`
    : null;

  // The known ones are written even when another slug is bad, so the account is
  // usable for every league that does exist; `failures` still makes the run
  // exit non-zero, so a typo cannot pass as success.
  const rows = wanted
    .filter((slug) => leagueId.get(slug))
    .map((slug) => ({ profile_id: userId, league_id: leagueId.get(slug) }));
  if (rows.length) {
    const { error: mErr } = await admin
      .from("profile_leagues")
      .upsert(rows, { onConflict: "profile_id,league_id" });
    if (mErr) memberError = [memberError, mErr.message].filter(Boolean).join("; ");
  }
  if (memberError) failures++;

  const where = wanted.join(", ") || "no leagues";
  console.log(
    `${s.email} -> ${s.role} [${where}]` +
      `${s.office ? ` {${s.office}}` : ""}` +
      `${error ? ` ERROR: ${error.message}` : ""}` +
      `${memberError ? ` MEMBERSHIP ERROR: ${memberError}` : ""}` +
      `${officeError ? ` OFFICE ERROR: ${officeError}` : ""}` +
      `${!error && !memberError && !officeError ? " ok" : ""}`,
  );
}

if (failures > 0) {
  // Exiting 0 here is what made one unready container look like 67 failing
  // tests: global-setup reported "Ready" and the whole authenticated suite ran
  // against a database with no staff accounts.
  console.error(
    `seed-users FAILED: ${failures} of ${staff.length} accounts not seeded.`,
  );
  process.exit(1);
}
console.log("seed-users done");
