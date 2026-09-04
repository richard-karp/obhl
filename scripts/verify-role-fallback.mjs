// Probes the lockout fix in `src/lib/auth/session.ts`: an account whose JWT
// carries NO role claim, but whose `profiles.role` is set, must reach the manage
// tools.
//
// ⛔ THIS PROBES, IT DOES NOT READ THE CODE. The failure being guarded against is
// a session with `role: null` that every guard refuses while the profile says
// otherwise, and the only way to know that is fixed is to hold such a session and
// try. So this mints a real one: the custom-access-token hook (0010) injects
// `app_metadata.role` only `if v_role is not null`, so an account signed in while
// its `profiles.role` is NULL gets a token with no claim at all — exactly the
// shape of a token minted before the hook was enabled. Setting the role
// afterwards leaves that already-issued token untouched, which is the case the
// fix exists for.
//
// Safe to run against a live local database. It creates one throwaway account,
// touches nothing else, and deletes it in a `finally`. It never resets anything.
//
//   node --env-file-if-exists=.env.local scripts/verify-role-fallback.mjs
//
// The app half needs a dev server; it is skipped (loudly) when none answers.
//   PORT=3002 npm run dev
import { createClient } from "@supabase/supabase-js";
import { createServerClient } from "@supabase/ssr";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL || "http://127.0.0.1:54321";
const anon = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
const secret = process.env.SUPABASE_SECRET_KEY;
const PORT = process.env.PORT ?? "3000";
const ORIGIN = `http://localhost:${PORT}`;
const SLUG = process.env.PROBE_LEAGUE ?? "obhl";
const PASSWORD = "probe-password-123";

if (!anon || !secret) {
  console.error("Missing Supabase keys (they're in .env.local).");
  process.exit(1);
}

const admin = createClient(url, secret, {
  auth: { autoRefreshToken: false, persistSession: false },
});
const decode = (jwt) =>
  JSON.parse(Buffer.from(jwt.split(".")[1], "base64").toString());

let failures = 0;
const ok = (pass, label, detail = "") => {
  if (!pass) failures++;
  console.log(`${pass ? "✓" : "✗ FAIL"} ${label}${detail ? ` — ${detail}` : ""}`);
};

/**
 * A browser's cookie jar, filled by the SAME library the app reads them with.
 *
 * Hand-rolling the cookie would mean re-implementing `@supabase/ssr`'s base64url
 * prefix and its 3180-byte chunking, and a probe that forges its own session in a
 * format the app does not actually use proves nothing about the app. So the real
 * client writes them and we replay what it wrote.
 */
function jarClient() {
  const jar = new Map();
  const client = createServerClient(url, anon, {
    cookies: {
      getAll: () => [...jar].map(([name, value]) => ({ name, value })),
      setAll: (list) => {
        for (const { name, value } of list) {
          if (value) jar.set(name, value);
          else jar.delete(name);
        }
      },
    },
  });
  const header = () =>
    [...jar].map(([n, v]) => `${n}=${encodeURIComponent(v)}`).join("; ");
  return { client, jar, header };
}

/** The access token currently in the jar, decoded. */
function tokenInJar(jar) {
  const parts = [...jar]
    .filter(([n]) => n.includes("auth-token"))
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([, v]) => v)
    .join("");
  const raw = parts.startsWith("base64-")
    ? Buffer.from(parts.slice("base64-".length), "base64url").toString()
    : parts;
  return JSON.parse(raw).access_token;
}

async function fetchAs(header, path) {
  return fetch(`${ORIGIN}${path}`, {
    headers: { cookie: header },
    redirect: "manual",
  });
}

const email = `role-fallback-probe-${Date.now()}@obhl.test`;
let userId = null;

