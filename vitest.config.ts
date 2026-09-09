import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
      // `server-only` is not an installed package — Next resolves it itself, and
      // it exists to fail a BUILD when a server module is pulled into a client
      // component. Vitest has neither, so without this alias any module carrying
      // the marker throws `Cannot find package 'server-only'` at import and
      // cannot be unit-tested at all. See `test/server-only-stub.ts`.
      "server-only": fileURLToPath(
        new URL("./test/server-only-stub.ts", import.meta.url),
      ),
    },
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    // Phase S is measured at the budget production actually uses. A shorter
    // budget here once hid a real defect: the one-off repair could return a plan
    // worse than leaving the season alone, and the test only passed because the
    // fixture it built was a 400 ms season.
    //
    // ⛔ DO NOT ADD `OBHL_SLOT_RESTARTS` BACK. It was pinned to 2000 here while
    // `assignNights.ts` defaulted to 20000, and the two ice-time clustering
    // tests pass at 2000 and fail at 20000 ("expected 13 to be less than or
    // equal to 6"). Every quality bound in the schedule suite was a claim about
    // a search production did not run, and the feature PR #62 shipped reached
    // the league as 14 -> 13 rather than 14 -> 4. The restart count now lives in
    // exactly one place: `SLOT_RESTARTS` in `assignNights.ts`, where it is
    // documented against the sweep that chose it.
    // `assignNights.test.ts` asserts this variable is unset.
    //
    // A test config may raise a TIMEOUT — see `testTimeout` below. It may not
    // override a constant that shapes the search. `OBHL_SLOT_BUDGET_MS` stays
    // because it is set to the production default, so it documents rather than
    // diverges.
    env: {
      OBHL_SLOT_BUDGET_MS: process.env.OBHL_SLOT_BUDGET_MS ?? "5000",
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
