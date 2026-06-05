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
export type ParsedGame = {
  /** League-local calendar date, "YYYY-MM-DD". */
  date: string;
  /** Team names exactly as they appear in `teams` (the roster import). */
  homeName: string;
  awayName: string;
  homeGoals: number;
  awayGoals: number;
  isPlayoff: boolean;
};
export type ParsedStat = {
  name: string;
  jersey: number;
  /** Team name as in `teams` (the roster import). */
  team: string;
  gp: number;
  g: number;
  a: number;
  pim: number;
};

const MONTHS: Record<string, number> = {
  january: 1, february: 2, march: 3, april: 4, may: 5, june: 6,
  july: 7, august: 8, september: 9, october: 10, november: 11, december: 12,
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

/** Two-digit zero-pad for date parts. */
const pad2 = (n: number) => String(n).padStart(2, "0");

/**
 * Final game results from schedule.cfm.
 *
 * The page has no per-game dates in the rows, no game IDs, and renders a
 * dateless "highlights" block plus a date-grouped full list (each date in a
 * heading element between the game tables). We walk the document in order:
 * index every element, collect the date headings and the game rows separately,
 * then assign each row the most recent *preceding* date heading. Rows before the
 * first date (the highlights block) have no date and are dropped, which also
 * removes the duplicate render. A team never appears twice on one date in the
 * result, confirming the de-duplication. The season's start year comes from the
 * selected season option ("… 2025-2026"); months Jul–Dec use the first year,
 * Jan–Jun the second.
 *
 * Best-effort scrape of one site's layout — not a general esportsdesk parser.
 */
export async function fetchEsportsdeskSchedule(
  clientId: string,
  leagueId: string,
  teamNames: string[],
): Promise<ParsedGame[]> {
  const html = await fetchPage("schedule.cfm", {
    clientID: clientId,
    leagueID: leagueId,
  });
  const $ = cheerio.load(html);

  // Season start year. Prefer the latest "20xx-20xx" on the page (the current
  // season is the most recent); fall back to the current-ish default.
  const yearPairs = [...html.matchAll(/(20\d{2})-(20\d{2})/g)].map((m) => m[0]);
  const latestPair = yearPairs.sort().at(-1) ?? "";
  const startYear = Number(latestPair.slice(0, 4)) || new Date().getFullYear();

  // Known team names, lower-cased → canonical, so we recognise game rows and
  // emit the same names the roster import created.
  const known = new Map(teamNames.map((n) => [n.toLowerCase(), n]));
  const isTeam = (s: string) => known.has((s ?? "").toLowerCase());
  const isScore = (s: string) => /^\d{1,2}$/.test(s ?? "");

  // Index every element in document order so dates and games can be merged.
  const order = new Map<unknown, number>();
  let idx = 0;
  $("*").each((_, el) => {
    order.set(el, idx++);
  });

  // Date headings: an element whose *own* (non-descendant) short text contains
  // "Month DD". Restricting to direct text avoids matching big container nodes.
  const dateRe =
    /(january|february|march|april|may|june|july|august|september|october|november|december)\s+(\d{1,2})/i;
  const dates: { pos: number; mo: number; day: number }[] = [];
  $("*").each((_, el) => {
    const direct = $(el)
      .contents()
      .filter((_, n) => n.type === "text")
      .text()
      .replace(/\s+/g, " ")
      .trim();
    if (direct.length > 40) return;
    const m = direct.match(dateRe);
    if (m) {
      dates.push({
        pos: order.get(el) ?? 0,
        mo: MONTHS[m[1].toLowerCase()],
        day: Number(m[2]),
      });
    }
  });
  const sortedDates = [...new Map(dates.map((d) => [d.pos, d])).values()].sort(
    (a, b) => a.pos - b.pos,
  );

  // Game rows: a <tr> with cells team | score | team | score. The cell before
  // the first team (when present) is the game type ("PO" = playoff).
  type Row = { pos: number; type: string; h: string; hg: number; a: string; ag: number };
  const rows: Row[] = [];
  $("tr").each((_, tr) => {
    const cells = $(tr)
      .find("td")
      .map((_, td) => $(td).text().replace(/\s+/g, " ").trim())
      .get();
    for (let i = 0; i < cells.length - 3; i++) {
      if (
        isTeam(cells[i]) &&
        isScore(cells[i + 1]) &&
        isTeam(cells[i + 2]) &&
        isScore(cells[i + 3])
      ) {
        rows.push({
          pos: order.get(tr) ?? 0,
          type: i > 0 ? cells[i - 1] : "",
          h: cells[i],
          hg: Number(cells[i + 1]),
          a: cells[i + 2],
          ag: Number(cells[i + 3]),
        });
        break; // one game per row
      }
    }
  });

  const seen = new Set<string>();
  const games: ParsedGame[] = [];
  for (const r of rows) {
    // Most recent date heading before this row.
    let cur: { mo: number; day: number } | null = null;
    for (const d of sortedDates) {
      if (d.pos < r.pos) cur = d;
      else break;
    }
    if (!cur) continue; // dateless highlights block → drop (also de-dupes)
    const year = cur.mo >= 7 ? startYear : startYear + 1;
    const date = `${year}-${pad2(cur.mo)}-${pad2(cur.day)}`;
    const key = `${date}|${r.h.toLowerCase()}|${r.hg}|${r.a.toLowerCase()}|${r.ag}`;
    if (seen.has(key)) continue;
    seen.add(key);
    games.push({
      date,
      homeName: known.get(r.h.toLowerCase())!,
      awayName: known.get(r.a.toLowerCase())!,
      homeGoals: r.hg,
      awayGoals: r.ag,
      isPlayoff: r.type.toUpperCase() === "PO",
    });
  }
  return games;
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Regular-season skater totals from stats_hockey.cfm (showGameType=2), paged 20
 * at a time via start_row. The page nests tables so deep that per-cell parsing
 * is hopeless, but each player renders as a flat, well-ordered run of text:
 * `rank Name jersey pos Team GP G A PTS P/G PIM`. We match that with a regex
 * anchored on a known team name and the trailing numbers, and keep only rows
 * where PTS = G + A (rejects spurious matches from menus/footers).
 *
 * These are the league's *official* published totals — which in this league are
 * intentionally incomplete (many goals have no recorded scorer, so the player
 * totals sum to well under the team's goals-for). We reproduce them as-is.
 */
export async function fetchEsportsdeskStats(
  clientId: string,
  leagueId: string,
  teamNames: string[],
): Promise<ParsedStat[]> {
  const teamAlt = teamNames.map(escapeRe).join("|");
  // rank · name · jersey · pos · TEAM · GP · G · A · PTS · P/G · PIM.
  // The name is constrained to actual name characters (letters, spaces, .'-) so
  // it can't stretch across the page's leading cookie/ad JavaScript and swallow
  // the first real rows — that blob has digits and braces a name never does.
  const re = new RegExp(
    `(\\d{1,3})\\s+([A-Za-zÀ-ÿ][A-Za-zÀ-ÿ .'\\-]{1,38}?)\\s+(\\d{1,2})\\s+\\S{1,3}\\s+(${teamAlt})` +
      `\\s+(\\d{1,2})\\s+(\\d{1,3})\\s+(\\d{1,3})\\s+(\\d{1,3})\\s+([\\d.]+)\\s+(\\d{1,3})`,
    "gi",
  );
  const known = new Map(teamNames.map((n) => [n.toLowerCase(), n]));
  const seen = new Set<string>();
  const out: ParsedStat[] = [];
  // start_row is 1-indexed, 20 rows/page; stop when a page yields no new rows.
  for (let startRow = 1; startRow <= 1000; startRow += 20) {
    const html = await fetchPage("stats_hockey.cfm", {
      clientID: clientId,
      leagueID: leagueId,
      statType: "Player",
      showGameType: "2",
      sortby: "PTS1",
      start_row: String(startRow),
    });
    const text = cheerio.load(html)("body").text().replace(/\s+/g, " ");
    let m: RegExpExecArray | null;
    let found = 0;
    re.lastIndex = 0;
    while ((m = re.exec(text)) !== null) {
      const name = m[2].trim();
      const jersey = Number(m[3]);
      const team = known.get(m[4].toLowerCase());
      const gp = Number(m[5]);
      const g = Number(m[6]);
      const a = Number(m[7]);
      const pts = Number(m[8]);
      const pim = Number(m[10]);
      if (!team || pts !== g + a) continue; // integrity guard
      const key = `${name.toLowerCase()}|${team.toLowerCase()}|${jersey}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ name, jersey, team, gp, g, a, pim });
      found++;
    }
    if (found === 0) break;
  }
  return out;
}
