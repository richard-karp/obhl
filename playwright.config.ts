import { defineConfig, devices } from "@playwright/test";
import { config } from "dotenv";

config({ path: ".env.local" });

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: "list",
  // An assertion must outlast the work it waits on. The schedule generator is
  // wall-clock budgeted at OBHL_SLOT_BUDGET_MS — default 5_000, see
  // src/lib/schedule/assignNights.ts — which is *exactly* Playwright's own
  // default assertion timeout, so waiting for the draft preview had no headroom
  // for the round trip and render and passed only where the search happened to
  // converge early. CI lost that race. Keep this comfortably above the
  // generator's budget; it is not a licence for slow assertions elsewhere, and
  // it costs nothing except on a genuine failure.
  expect: { timeout: 30_000 },

  use: {
    baseURL: "http://localhost:3000",
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
    command: "npm run dev",
    url: "http://localhost:3000",
    reuseExistingServer: true,
    // Generous because CI starts cold. Locally this is ~9s with no `.next`
    // cache, and every local run either reuses a server or has a warm one; a
    // 2-core CI runner is several times slower and was landing near the old
    // 30s limit. The timeout only costs anything when the server never comes up.
    timeout: 120_000,
  },
  globalSetup: "./e2e/global-setup.ts",
});
