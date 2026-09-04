// Probes `setStaffPassword` (src/lib/actions/office.ts) against a running dev
// server: the commissioner path works, and every other caller's hand-made POST
// does not.
//
// ⛔ WHY A HAND-MADE POST AND NOT A BROWSER CLICK. The office page draws the
// set-password card only for a commissioner, and `ACCESS_CONTROL_HANDOFF.md`'s
// *Traps* section is about exactly that comfort: every export of a `"use server"`
// file is a callable endpoint, so an absent button restricts nothing. This
// therefore lifts the form's progressive-enhancement fields out of the
// commissioner's own page and replays them from a deputy's session, a manager's,
// and none at all.
//
// ⛔ AND WHY IT ASSERTS BY SIGNING IN. Watched, with `requireCommissioner`
// replaced by `requireUser`: a manager's replay LANDS and still answers 307,
// because the redirect comes from rendering the page afterwards, not from the
// action refusing. A test reading the status code would have called that a
// refusal while the password changed underneath it.
//
// Touches no seeded fixture: both commissioners in this run are throwaways, and
// every account it creates is deleted in a `finally`. It never resets anything.
//
//   PORT=3002 npm run dev
//   PORT=3002 npm run verify:office-password
import { createClient } from "@supabase/supabase-js";
import { createServerClient } from "@supabase/ssr";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL || "http://127.0.0.1:54321";
const anon = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
const secret = process.env.SUPABASE_SECRET_KEY;
const PORT = process.env.PORT ?? "3000";
const ORIGIN = `http://localhost:${PORT}`;
const SEEDED_PASSWORD = "hockey123";

if (!anon || !secret) {
  console.error("Missing Supabase keys (they're in .env.local).");
  process.exit(1);
}
const admin = createClient(url, secret, {
  auth: { autoRefreshToken: false, persistSession: false },
});

let failures = 0;
const ok = (pass, label, detail = "") => {
  if (!pass) failures++;
  console.log(`${pass ? "✓" : "✗ FAIL"} ${label}${detail ? ` — ${detail}` : ""}`);
};

/** A session's cookies, written by the same library the app reads them with. */
async function cookiesFor(email, password) {
  const store = new Map();
  const client = createServerClient(url, anon, {
    cookies: {
      getAll: () => [...store].map(([name, value]) => ({ name, value })),
      setAll: (list) => {
        for (const { name, value } of list) {
          if (value) store.set(name, value);
          else store.delete(name);
        }
      },
    },
  });
  const { error } = await client.auth.signInWithPassword({ email, password });
  if (error) throw new Error(`${email}: ${error.message}`);
  return [...store].map(([n, v]) => `${n}=${encodeURIComponent(v)}`).join("; ");
}

const canSignIn = async (email, password) => {
  const client = createClient(url, anon, { auth: { persistSession: false } });
  const { error } = await client.auth.signInWithPassword({ email, password });
  return !error;
};

/**
 * The set-password form's hidden fields, as rendered for no-JS submission.
 *
 * React writes `$ACTION_REF_n` / `$ACTION_n:0` / `$ACTION_KEY` into the markup so
 * a `useActionState` form still works before hydration. Replaying them is a real
 * caller reaching a real endpoint — no action id guessed, no browser needed.
 */
function formFields(html) {
  const i = html.indexOf("office-pw-email");
  if (i < 0) return [];
  const form = html.slice(html.lastIndexOf("<form", i), i);
  return [
    ...form.matchAll(/<input type="hidden" name="([^"]+)"(?: value="([^"]*)")?\/>/g),
  ].map((m) => [
    m[1].replace(/&quot;/g, '"'),
    (m[2] ?? "").replace(/&quot;/g, '"'),
  ]);
}

async function submit(cookie, fields, email, password) {
  const body = new FormData();
  for (const [k, v] of fields) body.append(k, v);
  body.append("email", email);
  body.append("password", password);
  const res = await fetch(`${ORIGIN}/manage/office`, {
    method: "POST",
    headers: { cookie, origin: ORIGIN },
    body,
    redirect: "manual",
  });
  return { res, html: res.status === 200 ? await res.text() : "" };
}

/** A throwaway account: a login, a profile, and optionally an office tier. */
async function makeAccount(kind, role, tier = null) {
  const email = `${kind}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@obhl.test`;
  const password = `${kind}-old-pw-0001`;
  const { data, error } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });
  if (error) throw new Error(`createUser ${email}: ${error.message}`);
  const id = data.user.id;
  await admin.from("profiles").upsert({ id, role, display_name: kind });
  // The tier AFTER the profile holds `league_manager` — 0034's trigger reads the
  // role and refuses otherwise, so the order is not cosmetic.
  if (tier) {
    const { error: tierError } = await admin
      .from("league_office")
      .upsert({ profile_id: id, tier }, { onConflict: "profile_id" });
    if (tierError) throw new Error(`tier ${email}: ${tierError.message}`);
  }
  return { id, email, password };
}

