"use server";

import { requireManager } from "@/lib/auth/guards";
import {
  fetchEsportsdeskLeague,
  parseEsportsdeskUrl,
  type ParsedLeague,
} from "@/lib/import/esportsdesk";

export type ImportPreviewState =
  | { ok: true; preview: ParsedLeague; url: string }
  | { ok: false; message: string }
  | null;

/** Fetch + parse an esportsdesk league so the manager can review before importing. */
export async function previewEsportsdeskImport(
  _prev: ImportPreviewState,
  formData: FormData,
): Promise<ImportPreviewState> {
  await requireManager();
  const url = String(formData.get("url") ?? "").trim();
  // The esportsdesk childSeasonID to scrape; empty = the league's current season.
  const sourceSeason = String(formData.get("season") ?? "").trim() || null;
  const ids = parseEsportsdeskUrl(url);
  if (!ids) {
    return {
      ok: false,
      message: "Paste an esportsdesk URL that includes clientID and leagueID.",
    };
  }
  try {
    const preview = await fetchEsportsdeskLeague(
      ids.clientId,
      ids.leagueId,
      sourceSeason,
    );
    if (preview.teams.length === 0) {
      return { ok: false, message: "No teams found at that URL." };
    }
    return { ok: true, preview, url };
  } catch (e) {
    return {
      ok: false,
      message: `Couldn't read from esportsdesk: ${(e as Error).message}`,
    };
  }
}

/**
 * What `runRosterOnlyImport` reports back.
 *
 * ⚠️ `ok: true` IS A PARTIAL SUCCESS. A clean run never returns — it redirects
 * into the league it just made — so this arm means the run finished with
 * something to report: teams or rosters that did not land, or a membership grant
 * that failed. In that last case `canOpen` is false and the page must not offer
 * a link into a league the manager cannot open.
 */
export type ImportRunState =
  | { ok: true; slug: string; canOpen: boolean; message: string }
  | { ok: false; message: string }
  | null;
