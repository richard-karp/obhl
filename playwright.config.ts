import { defineConfig, devices } from "@playwright/test";
import { config } from "dotenv";

config({ path: ".env.local" });

// Each worktree exports its own PORT: `reuseExistingServer` takes whatever server is listening, so a
// shared port silently tests another branch's code. Passed to `next dev -p` so URL and server agree.
const PORT = process.env.PORT ?? "3000";

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  workers: 1,
  // One retry on CI, none locally. ⚠️ A retry is not a clean re-run: the database is seeded once per
  // run, so a `flaky` test that failed mid-mutation is worth opening, not filing away.
  retries: process.env.CI ? 1 : 0,
  reporter: "list",
  // Above the generator's 5 s `OBHL_SLOT_BUDGET_MS`, which is Playwright's default, and well below
  // `timeout`, or a failing assertion reports as "Test timeout exceeded" instead of its locator.
  expect: { timeout: 15_000 },

  // Per-test budget. Above the assertion timeout so a single failed assertion
  // reports as itself and still leaves room for the rest of the test.
  timeout: 60_000,

  use: {
    baseURL: `http://localhost:${PORT}`,
    // Per-action budget: without it an action that can never resolve burns the whole test budget.
    // Above `expect`'s 15s, well below the 60s test budget, so the action fails by name.
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
    // ⛔ THE CRON SECRET LIVES HERE, not in CI's `.env.local`: the route fails closed, so `Closing the
    // night` in `05-scoring-night` would get a 401. ⚠️ A reused server started before this lacks it.
    env: { CRON_SECRET: process.env.CRON_SECRET ?? "e2e-cron-secret" },
    reuseExistingServer: true,
    // Generous because CI starts cold: ~9s locally with no `.next` cache, several times that on a
    // 2-core runner. It costs nothing unless the server never comes up.
    timeout: 120_000,
  },
  globalSetup: "./e2e/global-setup.ts",
});
