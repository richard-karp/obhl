import { describe, it, expect } from "vitest";
import { safeNextPath } from "./safe-next-path";

const FALLBACK = "/fallback";

describe("safeNextPath", () => {
  it("keeps a same-origin path and its query", () => {
    expect(safeNextPath("/obhl/schedule?view=results", FALLBACK)).toBe(
      "/obhl/schedule?view=results",
    );
  });

  it("returns what the parser made of the path, not the raw string", () => {
    expect(safeNextPath("/a/../b", FALLBACK)).toBe("/b");
    expect(safeNextPath("/obhl#section", FALLBACK)).toBe("/obhl");
  });

  it.each([
    ["a protocol-relative URL", "//evil.com"],
    ["a backslash the parser folds into a slash", "/\\evil.com"],
    ["a tab the parser strips before parsing", "/\t\\evil.com"],
    ["a newline the parser strips before parsing", "/\n/evil.com"],
    ["an absolute URL", "https://evil.com"],
    ["an empty string", ""],
    ["a dot-segment that collapses to a protocol-relative path", "/.//evil.com"],
    ["an encoded dot-segment that collapses the same way", "/%2e//evil.com"],
  ])("falls back on %s", (_label, raw) => {
    expect(safeNextPath(raw, FALLBACK)).toBe(FALLBACK);
  });

  it("falls back when there is no value at all", () => {
    expect(safeNextPath(null, FALLBACK)).toBe(FALLBACK);
    expect(safeNextPath(undefined, FALLBACK)).toBe(FALLBACK);
  });
});
