// Verifies the nightly sweep actually closes a game — against a real server and
// a real database, with a control.
//
// ⛔ THIS EXISTS BECAUSE A STUBBED TEST COULD NOT HAVE CAUGHT THE BUG IT GUARDS.
// The first version of `/api/cron/close-night` called `finalizeGameById` without
// a client, so every statement ran as `anon`. The result was not an error — it
// was three silent wrongs at once:
//
//   * the games UPDATE matched ZERO rows and returned no error (an RLS-refused
//     UPDATE is not an error), so the route reported success;
//   * `logAudit` writes on the admin client regardless, so the audit log gained
//     a `finalize_game` entry for a game that was never finalized;
//   * the `game_rosters` read is gated to FINAL games for public roles, so the
//     score would have been recomputed from an empty roster and written 0-0.
//
// Unit tests pass a fake client, so they assert the shape of the call and are
// blind to WHICH client it is. Only a real request against real RLS tells you.
//
// Run: node --env-file-if-exists=.env.local scripts/verify-close-night.mjs
import { createClient } from "@supabase/supabase-js";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL || "http://127.0.0.1:54321";
const secret = process.env.SUPABASE_SECRET_KEY;
const site = process.env.VERIFY_SITE_URL || "http://localhost:3211";
const cronSecret = process.env.CRON_SECRET || "local-dev-cron-secret";
if (!secret) {
  console.error("Missing SUPABASE_SECRET_KEY (it's in .env.local).");
  process.exit(1);
}
const admin = createClient(url, secret, { auth: { persistSession: false } });

const fail = (msg) => {
  console.error(`FAIL: ${msg}`);
  process.exit(1);
};

// A game from a PAST night, put into the state the sweep is meant to rescue:
// in_progress with a real score on the roster.
const { data: game } = await admin
  .from("games")
  .select("id, season_id, home_team_id, status, scheduled_at")
  .lt("scheduled_at", new Date(Date.now() - 36e5 * 48).toISOString())
  .eq("is_draft", false)
  .limit(1)
  .single();
if (!game) fail("no past game to work with — reseed");

const before = { status: game.status, goals: 0 };
await admin.from("games").update({ status: "in_progress" }).eq("id", game.id);

// Give it a score the sweep must PRESERVE. If the roster read runs unprivileged
// it comes back empty and the score lands 0-0 — which is what this catches.
const { data: roster } = await admin
  .from("game_rosters")
  .select("id, team_id, goals")
  .eq("game_id", game.id)
  .eq("team_id", game.home_team_id);
if (!roster?.length) fail("game has no roster rows — pick another fixture");
before.goals = roster[0].goals ?? 0;
await admin.from("game_rosters").update({ goals: 3 }).eq("id", roster[0].id);

// ⚠️ THE EXPECTED SCORE IS THE SUM OF THE ROSTER, NOT A MAGIC NUMBER. An earlier
// version asserted `3` — the value it had just written to ONE row — and failed
// against a fixture whose other players already had goals. The number to check
// is whatever `finalizeGameById` should compute, which is the sum.
const expected = roster.reduce(
  (n, r) => n + (r.id === roster[0].id ? 3 : (r.goals ?? 0)),
  0,
);

// ── The control: no secret must be refused, and must change nothing. ────────
const unauth = await fetch(`${site}/api/cron/close-night`);
if (unauth.status !== 401)
  fail(`unauthenticated call returned ${unauth.status}, expected 401`);
const { data: untouched } = await admin
  .from("games")
  .select("status")
  .eq("id", game.id)
  .single();
if (untouched.status !== "in_progress") fail("a 401 still changed the game");
console.log("✓ control: unauthenticated request refused and changed nothing");

// ── The real thing. ────────────────────────────────────────────────────────
const res = await fetch(`${site}/api/cron/close-night`, {
  headers: { authorization: `Bearer ${cronSecret}` },
});
if (!res.ok) fail(`cron returned ${res.status}`);
const body = await res.json();

const { data: after } = await admin
  .from("games")
  .select("status, home_goals, finalized_at")
  .eq("id", game.id)
  .single();

if (after.status !== "final") {
  fail(
    `game still ${after.status} after the sweep reported ${JSON.stringify(body)} — ` +
      "this is the anon-client bug: the UPDATE matched no rows and reported success",
  );
}
if (after.home_goals !== expected) {
  fail(
    `score written as ${after.home_goals}, expected ${expected} — a 0 means the ` +
      "roster read came back empty, which means it ran unprivileged",
  );
}
console.log(
  `✓ swept: status=final, home_goals=${after.home_goals}, ${JSON.stringify(body)}`,
);

// The audit entry must name no actor: a sweep is not a person.
//
// ⚠️ Retried, not slept on. The first version queried immediately and failed —
// the entry landed ~200ms after the route returned, because `finalizeGameById`
// used to `void` the write. It is awaited now, so this should pass first time;
// the retry stays so a slow machine reports a MISSING entry rather than a flake.
let entry = null;
for (let i = 0; i < 10 && !entry; i++) {
  const { data } = await admin
    .from("audit_log")
    .select("user_id, action")
    .eq("entity_id", game.id)
    .eq("action", "finalize_game")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  entry = data;
  if (!entry) await new Promise((r) => setTimeout(r, 200));
}
if (!entry) fail("no finalize_game audit entry after 2s");
if (entry.user_id !== null)
  fail(`audit actor is ${entry.user_id}, expected null`);
console.log("✓ audit entry filed with a null actor");

// ⛔ RESTORE EVERYTHING IT TOUCHED, INCLUDING THE GOALS. An earlier version put
// the status back and left `goals = 3` on a roster row — in a database the e2e
// suite also uses. A script that dirties a shared fixture produces failures in
// specs that never went near it, which is exactly the kind of confusion that
// costs a debugging session.
await admin.from("games").update({ status: before.status }).eq("id", game.id);
await admin
  .from("game_rosters")
  .update({ goals: before.goals })
  .eq("id", roster[0].id);
console.log("✓ fixture restored (status and goals)");
