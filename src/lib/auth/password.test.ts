import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { MIN_PASSWORD, passwordProblem } from "./password";

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

  // A second literal floor would let the two password writers disagree.
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