const created = [];
try {
  if (!(await fetch(ORIGIN, { redirect: "manual" }).then(() => true, () => false))) {
    console.error(
      `Nothing answering on ${ORIGIN}. Start one with \`PORT=${PORT} npm run dev\`.`,
    );
    process.exit(1);
  }

  // Own commissioner, so no seeded fixture's password is ever changed here.
  const actor = await makeAccount("probe-commissioner", "league_manager", "commissioner");
  created.push(actor);
  const peer = await makeAccount("peer-commissioner", "league_manager", "commissioner");
  created.push(peer);
  const target = await makeAccount("pw-target", "scorekeeper");
  created.push(target);

  const commissioner = await cookiesFor(actor.email, actor.password);
  const page = await fetch(`${ORIGIN}/manage/office`, {
    headers: { cookie: commissioner },
  });
  const html = await page.text();
  const fields = formFields(html);
  ok(
    fields.length >= 3,
    "the commissioner is offered the set-password form",
    fields.map(([k]) => k).join(", ") || "NO FIELDS",
  );

  // --- the path that must work ---
  await submit(commissioner, fields, target.email, "brand-new-pw-01");
  ok(
    await canSignIn(target.email, "brand-new-pw-01"),
    "THE POINT: the password a commissioner sets opens the account",
  );
  ok(
    !(await canSignIn(target.email, target.password)),
    "…and the old one no longer does",
  );

  // --- the callers that must not ---
  const deputyCookie = await cookiesFor("deputy@obhl.test", SEEDED_PASSWORD);
  const deputyPage = await fetch(`${ORIGIN}/manage/office`, {
    headers: { cookie: deputyCookie },
  });
  ok(
    formFields(await deputyPage.text()).length === 0,
    "a deputy is not offered the form",
  );

  for (const [who, cookie] of [
    ["a deputy", deputyCookie],
    ["a league manager", await cookiesFor("manager@obhl.test", SEEDED_PASSWORD)],
    ["nobody at all", ""],
  ]) {
    const forged = `forged-by-${Math.random().toString(36).slice(2, 8)}`;
    const { res } = await submit(cookie, fields, target.email, forged);
    ok(
      !(await canSignIn(target.email, forged)),
      `${who} cannot set a password with a hand-made POST`,
      `status ${res.status}`,
    );
  }
  ok(
    await canSignIn(target.email, "brand-new-pw-01"),
    "…and the commissioner's password survived all three",
  );

  // --- peer-flat: a commissioner is not above another commissioner ---
  const peerAttempt = await submit(commissioner, fields, peer.email, "peer-takeover-01");
  ok(
    !(await canSignIn(peer.email, "peer-takeover-01")),
    "a commissioner cannot take over another commissioner",
    `status ${peerAttempt.res.status}`,
  );
  ok(
    await canSignIn(peer.email, peer.password),
    "…that account is untouched",
  );
  ok(peerAttempt.html.includes("peer-flat"), "…and the page says why");

  // --- but their own is the bootstrap ---
  await submit(commissioner, fields, actor.email, "self-bootstrap-01");
  ok(
    await canSignIn(actor.email, "self-bootstrap-01"),
    "a commissioner CAN set their own password — the bootstrap",
  );

  // --- refusals that need a reason, not silence ---
  const short = await submit(commissioner, fields, target.email, "short");
  ok(short.html.includes("at least 8 characters"), "a too-short password says so");
  const missing = await submit(commissioner, fields, "nobody-here@obhl.test", "long-enough-01");
  ok(missing.html.includes("No account for"), "an unknown address says so");

  // --- the audit entry, and what must not be in it ---
  const { data: entries } = await admin
    .from("audit_log")
    .select("action, entity_type, league_id, new_data")
    .eq("entity_type", "office")
    .eq("action", "set_password")
    .eq("entity_id", target.id);
  ok((entries ?? []).length === 1, "one set_password audit entry for the target");
  ok(
    entries?.[0]?.league_id === null,
    "…filed under a NULL league, as the office is instance-wide",
  );
  ok(
    !JSON.stringify(entries ?? []).includes("brand-new-pw-01"),
    "…and it does NOT carry the password",
  );
} finally {
  // ⛔ EVERY AUDIT ROW FIRST, FOR EVERY ACCOUNT, BEFORE ANY PROFILE IS DELETED.
  // The commissioner here is the ACTOR on the entries filed against the target,
  // so deleting accounts one at a time — its own entries, then its profile —
  // leaves the first account still referenced by the third's rows and its delete
  // fails. It failed silently the first time this ran: the loop printed "cleaned
  // up" for an account that was still there.
  const ids = created.map((c) => c.id);
  for (const column of ["entity_id", "user_id"]) {
    const { error } = await admin.from("audit_log").delete().in(column, ids);
    if (error) console.error(`audit_log by ${column}: ${error.message}`);
  }
  for (const { id, email } of created) {
    await admin.from("league_office").delete().eq("profile_id", id);
    const { error: profileError } = await admin.from("profiles").delete().eq("id", id);
    const { error: userError } = await admin.auth.admin.deleteUser(id);
    const problem = profileError?.message ?? userError?.message ?? null;
    // Loud. A cleanup that reports success having left an account behind is how
    // a probe quietly starts polluting the database it is meant to leave alone.
    if (problem) {
      failures++;
      console.error(`✗ FAILED TO CLEAN UP ${email}: ${problem}`);
    } else {
      console.log(`cleaned up ${email}`);
    }
  }
}

if (failures > 0) {
  console.error(`\nverify-office-password FAILED: ${failures} check(s) failed.`);
  process.exit(1);
}
console.log("\nverify-office-password done — all checks passed.");
