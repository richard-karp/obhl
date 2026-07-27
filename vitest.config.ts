import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    // The schedule generator gives its ice-time search a multi-second budget in
    // production, which would put the suite in double figures. Tests assert the
    // balance the search reaches quickly (an even slot share); grinding out the
    // last few back-to-back repeats isn't what they're checking.
    env: {
      OBHL_SLOT_BUDGET_MS: "400",
      OBHL_SLOT_RESTARTS: "2000",
    },
  },
});
