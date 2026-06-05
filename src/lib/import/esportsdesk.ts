import "server-only";
import * as cheerio from "cheerio";

/**
 * esportsdesk.com importer (read-only scraping). esportsdesk has no API; pages
 * are server-rendered ColdFusion HTML behind a browser-UA gate. We fetch with a
 * browser User-Agent and parse with cheerio. Standings/stats are NOT scraped —
 * OBHL derives those from games. One-time migration use.
 */

const BASE = "https://www.esportsdesk.com/leagues";
const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

export type ParsedPlayer = {
  number: number | null;
  firstName: string;
  lastName: string;
  isCaptain: boolean;
};
export type ParsedTeam = {
  sourceTeamId: string;
  name: string;
  players: ParsedPlayer[];
};
export type ParsedLeague = {
  clientId: string;
  leagueId: string;
  leagueName: string;
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

async function fetchPage(
  path: string,
  params: Record<string, string>,
): Promise<string> {
  const qs = new URLSearchParams(params).toString();
  const res = await fetch(`${BASE}/${path}?${qs}`, {
    headers: { "User-Agent": UA },
  });
  if (!res.ok) throw new Error(`esportsdesk ${path} returned HTTP ${res.status}`);
  return res.text();
}

/** League name + team IDs, from the teams.cfm page. */
async function fetchLeagueIndex(
  clientId: string,
  leagueId: string,
): Promise<{ leagueName: string; teamIds: string[] }> {
  const $ = cheerio.load(
    await fetchPage("teams.cfm", { clientID: clientId, leagueID: leagueId }),
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
  return { leagueName, teamIds: [...ids] };
}

function splitName(full: string): { firstName: string; lastName: string } {
  const parts = full.trim().split(/\s+/);
  return { firstName: parts[0] ?? full, lastName: parts.slice(1).join(" ") };
}

/** Team name + players from a rosters.cfm page. */
async function fetchTeamRoster(
  clientId: string,
  leagueId: string,
  teamId: string,
): Promise<ParsedTeam> {
  const $ = cheerio.load(
    await fetchPage("rosters.cfm", { clientID: clientId, leagueID: leagueId, teamID: teamId }),
  );

  // The current team's name is the single word immediately before its W-L-T
  // record (e.g. "Black  19w-10l-8t").
  const text = $("body").text().replace(/\s+/g, " ");
  const name =
    text.match(/([A-Za-z][A-Za-z'-]*)\s+\d+\s*w-\d+\s*l-\d+\s*t/i)?.[1]?.trim() ??
    `Team ${teamId}`;

  // Player rows: a jersey number cell followed by a name cell; a leading "C"
  // cell marks the captain. Positions aren't tracked on this site (all "-").
  const players: ParsedPlayer[] = [];
  $("tr").each((_, tr) => {
    const cells = $(tr)
      .find("td")
      .map((_, td) => $(td).text().trim())
      .get()
      .filter(Boolean);
    for (let i = 0; i < cells.length - 1; i++) {
      const next = cells[i + 1];
      if (
        /^\d{1,2}$/.test(cells[i]) &&
        /^[A-Za-z][A-Za-z .'-]+$/.test(next) &&
        next.length > 2 &&
        next.length < 30
      ) {
        players.push({
          number: Number(cells[i]),
          ...splitName(next),
          isCaptain: cells.slice(0, i).includes("C"),
        });
        break; // one player per row
      }
    }
  });

  return { sourceTeamId: teamId, name, players };
}

/** Full league: every team with its roster. */
export async function fetchEsportsdeskLeague(
  clientId: string,
  leagueId: string,
): Promise<ParsedLeague> {
  const { leagueName, teamIds } = await fetchLeagueIndex(clientId, leagueId);
  const teams: ParsedTeam[] = [];
  for (const id of teamIds) {
    teams.push(await fetchTeamRoster(clientId, leagueId, id));
  }
  return { clientId, leagueId, leagueName, teams };
}
