import "server-only";
import * as cheerio from "cheerio";

/**
 * esportsdesk has no API: server-rendered HTML behind a browser-UA gate, scraped with cheerio for
 * rosters only. Players are matched by cell shape; `childSeasonID` picks a season.
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
 * Shared by the cell test and the stored number: if they disagree, a jersey cell that does not
 * parse imports a null number with no sign anything was lost.
 */
const JERSEY_NUMBER = /^\d{1,3}$/;

/**
 * A number, or the no-number placeholder ("-", or empty on some leagues): anchoring a row on the
 * cell rather than a number is what lets unnumbered players import at all.
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

  // The team name is the word before its W-L-T record ("Black  19w-10l-8t"). A player is a jersey
  // cell then a name; a "C" before marks the captain, a lone G/D after is the position.
  const text = $("body").text().replace(/\s+/g, " ");
  const name =
    text
      .match(/([A-Za-z][A-Za-z'-]*)\s+\d+\s*w-\d+\s*l-\d+\s*t/i)?.[1]
      ?.trim() ?? `Team ${teamId}`;

  const players: ParsedPlayer[] = [];
  $("tr").each((_, tr) => {
    // `children()`, not `find()`, which descends into nested layout tables and duplicates players.
    // Empty cells are kept and a name needs a cell on each side, or nav and layout rows parse as people.
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
