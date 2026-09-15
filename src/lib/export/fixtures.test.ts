import { describe, it, expect } from "vitest";
import { isExportableFixture } from "./fixtures";
import type { GameWithTeams } from "@/lib/queries/schedule";

type Status = GameWithTeams["status"];

// Typed, so a renamed status breaks this at compile time. Postponed exports as undated,
// because postponing clears the date.
const EXPORTED: Status[] = ["scheduled", "in_progress", "final", "postponed"];
const WITHHELD: Status[] = ["cancelled"];

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
