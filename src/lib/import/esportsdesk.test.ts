import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchEsportsdeskLeague } from "@/lib/import/esportsdesk";

/**
 * The cell layout of a live rosters.cfm page. Its nav and legend rows are real, name-shaped cells,
 * which is why the jersey column must anchor a player row even when the number is missing.
 */

const NAV_ROW =
  "<tr><td>Statistics</td><td>Schedule</td><td>Roster</td>" +
  "<td>Head-To-Head</td><td>Graphs</td><td>Personnel</td></tr>";
const LEGEND_ROW =
  "<tr><td>Injured</td><td>Suspended</td><td>Rookie</td><td>Reserve</td>" +
  "<td>Import</td><td>Affiliate</td><td>Committed</td></tr>";

/** One roster row: flag cell, jersey cell, name, then the six stat columns. */
const row = (flag: string, jersey: string, name: string, pos = "-") =>
  `<tr><td>${flag}</td><td>${jersey}</td><td>${name}</td><td>${pos}</td>` +
  "<td>-</td><td>-</td><td>-</td><td>-</td><td>-</td></tr>";

const rosterPage = (rows: string) =>
  `<html><body><table><tr><td><table>
     ${NAV_ROW}
     ${rows}
     ${LEGEND_ROW}
   </table></td></tr></table>
   <p>Black  19w-10l-8t</p></body></html>`;

const teamsPage =
  '<html><head><title>Test League - Powered By esportsdesk.com</title></head>' +
  '<body><a href="rosters.cfm?clientID=1&leagueID=2&teamID=99">Black</a>' +
  "</body></html>";

function stubFetch(rows: string) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => ({
      ok: true,
      status: 200,
      text: async () =>
        String(url).includes("teams.cfm") ? teamsPage : rosterPage(rows),
    })),
  );
}

const parseRoster = async (rows: string) => {
  stubFetch(rows);
  const league = await fetchEsportsdeskLeague("1", "2");
  expect(league.teams).toHaveLength(1);
  return league.teams[0].players;
};

afterEach(() => vi.unstubAllGlobals());

describe("esportsdesk roster parsing", () => {
  it("reads number, name, captain and position from a numbered roster", async () => {
    const players = await parseRoster(
      row("", "4", "Jake Meltzer") +
        row("C", "14", "Conrado Hupe Vaz") +
        row("", "31", "Pat Roy", "G"),
    );
    expect(players).toEqual([
      {
        number: 4,
        firstName: "Jake",
        lastName: "Meltzer",
        isCaptain: false,
        position: "F",
      },
      {
        number: 14,
        firstName: "Conrado",
        lastName: "Hupe Vaz",
        isCaptain: true,
        position: "F",
      },
      {
        number: 31,
        firstName: "Pat",
        lastName: "Roy",
        isCaptain: false,
        position: "G",
      },
    ]);
  });

  // The live page renders an unnumbered player's jersey as "-"; requiring digits
  // there drops those players without reporting anything.
  it("keeps unnumbered players in a partly numbered roster", async () => {
    const players = await parseRoster(
      row("", "4", "Jake Meltzer") +
        row("", "-", "Brennan Dumas") +
        row("", "91", "Mike Ballard"),
    );
    expect(players.map((p) => [p.number, p.lastName])).toEqual([
      [4, "Meltzer"],
      [null, "Dumas"],
      [91, "Ballard"],
    ]);
  });

  // A league that assigns no numbers at all: the teams still parse, so a lost roster
  // would look like a successful import.
  it("imports a roster where no player has a number", async () => {
    const players = await parseRoster(
      row("", "-", "Jake Meltzer") +
        row("C", "-", "Conrado Hupe Vaz") +
        row("", "-", "Pat Roy", "G"),
    );
    expect(players).toHaveLength(3);
    expect(players.every((p) => p.number === null)).toBe(true);
    expect(players.map((p) => p.firstName)).toEqual([
      "Jake",
      "Conrado",
      "Pat",
    ]);
    // Everything but the number still has to survive.
    expect(players[1].isCaptain).toBe(true);
    expect(players[2].position).toBe("G");
  });

  // Some leagues leave the cell empty rather than drawing a dash.
  it("imports a roster whose jersey cells are empty", async () => {
    const players = await parseRoster(
      row("", "", "Jake Meltzer") + row("", "", "Brennan Dumas"),
    );
    expect(players.map((p) => [p.number, p.lastName])).toEqual([
      [null, "Meltzer"],
      [null, "Dumas"],
    ]);
  });

  // Shapes a name-shaped cell alone would admit, the first two verbatim from every rosters.cfm
  // page: an empty jersey cell is legal, so only the stat column after the name rules them out.
  it.each([
    ["a two-cell row, empty cell then a short word", "<td></td><td>Roster</td>"],
    ["a two-cell row holding a nav label", "<td></td><td>Standings</td>"],
    // Cell text is whitespace-collapsed, so a multi-line legend cell becomes a
    // single name-shaped string.
    [
      "a multi-line legend cell",
      "<td></td><td>Injured\nSuspended</td>",
    ],
    ["a heading pair", "<td>&nbsp;</td><td>Team Roster</td>"],
  ])("invents no player from %s", async (_label, cells) => {
    expect(await parseRoster(`<tr>${cells}</tr>`)).toEqual([]);
  });

  it("does not mistake the nav or legend rows for players", async () => {
    const players = await parseRoster(row("", "4", "Jake Meltzer"));
    expect(players).toHaveLength(1);
    const names = players.map((p) => `${p.firstName} ${p.lastName}`.trim());
    for (const junk of ["Statistics", "Schedule", "Injured", "Suspended"]) {
      expect(names).not.toContain(junk);
    }
  });
});
