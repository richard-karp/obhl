import { defineConfig, devices } from "@playwright/test";
import { config } from "dotenv";

config({ path: ".env.local" });

// Parallel worktrees, each on its own port. `reuseExistingServer` below takes
// whatever dev server is already listening, so two branches sharing 3000 means
// one branch's suite silently drives the other branch's code — nine phantom
// failures on 2026-09-04, all of them real code that was never running.
// Export a distinct PORT per worktree and this is the only place that needs to
// know. `next dev -p` is passed explicitly rather than relying on Next reading
// PORT itself, so the URL below and the server can never disagree.
//
// dotenv does not override an already-exported variable, so an exported PORT
// wins over anything in .env.local.
const PORT = process.env.PORT ?? "3000";

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  workers: 1,
  // One retry on CI, none locally, and the asymmetry is deliberate.
  //
  // This suite drives a full stack — Postgres, Kong, PostgREST and a `next dev`
  // server, all on a two-core runner — and infrastructure that big produces
  // transients no assertion can be written against. The one that turned `main`
  // red was a gateway 502 on a read; `getPublishState` now retries that read
  // itself, but nothing here claims it is the only such blip the stack can
  // produce. A single one should not discard eleven green minutes.
  //
  // ⚠️ A RETRY DOES NOT HIDE A FLAKE. The `list` reporter prints a test that
  // needed a second attempt as `flaky`, and the job still reports it, so a test
  // that starts flapping is visible in the log rather than silently absorbed.
  // What changes is only whether it fails the build.
  //
  // Locally it stays 0: a flake in front of the person who just wrote the code
  // is information, and re-running it costs them minutes on a suite that is
  // single-worker by design.
  //
  // This is also what makes `trace: "on-first-retry"` below mean anything —
  // with no retries it could never fire, and a CI failure arrived with a
  // screenshot and no trace.
  retries: process.env.CI ? 1 : 0,
  reporter: "list",
  // An assertion must outlast the work it waits on. The schedule generator is
  // wall-clock budgeted at OBHL_SLOT_BUDGET_MS — default 5_000, see
  // src/lib/schedule/assignNights.ts — which is *exactly* Playwright's own
  // default assertion timeout, so waiting for the draft preview had no headroom
  // for the round trip and render and passed only where the search happened to
  // converge early. CI lost that race. Keep this comfortably above the
  // generator's budget; it is not a licence for slow assertions elsewhere, and
  // it costs nothing except on a genuine failure.
  //
  // Keep this WELL BELOW `timeout` below. Setting the two equal (30s/30s, as a
  // first attempt did) means a failing assertion consumes the whole test budget,
  // so Playwright reports "Test timeout exceeded" instead of naming the locator
  // that failed — and the assertion never gets its full window either.
  expect: { timeout: 15_000 },

  // Per-test budget. Above the assertion timeout so a single failed assertion
  // reports as itself and still leaves room for the rest of the test.
  timeout: 60_000,

  use: {
    baseURL: `http://localhost:${PORT}`,
    // Per-action budget for `fill`, `click`, `check` and friends. Without it
    // an action falls back to the whole test budget, so one that can never
    // resolve — a locator on an element the page never renders, say — burns
    // every remaining second and reports only `waiting for <locator>`, naming
    // what it waited on and nothing about why. Above `expect`'s 15s so a slow
    // page still settles, and well below the 60s test budget so the action is
    // what fails, by name, with time left to report it.
    actionTimeout: 20_000,
    trace: "on-first-retry",
    screenshot: "only-on-failure",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
  webServer: {
    command: `npm run dev -- -p ${PORT}`,
    url: `http://localhost:${PORT}`,
    reuseExistingServer: true,
    // Generous because CI starts cold. Locally this is ~9s with no `.next`
    // cache, and every local run either reuses a server or has a warm one; a
    // 2-core CI runner is several times slower and was landing near the old
    // 30s limit. The timeout only costs anything when the server never comes up.
    timeout: 120_000,
  },
  globalSetup: "./e2e/global-setup.ts",
});
