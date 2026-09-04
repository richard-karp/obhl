import { describe, it, expect } from "vitest";
import { slugify } from "./slug";

describe("slugify", () => {
  it("lowercases and hyphenates", () => {
    expect(slugify("Harbor Rec Hockey League")).toBe("harbor-rec-hockey-league");
  });
  it("collapses punctuation runs to a single separator", () => {
    expect(slugify("St. John's Ducks!")).toBe("st-john-s-ducks");
  });
  it("returns empty string when nothing survives", () => {
    expect(slugify("!!!")).toBe("");
  });
});
