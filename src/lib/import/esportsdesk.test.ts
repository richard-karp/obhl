import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchEsportsdeskLeague } from "@/lib/import/esportsdesk";

/**
 * Roster parsing against the esportsdesk page shape, transcribed from a live
 * rosters.cfm page (clientID=5727, leagueID=23014). The cell layout below is
 * the real one: a status flag, the jersey, the name, then six columns of "-".
 *
 * The nav and legend rows are real too, and they are the reason the jersey
 * COLUMN still has to anchor a player row even when the number is missing —
 * "Statistics" and "Injured" are name-shaped cells sitting in <td>s on the same
 * page, and a parser that just looks for a name finds them.
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

  // The live page renders an unnumbered player's jersey as "-". Requiring
  // digits there dropped 9 of 127 players from the league above without
  // reporting anything.
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

  // A league that assigns no numbers at all: the whole roster used to vanish,
  // and because the teams still parsed the import reported success.
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

  // These four are the shapes that a name-shaped cell alone would admit. They
  // are NOT hypothetical: the first two exist verbatim on every rosters.cfm
  // page, and an earlier cut of this parser imported all four as players
  // because an empty jersey cell is legal and nothing required a stat column
  // after the name. A league whose sidebar renders a short heading in a
  // two-cell row would have had phantom people written to `players`.
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
