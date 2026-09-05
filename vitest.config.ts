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
    // ⛔ RAISED BECAUSE THE DEFAULT COLLIDES WITH THE SEARCH ABOVE. Vitest
    // defaults to 5000 ms per test, and a single `assignNights` runs Phase S
    // five times (`SLOT_CANDIDATES`), each bounded by `OBHL_SLOT_RESTARTS`
    // restarts OR `OBHL_SLOT_BUDGET_MS`, whichever ends first. On this hardware
    // that is ~1.9 s per generation and it is RESTART-bound, not budget-bound:
    // dropping restarts 2000 → 200 takes the schedule suite from 3.66 s to
    // 733 ms, while doubling the budget to 10000 moves it not at all (3.67 s).
    //
    // Which is exactly why a slower runner fails where this machine passes —
    // each restart costs more there, and nothing in the config caps the count.
    // Two tests went red on CI while green here for that reason. Thirty seconds
    // is generous against a ~2 s generation and still catches a genuine hang.
    //
    // Fix the timeout, not the tests: `spacing.test.ts` already reached for a
    // per-test `30_000`, and there are 46 generator calls inside `it()` bodies
    // across seven files. Moving work into `describe()` bodies to dodge the
    // timeout costs real things — a throw there fails the whole FILE with
    // "Tests no tests", and the work runs even under `-t` filtering or `.skip`.
    testTimeout: 30_000,
  },
});
