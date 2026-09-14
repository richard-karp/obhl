import "server-only";
import * as cheerio from "cheerio";

/**
 * esportsdesk.com importer (read-only scraping). esportsdesk has no API; pages
 * are server-rendered ColdFusion HTML behind a browser-UA gate. We fetch with a
 * browser User-Agent and parse with cheerio. Scrapes rosters (teams + players)
 * only — the starting draft for a new OBHL season.
 *
 * The roster page has no per-row class, so players are matched structurally by
 * cell shape rather than a text heuristic. A multi-season league is handled via
 * the `childSeasonID` query param (the value behind each `sel_ChildSeason`
 * option).
 */

const BASE = "https://www.esportsdesk.com/leagues";
const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

export type ParsedPlayer = {
  number: number | null;
  firstName: string;
  lastName: string;
  isCaptain: boolean;
  position: "F" | "D" | "G";
};
export type ParsedTeam = {
  sourceTeamId: string;
  name: string;
  players: ParsedPlayer[];
};
/** A selectable season behind the page's `sel_ChildSeason` dropdown. */
export type EsportsdeskSeason = { id: string; label: string; current: boolean };
export type ParsedLeague = {
  clientId: string;
  leagueId: string;
  leagueName: string;
  /** The season actually scraped (a `childSeasonID`), or null if unknown. */
  season: string | null;
  seasons: EsportsdeskSeason[];
  teams: ParsedTeam[];
};
/** Pull clientID + leagueID out of any esportsdesk league URL. */
export function parseEsportsdeskUrl(
  url: string,
): { clientId: string; leagueId: string } | null {
  const clientId = url.match(/clientID=(\d+)/i)?.[1];
  const leagueId = url.match(/leagueID=(\d+)/i)?.[1];
  if (!clientId || !leagueId) return null;
  return { clientId, leagueId };
}

/** Season selector → `childSeasonID` query param (empty when none chosen). */
const seasonParam = (season?: string | null): Record<string, string> =>
  season ? { childSeasonID: season } : {};

async function fetchPage(
  path: string,
  params: Record<string, string>,
): Promise<string> {
  const qs = new URLSearchParams(params).toString();
  const res = await fetch(`${BASE}/${path}?${qs}`, {
    headers: { "User-Agent": UA },
  });
  if (!res.ok)
    throw new Error(`esportsdesk ${path} returned HTTP ${res.status}`);
  return res.text();
}

/** Available seasons from the `sel_ChildSeason` dropdown present on every page. */
function parseSeasons($: cheerio.CheerioAPI): EsportsdeskSeason[] {
  const all = $('select[name="sel_ChildSeason"] option')
    .map((_, o) => ({
      id: ($(o).attr("value") || "").trim(),
      label: $(o).text().replace(/\s+/g, " ").trim(),
      current: $(o).attr("selected") != null,
    }))
    .get()
    .filter((s) => s.id);
  // Some pages render the season <select> twice; keep one entry per id.
  return [...new Map(all.map((s) => [s.id, s])).values()];
}

/** League name, team IDs, and selectable seasons from teams.cfm. */
async function fetchLeagueIndex(
  clientId: string,
  leagueId: string,
  season?: string | null,
): Promise<{
  leagueName: string;
  teamIds: string[];
  seasons: EsportsdeskSeason[];
}> {
  const $ = cheerio.load(
    await fetchPage("teams.cfm", {
      clientID: clientId,
      leagueID: leagueId,
      ...seasonParam(season),
    }),
  );
  // Title is like "LCC Old Boys Hockey League - Powered By esportsdesk.com".
  const leagueName =
    ($("title").first().text() || "").split(/ - | : |: |\|/)[0].trim() ||
    "Imported League";
  const ids = new Set<string>();
  $('a[href*="rosters.cfm"]').each((_, a) => {
    const m = ($(a).attr("href") || "").match(/teamID=(\d+)/i);
    if (m) ids.add(m[1]);
  });
  return { leagueName, teamIds: [...ids], seasons: parseSeasons($) };
}

function splitName(full: string): { firstName: string; lastName: string } {
  const parts = full.trim().split(/\s+/);
  return { firstName: parts[0] ?? full, lastName: parts.slice(1).join(" ") };
}

/**
 * A jersey number as the platform prints it. Deliberately shared by the cell
 * test below and by the number that gets stored: the two have to agree, or a
 * cell that counts as a jersey but does not parse as one would import the
 * player with a null number and no indication anything was lost.
 */
const JERSEY_NUMBER = /^\d{1,3}$/;

