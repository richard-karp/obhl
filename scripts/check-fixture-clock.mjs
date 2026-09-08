// Prove the seeded fixture and the clock that judges it still agree.
//
//   node --env-file-if-exists=.env.local scripts/check-fixture-clock.mjs
//
// ⚠️ WHY THIS EXISTS. `scripts/shift-seed-clock.sh` moves the fixture into the
// future; nothing moves `now()` with it, because Postgres runs in a container
// and a container cannot have a wall clock of its own. Past a certain shift the
// Spring seasons stop reading as already-played and the whole suite fails —
// loudly, at a dozen unrelated assertions, for a reason that looks like a code
// regression and is not one. A session lost an afternoon to exactly that on
// 2026-09-07 with a nine-month substitution.
//
// So the clock-shifted job runs this BEFORE the suite. A failure here says "the
// shift is wrong", in one line, in ten seconds, instead of "the app is broken"
// in forty minutes of red Playwright output.
//
// ⛔ THE JUDGE IS THE DATABASE, NOT THIS FILE. `season_is_started` is the
// function the app's one-way door actually turns on, so it is called rather
// than reimplemented here. Reimplementing it would only prove this script
// agrees with itself.
import { createClient } from "@supabase/supabase-js";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL || "http://127.0.0.1:54321";
const secret = process.env.SUPABASE_SECRET_KEY;
if (!secret) {
  console.error(
    "check-fixture-clock: missing SUPABASE_SECRET_KEY (it lives in .env.local).",
  );
  process.exit(1);
}

const admin = createClient(url, secret, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const failures = [];
const notes = [];

function check(ok, message) {
  if (!ok) failures.push(message);
  return ok;
}

async function season(leagueSlug, name) {
  const { data: league, error: le } = await admin
    .from("leagues")
    .select("id")
    .eq("slug", leagueSlug)
    .single();
  if (le || !league) throw new Error(`no league '${leagueSlug}': ${le?.message}`);

  const { data, error } = await admin
    .from("seasons")
    .select("id, name, starts_on, ends_on")
    .eq("league_id", league.id)
    .eq("name", name)
    .single();
  if (error || !data) throw new Error(`no season '${name}' in '${leagueSlug}': ${error?.message}`);
  return data;
}

async function isStarted(seasonId) {
  const { data, error } = await admin.rpc("season_is_started", {
    p_season: seasonId,
  });
  if (error) throw new Error(`season_is_started failed: ${error.message}`);
  return data === true;
}

// The last published game in a season, and how much daylight is left between it
// and now. This is the number the 11-week ceiling is made of: when it goes
// negative the fixture has overshot the clock.
async function lastPublishedGame(seasonId) {
  const { data, error } = await admin
    .from("games")
    .select("scheduled_at")
    .eq("season_id", seasonId)
    .eq("is_draft", false)
    .not("scheduled_at", "is", null)
    .order("scheduled_at", { ascending: false })
    .limit(1);
  if (error) throw new Error(`games read failed: ${error.message}`);
  return data?.[0]?.scheduled_at ?? null;
}

const DAY = 86_400_000;

try {
  const now = Date.now();

  const springs = [
    ["obhl", "Spring 2026"],
    ["harbor", "Spring 2026"],
  ];

  for (const [slug, name] of springs) {
    const s = await season(slug, name);
    const started = await isStarted(s.id);
    const last = await lastPublishedGame(s.id);
    const marginDays = last ? (now - new Date(last).getTime()) / DAY : null;

    notes.push(
      `${slug}/${name}: starts_on=${s.starts_on} last_game=${last ?? "none"} ` +
        `margin=${marginDays === null ? "n/a" : marginDays.toFixed(1)}d started=${started}`,
    );

    check(
      started,
      `${slug}/${name} reads as NOT started. The shift has pushed a played ` +
        `season past the clock — season_is_started() now disagrees with the ` +
        `fixture, and the suite would fail for that rather than for any defect. ` +
        `Reduce the shift (ceiling is 11 weeks; see supabase/seed.sql).`,
    );
    check(
      last !== null,
      `${slug}/${name} has no published games at all — the seed did not run as expected.`,
    );
    check(
      marginDays === null || marginDays > 0,
      `${slug}/${name}'s last game is ${marginDays?.toFixed(1)}d in the FUTURE. ` +
        `Same cause as above: the shift overshot.`,
    );
  }

  const fall = await season("obhl", "Fall 2026");
  const fallStarted = await isStarted(fall.id);
  const fallDaysOut = (new Date(`${fall.starts_on}T00:00:00Z`).getTime() - now) / DAY;

  notes.push(
    `obhl/Fall 2026: starts_on=${fall.starts_on} (${fallDaysOut.toFixed(1)}d out) started=${fallStarted}`,
  );

  check(
    !fallStarted,
    `obhl/Fall 2026 reads as STARTED. The schedule builder only exists on an ` +
      `un-started season, so every generate/publish spec would fail. The Fall ` +
      `season is seeded with no games, so this should be impossible from a ` +
      `shift alone — look for a spec that published into it and did not clean up.`,
  );
  check(
    fallDaysOut > 0,
    `obhl/Fall 2026 starts in the PAST (${fallDaysOut.toFixed(1)}d). The ` +
      `builder's own past-date guard would refuse to generate.`,
  );

  console.log("check-fixture-clock: fixture as seeded ---");
  for (const n of notes) console.log(`  ${n}`);

  if (failures.length) {
    console.error("\ncheck-fixture-clock: FIXTURE AND CLOCK DISAGREE\n");
    for (const f of failures) console.error(`  ✗ ${f}\n`);
    console.error(
      "Nothing below this point would be a trustworthy test result. The suite\n" +
        "was not run.",
    );
    process.exit(1);
  }

  console.log(
    "check-fixture-clock: OK — every played season is in the past, the Fall " +
      "season is unstarted and ahead of the clock.",
  );
} catch (err) {
  console.error(`check-fixture-clock: ${err.message}`);
  process.exit(1);
}
