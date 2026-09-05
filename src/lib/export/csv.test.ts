import { describe, it, expect } from "vitest";
import { buildScheduleCsv, type CsvGame } from "./csv";

const BOM = "﻿";
const HEADER = "Date,Time,Home,Away";

const g = (
  scheduled_at: string | null,
  home: string,
  away: string,
): CsvGame => ({
  scheduled_at,
  home,
  away,
});

/** The data rows, with the BOM, header and trailing newline stripped off. */
function rows(csv: string): string[] {
  return csv.slice(BOM.length).split("\r\n").slice(1, -1);
}

describe("buildScheduleCsv", () => {
  it("emits only a header for an empty season", () => {
    expect(buildScheduleCsv([])).toBe(`${BOM}${HEADER}\r\n`);
  });

  it("formats a game's date and time in the league zone", () => {
    // 8pm on a September Monday, written with the EDT offset it is stored in.
    const csv = buildScheduleCsv([
      g("2026-09-14T20:00:00-04:00", "Ice Hawks", "Rivermen"),
    ]);
    expect(rows(csv)).toEqual(["2026-09-14,8:00 PM,Ice Hawks,Rivermen"]);
  });

  it("keeps an undated game as a row with empty date and time cells", () => {
    // The .ics builder drops these; a schedule someone is about to print
    // shouldn't silently lose a fixture just because it has no date yet.
    const csv = buildScheduleCsv([g(null, "Northstars", "Ice Hawks")]);
    expect(rows(csv)).toEqual([",,Northstars,Ice Hawks"]);
  });

  it("quotes a team name containing a comma", () => {
    // Unquoted, this would shift every following column one to the right.
    const csv = buildScheduleCsv([
      g("2026-09-14T20:00:00-04:00", "Steelheads, Jr.", "Rivermen"),
    ]);
    expect(rows(csv)).toEqual([
      '2026-09-14,8:00 PM,"Steelheads, Jr.",Rivermen',
    ]);
  });

  it("doubles a double quote inside a team name and wraps the field", () => {
    const csv = buildScheduleCsv([
      g("2026-09-14T20:00:00-04:00", 'Rink "A" Squad', "Rivermen"),
    ]);
    expect(rows(csv)).toEqual([
      '2026-09-14,8:00 PM,"Rink ""A"" Squad",Rivermen',
    ]);
  });

  it("quotes a team name containing a newline", () => {
    const csv = buildScheduleCsv([
      g("2026-09-14T20:00:00-04:00", "Ice\nHawks", "Rivermen"),
    ]);
    // Asserted whole: the wrapped newline must stay inside one record rather
    // than splitting the row in two.
    expect(csv).toBe(
      `${BOM}${HEADER}\r\n2026-09-14,8:00 PM,"Ice\nHawks",Rivermen\r\n`,
    );
  });

  // Excel and Sheets evaluate a cell that opens with one of these. Quoting does
  // not prevent it — CSV quotes are stripped before the value is interpreted —
  // and team names can arrive from scraped import data, so they are untrusted.
  it.each(["=", "+", "-", "@", "\t"])(
    "marks a team name beginning with %j as literal text",
    (lead) => {
      const csv = buildScheduleCsv([
        g("2026-09-14T20:00:00-04:00", `${lead}SUM(A1)`, "Rivermen"),
      ]);
      expect(rows(csv)).toEqual([
        `2026-09-14,8:00 PM,'${lead}SUM(A1),Rivermen`,
      ]);
    },
  );

  it("marks a carriage-return-led name and still quotes it", () => {
    const csv = buildScheduleCsv([
      g("2026-09-14T20:00:00-04:00", "\rRivermen", "Tide"),
    ]);
    expect(rows(csv)).toEqual(['2026-09-14,8:00 PM,"\'\rRivermen",Tide']);
  });

  it("keeps the literal-text marker inside the quotes when both apply", () => {
    const csv = buildScheduleCsv([
      g(
        "2026-09-14T20:00:00-04:00",
        '=HYPERLINK("http://evil.example","Standings")',
        "Rivermen",
      ),
    ]);
    // The marker has to be part of the cell value, so it goes inside the
    // quoting, not before it.
    expect(rows(csv)).toEqual([
      `2026-09-14,8:00 PM,"'=HYPERLINK(""http://evil.example"",""Standings"")",Rivermen`,
    ]);
  });

  it("separates records with CRLF and ends with one", () => {
    const csv = buildScheduleCsv([
      g("2026-09-14T20:00:00-04:00", "Ice Hawks", "Rivermen"),
      g("2026-09-21T20:00:00-04:00", "Rivermen", "Steelheads"),
    ]);
    expect(csv.endsWith("\r\n")).toBe(true);
    expect(csv.slice(BOM.length).split("\r\n")).toEqual([
      HEADER,
      "2026-09-14,8:00 PM,Ice Hawks,Rivermen",
      "2026-09-21,8:00 PM,Rivermen,Steelheads",
      "",
    ]);
  });

  it("reports the league-local date for a game stored on the next UTC day", () => {
    // 8:30pm EDT on the 14th is 00:30 UTC on the 15th.
    const csv = buildScheduleCsv([
      g("2026-09-15T00:30:00Z", "Ice Hawks", "Rivermen"),
    ]);
    expect(rows(csv)).toEqual(["2026-09-14,8:30 PM,Ice Hawks,Rivermen"]);
  });

  it("holds the wall-clock time across the EST/EDT boundary", () => {
    // Both are 8pm league time: January is UTC-5, July is UTC-4.
    const csv = buildScheduleCsv([
      g("2026-01-15T01:00:00Z", "Ice Hawks", "Rivermen"),
      g("2026-07-15T00:00:00Z", "Rivermen", "Steelheads"),
    ]);
    expect(rows(csv)).toEqual([
      "2026-01-14,8:00 PM,Ice Hawks,Rivermen",
      "2026-07-14,8:00 PM,Rivermen,Steelheads",
    ]);
  });
});
