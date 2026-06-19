import "server-only";
import * as cheerio from "cheerio";

/**
 * esportsdesk.com importer (read-only scraping). esportsdesk has no API; pages
 * are server-rendered ColdFusion HTML behind a browser-UA gate. We fetch with a
 * browser User-Agent and parse with cheerio. Scrapes rosters (teams + players),
 * the schedule with final scores, and the published player stat totals; OBHL
 * derives standings from the imported games.
 *
 * Parsing targets the platform's stable CSS hooks where they exist
 * (`tr.boxscores_tables5` for stat rows, `.heading-primary` + `table.table-hover`
 * for the dated schedule) rather than text heuristics, so it generalizes across
 * leagues on the standard "Recreation Sports Management" template. The roster
 * page has no per-row class, so players there are still matched structurally by
 * cell shape. A multi-season league is handled via the `childSeasonID` query
 * param (the value behind each `sel_ChildSeason` option). One-time migration use.
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

/** Two-digit zero-pad for date parts. */
const pad2 = (n: number) => String(n).padStart(2, "0");

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
  if (!res.ok) throw new Error(`esportsdesk ${path} returned HTTP ${res.status}`);
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
): Promise<{ leagueName: string; teamIds: string[]; seasons: EsportsdeskSeason[] }> {
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
  // players are matched by cell shape: a jersey-number cell followed by a name
  // cell; a "C" cell before it marks the captain; a lone G/D cell after the name
  // is the position (most leagues leave it blank → Forward).
  const text = $("body").text().replace(/\s+/g, " ");
  const name =
    text.match(/([A-Za-z][A-Za-z'-]*)\s+\d+\s*w-\d+\s*l-\d+\s*t/i)?.[1]?.trim() ??
    `Team ${teamId}`;

  const players: ParsedPlayer[] = [];
  $("tr").each((_, tr) => {
    // Use children() not find() — the page uses a nested two-column table
    // layout; find() descends into nested tables and the outer layout rows
    // accumulate all player cells as descendants, producing false duplicates.
    const cells = $(tr)
      .children("td")
      .map((_, td) => $(td).text().trim())
      .get()
      .filter(Boolean);
    for (let i = 0; i < cells.length - 1; i++) {
      const next = cells[i + 1];
      if (
        /^\d{1,3}$/.test(cells[i]) &&
        /^[\p{L}][\p{L} .'-]+$/u.test(next) &&
        next.length > 2 &&
        next.length < 30
      ) {
        // Position is the cell immediately after the name, not a distant scan.
        const posRaw = cells[i + 2] ?? "";
        const position = /^[GD]$/i.test(posRaw)
          ? (posRaw.toUpperCase() as "F" | "D" | "G")
          : "F";
        players.push({
          number: Number(cells[i]),
          ...splitName(next),
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

/**
 * Final game results from schedule.cfm.
 *
 * The page lays each game day out as a `.heading-primary` date heading
 * ("Monday September 15, 2025" — full date, with year) immediately followed by a
 * `table.table-hover` whose rows are `[type, Away, AwayScore, Home, HomeScore,
 * result, venue]`. We pair every games table with its preceding date heading
 * (in document order) and read the cells directly — no de-duplication, no
 * year-guessing, no positional text scraping. Rows without numeric scores (games
 * not yet played) are skipped. esportsdesk lists the Away team first, which we
 * map to home/away correctly here.
 */
export async function fetchEsportsdeskSchedule(
  clientId: string,
  leagueId: string,
  teamNames: string[],
  season?: string | null,
): Promise<ParsedGame[]> {
  const $ = cheerio.load(
    await fetchPage("schedule.cfm", {
      clientID: clientId,
      leagueID: leagueId,
      ...seasonParam(season),
    }),
  );

  // Document-order index so each games table can find its date heading.
  const order = new Map<unknown, number>();
  let idx = 0;
  $("*").each((_, el) => {
    order.set(el, idx++);
  });

  const dateRe =
    /(january|february|march|april|may|june|july|august|september|october|november|december)\s+(\d{1,2}),\s+(\d{4})/i;
  const headings = $(".heading-primary")
    .map((_, el) => ({
      pos: order.get(el) ?? 0,
      text: $(el).text().replace(/\s+/g, " ").trim(),
    }))
    .get()
    .sort((a, b) => a.pos - b.pos);

  const known = new Map(teamNames.map((n) => [n.toLowerCase(), n]));
  const canon = (s: string) => known.get(s.toLowerCase()) ?? s;
  const isScore = (s: string) => /^\d{1,2}$/.test(s);

  const games: ParsedGame[] = [];
  $("table.table-hover").each((_, tbl) => {
    const tpos = order.get(tbl) ?? 0;
    // Closest preceding heading; only a dated one marks a game day.
    let h: (typeof headings)[number] | null = null;
    for (const x of headings) {
      if (x.pos < tpos) h = x;
      else break;
    }
    const m = h?.text.match(dateRe);
    if (!m) return;
    const date = `${m[3]}-${pad2(MONTHS[m[1].toLowerCase()])}-${pad2(Number(m[2]))}`;

    $(tbl)
      .find("tr")
      .each((_, tr) => {
        const c = $(tr)
          .find("td")
          .map((_, td) => $(td).text().replace(/\s+/g, " ").trim())
          .get();
        // [type, Away, AwayScore, Home, HomeScore, result, venue]
        if (c.length < 5 || !isScore(c[2]) || !isScore(c[4])) return;
        if (!c[1] || !c[3]) return;
        games.push({
          date,
          awayName: canon(c[1]),
          awayGoals: Number(c[2]),
          homeName: canon(c[3]),
          homeGoals: Number(c[4]),
          isPlayoff: (c[0] || "").toUpperCase() === "PO",
        });
      });
  });
  return games;
}

/**
 * Regular-season skater totals from stats_hockey.cfm (showGameType=2), paged 20
 * at a time via start_row. Player rows carry the class `boxscores_tables5` with
 * fixed columns: `[rank, Name, #, Pos, Team, GP, G, A, PTS, P/G, PIM]`. We read
 * those cells directly (team included, so leagues whose teams aren't colours
 * still resolve) and keep rows where PTS = G + A as an integrity check.
 *
 * These are the league's *official* published totals — which in some leagues are
 * intentionally incomplete (goals with no recorded scorer), so the player totals
 * can sum to less than the team's goals-for. We reproduce them as-is.
 */
export async function fetchEsportsdeskStats(
  clientId: string,
  leagueId: string,
  teamNames: string[],
  season?: string | null,
): Promise<ParsedStat[]> {
  const known = new Map(teamNames.map((n) => [n.toLowerCase(), n]));
  const seen = new Set<string>();
  const out: ParsedStat[] = [];
  // start_row is 1-indexed, 20 rows/page; stop when a page has no player rows.
  for (let startRow = 1; startRow <= 1000; startRow += 20) {
    const $ = cheerio.load(
      await fetchPage("stats_hockey.cfm", {
        clientID: clientId,
        leagueID: leagueId,
        statType: "Player",
        showGameType: "2",
        sortby: "PTS1",
        start_row: String(startRow),
        ...seasonParam(season),
      }),
    );
    const rows = $("tr.boxscores_tables5");
    if (rows.length === 0) break;
    let found = 0;
    rows.each((_, tr) => {
      const c = $(tr)
        .find("td")
        .map((_, td) => $(td).text().replace(/\s+/g, " ").trim())
        .get();
      if (c.length < 11 || !/^\d{1,2}$/.test(c[2])) return;
      const team = known.get((c[4] || "").toLowerCase());
      const g = Number(c[6]);
      const a = Number(c[7]);
      const pts = Number(c[8]);
      if (!team || pts !== g + a) return; // integrity guard
      const name = c[1];
      const jersey = Number(c[2]);
      const key = `${name.toLowerCase()}|${team.toLowerCase()}|${jersey}`;
      if (seen.has(key)) return;
      seen.add(key);
      out.push({ name, jersey, team, gp: Number(c[5]), g, a, pim: Number(c[10]) });
      found++;
    });
    if (found === 0) break;
  }
  return out;
}
