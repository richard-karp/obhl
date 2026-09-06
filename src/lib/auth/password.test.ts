import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { MIN_PASSWORD, passwordProblem } from "./password";

/**
 * The password floor, in one place.
 *
 * Two doors set a password now — a commissioner via `setStaffPassword`
 * (`office.ts`, admin API) and the account holder via the self-serve reset
 * (`auth.ts:updateOwnPassword`, Supabase Auth). Both check this number BEFORE
 * Supabase is called, so Supabase's own floor never decides which one applies.
 * That matters because production's Supabase floor is set in the dashboard and
 * is recorded nowhere in this repository, and `supabase/config.toml`'s
 * `minimum_password_length = 6` is the stock scaffold default governing the
 * LOCAL stack only. One number here means the two doors cannot disagree even
 * if the dashboard is never touched.
 */
describe("password policy", () => {
  it("is 8, not Supabase's 6", () => {
    expect(MIN_PASSWORD).toBe(8);
  });

  it("refuses anything shorter, and says the number", () => {
    expect(passwordProblem("")).toContain("8");
    expect(passwordProblem("hockey1")).toContain("8");
  });

  it("accepts the floor itself", () => {
    expect(passwordProblem("hockey12")).toBeNull();
    expect(passwordProblem("a much longer passphrase")).toBeNull();
  });

  /**
   * The point of the module. A second literal floor anywhere is the failure
   * this exists to prevent, so it is asserted rather than trusted.
   */
  it("is the only floor the password writers carry", () => {
    const withOwnFloor = ["actions/office.ts", "actions/auth.ts"].filter(
      (rel) => {
        const src = readFileSync(join(process.cwd(), "src/lib", rel), "utf8");
        return /const MIN_PASSWORD\s*=/.test(src);
      },
    );
    expect(withOwnFloor).toEqual([]);
  });
});