/**
 * A roster row's jersey cell: either a number, or the placeholder the platform
 * renders when a player has none — "-" on the standard template, an empty cell
 * on some leagues. Anchoring a player row on the CELL rather than on a number
 * is what lets unnumbered players import at all.
 */
const isJerseyCell = (s: string) =>
  JERSEY_NUMBER.test(s) || /^[-\u2013\u2014]*$/.test(s);

/** Team name + players from a rosters.cfm page. */
async function fetchTeamRoster(
  clientId: string,
  leagueId: string,
  teamId: string,
  season?: string | null,
): Promise<ParsedTeam> {
  const $ = cheerio.load(
    await fetchPage("rosters.cfm", {
      clientID: clientId,
      leagueID: leagueId,
      teamID: teamId,
      ...seasonParam(season),
    }),
  );

  // The current team's name is the single word immediately before its W-L-T
  // record (e.g. "Black  19w-10l-8t"). The roster table has no per-row class, so
  // players are matched by cell shape: a jersey cell followed by a name cell; a
  // "C" cell before it marks the captain; a lone G/D cell after the name is the
  // position (most leagues leave it blank → Forward).
  //
  // The jersey cell anchors the row, but its CONTENTS are optional. esportsdesk
  // renders an unnumbered player's number as "-", so requiring digits there
  // dropped those players silently: 9 of 127 in the league this was first
  // written against, and every single player in a league that assigns no
  // numbers at all — which reads as "teams imported, rosters empty". They come
  // through with a null jersey, which `team_players` already allows.
  const text = $("body").text().replace(/\s+/g, " ");
  const name =
    text
      .match(/([A-Za-z][A-Za-z'-]*)\s+\d+\s*w-\d+\s*l-\d+\s*t/i)?.[1]
      ?.trim() ?? `Team ${teamId}`;

  const players: ParsedPlayer[] = [];
  $("tr").each((_, tr) => {
    // Use children() not find() — the page uses a nested two-column table
    // layout; find() descends into nested tables and the outer layout rows
    // accumulate all player cells as descendants, producing false duplicates.
    // Empty cells are KEPT — no .filter(Boolean). The jersey column is what
    // marks a row as a player's, and collapsing blanks would reduce an
    // unnumbered player to a bare name, which this page's nav row
    // ("Statistics", "Schedule", "Roster"…) and status legend ("Injured",
    // "Suspended"…) also look like. Keeping the column in place is what tells
    // those apart.
    //
    // A player row is therefore a name BETWEEN two cells: a jersey cell before
    // it and at least one stat column after it. The trailing half carries as
    // much weight as the leading one, because an EMPTY jersey cell is legal —
    // without it a bare two-cell layout row (["", "Roster"], ["", "Standings"])
    // parses as a player and invents people who do not exist.
    const cells = $(tr)
      .children("td")
      .map((_, td) => $(td).text().replace(/\s+/g, " ").trim())
      .get();
    for (let i = 1; i < cells.length; i++) {
      const playerName = cells[i];
      if (
        i + 1 < cells.length &&
        isJerseyCell(cells[i - 1]) &&
        /^[\p{L}][\p{L} .'-]+$/u.test(playerName) &&
        playerName.length > 2 &&
        playerName.length < 30
      ) {
        // Position is the next filled cell after the name, not a distant scan.
        const posRaw = cells.slice(i + 1).find((c) => c !== "") ?? "";
        const position = /^[GD]$/i.test(posRaw)
          ? (posRaw.toUpperCase() as "F" | "D" | "G")
          : "F";
        players.push({
          number: JERSEY_NUMBER.test(cells[i - 1])
            ? Number(cells[i - 1])
            : null,
          ...splitName(playerName),
          isCaptain: cells.slice(0, i).includes("C"),
          position,
        });
        break; // one player per row
      }
    }
  });

  return { sourceTeamId: teamId, name, players };
}

/** Full league: index (name/seasons) + every team with its roster. */
export async function fetchEsportsdeskLeague(
  clientId: string,
  leagueId: string,
  season?: string | null,
): Promise<ParsedLeague> {
  const { leagueName, teamIds, seasons } = await fetchLeagueIndex(
    clientId,
    leagueId,
    season,
  );
  // Rosters are independent pages — fetch them concurrently (order preserved).
  const teams = await Promise.all(
    teamIds.map((id) => fetchTeamRoster(clientId, leagueId, id, season)),
  );
  const current = seasons.find((s) => s.current)?.id ?? season ?? null;
  return { clientId, leagueId, leagueName, season: current, seasons, teams };
}
