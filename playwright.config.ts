import { defineConfig, devices } from "@playwright/test";
import { config } from "dotenv";

config({ path: ".env.local" });

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: "list",
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
