import { describe, it, expect } from "vitest";
import { isUuid } from "./uuid";

describe("isUuid", () => {
  it("accepts a canonical uuid in either case", () => {
    expect(isUuid("d5a31a6a-5c70-4ae0-88e6-61a5bace779d")).toBe(true);
    expect(isUuid("D5A31A6A-5C70-4AE0-88E6-61A5BACE779D")).toBe(true);
  });

  it.each([
    ["empty", ""],
    ["not hex", "zzzzzzzz-5c70-4ae0-88e6-61a5bace779d"],
    ["wrong grouping", "d5a31a6a5c704ae088e661a5bace779d"],
    ["too short", "d5a31a6a-5c70-4ae0-88e6-61a5bace779"],
  ])("rejects %s", (_label, value) => {
    expect(isUuid(value)).toBe(false);
  });

  it("rejects an id carrying extra PostgREST filter syntax", () => {
    // The reason this exists: these ids are interpolated into .or() filters.
    expect(isUuid("d5a31a6a-5c70-4ae0-88e6-61a5bace779d,is_draft.eq.true")).toBe(
      false,
    );
  });
});
