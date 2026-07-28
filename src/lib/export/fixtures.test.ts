import { describe, it, expect } from "vitest";
import { isExportableFixture } from "./fixtures";
import type { GameWithTeams } from "@/lib/queries/schedule";

type Status = GameWithTeams["status"];

// Typed rather than bare strings, so a status renamed in the enum breaks this
// test at compile time instead of quietly testing a value that no longer exists.
const EXPORTED: Status[] = ["scheduled", "in_progress", "final"];
const WITHHELD: Status[] = ["cancelled", "postponed"];

describe("isExportableFixture", () => {
  // These occupy or occupied their slot, so their date is true.
  it.each(EXPORTED)("exports a %s game", (s) => {
    expect(isExportableFixture(s)).toBe(true);
  });

  // These keep their original scheduled_at, so exporting them would assert a
  // game happens on a date it does not.
  it.each(WITHHELD)("withholds a %s game", (s) => {
    expect(isExportableFixture(s)).toBe(false);
  });
});