try {
  const { data: league } = await admin
    .from("leagues")
    .select("id, slug")
    .eq("slug", SLUG)
    .maybeSingle();
  if (!league) {
    console.error(`No league with slug "${SLUG}" — seed the database first.`);
    process.exit(1);
  }

  // 1. An account with a login, a profile, and a league — but NO role yet.
  const { data: created, error: createError } = await admin.auth.admin.createUser({
    email,
    password: PASSWORD,
    email_confirm: true,
  });
  if (createError) throw new Error(`createUser: ${createError.message}`);
  userId = created.user.id;

  const { error: profileError } = await admin
    .from("profiles")
    .upsert({ id: userId, role: null, display_name: "Role Fallback Probe" });
  if (profileError) throw new Error(`profiles: ${profileError.message}`);

  // Membership up front, so the ONLY difference between the control below and
  // the probe is `profiles.role`. Without this the control would be refused by
  // the membership check and prove nothing about the role one.
  const { error: memberError } = await admin
    .from("profile_leagues")
    .upsert(
      { profile_id: userId, league_id: league.id },
      { onConflict: "profile_id,league_id" },
    );
  if (memberError) throw new Error(`profile_leagues: ${memberError.message}`);

  // 2. Sign in WHILE the role is null. The hook skips a null role, so the token
  //    is minted without the claim — the "hook did not fire" shape.
  const session = jarClient();
  const { error: signInError } = await session.client.auth.signInWithPassword({
    email,
    password: PASSWORD,
  });
  if (signInError) throw new Error(`signIn: ${signInError.message}`);

  const claims = decode(tokenInJar(session.jar));
  ok(
    claims.app_metadata?.role === undefined,
    "the minted token carries NO app_metadata.role",
    `app_metadata=${JSON.stringify(claims.app_metadata ?? {})}`,
  );
  const minsLeft = Math.round((claims.exp * 1000 - Date.now()) / 60000);
  ok(
    minsLeft > 5,
    "the token is nowhere near expiry, so nothing here can refresh it into a claim",
    `${minsLeft} min left`,
  );

  const asUser = () =>
    createClient(url, anon, {
      auth: { persistSession: false },
      global: {
        headers: { Authorization: `Bearer ${tokenInJar(session.jar)}` },
      },
    });

  // 3. The fallback's own query, run under the caller's RLS exactly as
  //    `roleFromProfile` does. `own profile read` (0009) is `id = auth.uid()`
  //    and does NOT call auth_role(), so a claimless session can still read it.
  const before = await asUser().from("profiles").select("role").eq("id", userId).maybeSingle();
  ok(
    !before.error && before.data?.role === null,
    "a claimless session reads its own profile under RLS (role still null)",
    before.error ? before.error.message : `role=${before.data?.role}`,
  );

  // 4. The app control, BEFORE the role exists: refused.
  const reachable = await fetch(ORIGIN, { redirect: "manual" }).then(
    () => true,
    () => false,
  );
  if (!reachable) {
    console.log(
      `\n⚠ SKIPPED the app half: nothing answering on ${ORIGIN}. Start one with \`PORT=${PORT} npm run dev\` and re-run.`,
    );
  } else {
    // ⚠️ The dashboard is NOT role-guarded — `requireUser`, then an explanation
    // for an account with no role, deliberately, because it is the one page that
    // tells someone why nothing works. So the control reads the body, and a
    // role-GUARDED page is checked alongside it.
    const controlDash = await fetchAs(session.header(), `/${SLUG}/manage/dashboard`);
    const controlBody = await controlDash.text();
    ok(
      controlDash.status === 200 &&
        controlBody.includes("Your account has no role yet") &&
        !controlBody.includes("People &amp; Roles"),
      "control: with no claim and no profile role, the dashboard offers no tools",
      `${controlDash.status}, ${controlBody.includes("Your account has no role yet") ? "role-less shell" : "NOT the role-less shell"}`,
    );
    const controlPeople = await fetchAs(session.header(), `/${SLUG}/manage/people`);
    ok(
      controlPeople.status >= 300 && controlPeople.status < 400,
      "control: a role-guarded page refuses it",
      `${controlPeople.status} -> ${controlPeople.headers.get("location") ?? "(no redirect)"}`,
    );
  }

  // 5. The role lands in `profiles`. The token is NOT reissued.
  const { error: roleError } = await admin
    .from("profiles")
    .update({ role: "league_manager" })
    .eq("id", userId);
  if (roleError) throw new Error(`set role: ${roleError.message}`);

  const after = await asUser().from("profiles").select("role").eq("id", userId).maybeSingle();
  ok(
    !after.error && after.data?.role === "league_manager",
    "the fallback query now answers league_manager, on the caller's own RLS",
    after.error ? after.error.message : `role=${after.data?.role}`,
  );
  ok(
    decode(tokenInJar(session.jar)).app_metadata?.role === undefined,
    "and the session's token STILL has no role claim",
  );

  if (reachable) {
    const probe = await fetchAs(session.header(), `/${SLUG}/manage/dashboard`);
    const body = probe.status === 200 ? await probe.text() : "";
    ok(
      probe.status === 200 &&
        (body.includes("People &amp; Roles") || body.includes("People & Roles")),
      "THE BAR: the claimless account now gets the MANAGER dashboard, tools and all",
      `${probe.status}${probe.status !== 200 ? ` -> ${probe.headers.get("location")}` : ""}`,
    );
    ok(
      !body.includes("Your account has no role yet"),
      "…and no longer the role-less shell",
    );
    const people = await fetchAs(session.header(), `/${SLUG}/manage/people`);
    ok(
      people.status === 200,
      "…and the role-guarded page that refused it a moment ago now answers",
      `${people.status}${people.status !== 200 ? ` -> ${people.headers.get("location")}` : ""}`,
    );

    // The office is a tier, not a role: a claimless league_manager must not
    // acquire one. Guards still say no where they said no before.
    const office = await fetchAs(session.header(), "/manage/office");
    ok(
      office.status >= 300 && office.status < 400,
      "the fallback grants the ROLE and nothing else — the office still refuses",
      `${office.status} -> ${office.headers.get("location") ?? "(no redirect)"}`,
    );
  }
} finally {
  if (userId) {
    await admin.from("profile_leagues").delete().eq("profile_id", userId);
    await admin.from("profiles").delete().eq("id", userId);
    await admin.auth.admin.deleteUser(userId);
    console.log(`\ncleaned up ${email}`);
  }
}

if (failures > 0) {
  console.error(`\nverify-role-fallback FAILED: ${failures} check(s) failed.`);
  process.exit(1);
}
console.log("\nverify-role-fallback done — all checks passed.");
