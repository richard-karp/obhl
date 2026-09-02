import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    // Phase S is measured at the budget production actually uses. A shorter
    // budget here once hid a real defect: the one-off repair could return a plan
    // worse than leaving the season alone, and the test only passed because the
    // fixture it built was a 400 ms season.
    //
    // Overridable from the environment so slower hardware (CI) has a lever if
    // it cannot reach the quality bounds within the budget. The defaults are
    // unchanged and are what runs locally — raise the variable, never lower the
    // assertions, or the bounds stop meaning anything.
    env: {
      OBHL_SLOT_BUDGET_MS: process.env.OBHL_SLOT_BUDGET_MS ?? "5000",
      OBHL_SLOT_RESTARTS: process.env.OBHL_SLOT_RESTARTS ?? "2000",
    },
  },
});
