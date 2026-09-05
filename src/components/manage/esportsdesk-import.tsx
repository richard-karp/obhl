"use client";

import { useActionState, useState } from "react";
import {
  previewEsportsdeskImport,
  runEsportsdeskImport,
  type ImportPreviewState,
  type ImportRunState,
} from "@/lib/actions/import";
import { runRosterOnlyImport } from "@/lib/actions/import-rosters";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";

export function EsportsdeskImport() {
  const [preview, previewAction, previewing] = useActionState<
    ImportPreviewState,
    FormData
  >(previewEsportsdeskImport, null);
  // Rosters-only is the default: setting up a new season from last year's
  // rosters is the common case now, and a full migration is the one-time act.
  const [mode, setMode] = useState<"rosters" | "full">("rosters");
  const rostersOnly = mode === "rosters";

  // One hook per action rather than one hook over a dispatcher: each keeps its
  // own result, so switching modes cannot show the message from the other
  // importer — they report different things by design.
  const [runFull, runFullAction, runningFull] = useActionState<
    ImportRunState,
    FormData
  >(runEsportsdeskImport, null);
  const [runRosters, runRostersAction, runningRosters] = useActionState<
    ImportRunState,
    FormData
  >(runRosterOnlyImport, null);
  const run = rostersOnly ? runRosters : runFull;
  const runAction = rostersOnly ? runRostersAction : runFullAction;
  // Derived from what happened, not from the current mode. A success describes
  // a league that now exists, and carries the only report of which rosters came
  // up short, so a stray click on the other radio must not discard it. An error
  // is about an attempt being retried, so that one stays with its mode.
  const completed = runRosters?.ok ? runRosters : runFull?.ok ? runFull : null;
  // Either importer in flight disables both, so switching mode mid-run cannot
  // start a second one alongside it.
  const busy = runningRosters || runningFull;

  return (
    <div className="space-y-6">
      {/* Step 1 — paste URL, fetch preview */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">1. Source</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <fieldset className="space-y-2">
            <legend className="mb-2 text-sm font-medium">What to import</legend>
            <div className="flex items-start gap-2">
              <input
                type="radio"
                id="mode-rosters"
                name="mode"
                value="rosters"
                checked={rostersOnly}
                onChange={() => setMode("rosters")}
                disabled={busy}
                className="mt-1"
              />
              <div>
                <Label htmlFor="mode-rosters">
                  Rosters only (new season setup)
                </Label>
                <p className="text-muted-foreground text-xs">
                  Teams and players as a starting draft. No games, results, or
                  stats — fix the rosters afterwards in Rosters.
                </p>
              </div>
            </div>
            <div className="flex items-start gap-2">
              <input
                type="radio"
                id="mode-full"
                name="mode"
                value="full"
                checked={!rostersOnly}
                onChange={() => setMode("full")}
                disabled={busy}
                className="mt-1"
              />
              <div>
                <Label htmlFor="mode-full">
                  Full migration (teams, schedule, results, stats)
                </Label>
                <p className="text-muted-foreground text-xs">
                  A faithful one-time copy of a finished esportsdesk season.
                </p>
              </div>
            </div>
          </fieldset>
          <form action={previewAction} className="space-y-2">
            <Label htmlFor="url">esportsdesk league URL</Label>
            <div className="flex gap-2">
              <Input
                id="url"
                name="url"
                required
                placeholder="https://www.esportsdesk.com/leagues/teams.cfm?leagueID=23014&clientID=5727"
              />
              <Button type="submit" disabled={previewing}>
                {previewing ? "Reading…" : "Preview"}
              </Button>
            </div>
            <p className="text-muted-foreground text-xs">
              Any esportsdesk page URL works as long as it has clientID and
              leagueID.{" "}
              {rostersOnly
                ? "Imports the teams and players only."
                : "Pulls teams, rosters, and the schedule with final results (one-time migration)."}
            </p>
            {preview && !preview.ok ? (
              <p
                role="alert"
                aria-live="polite"
                className="text-destructive text-sm"
              >
                {preview.message}
              </p>
            ) : null}
          </form>
        </CardContent>
      </Card>

      {/* Step 2 — review + import */}
      {preview?.ok ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">
              2. Review — {preview.preview.leagueName}
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <p className="text-muted-foreground text-sm">
              {preview.preview.teams.length} teams ·{" "}
              {preview.preview.teams.reduce((n, t) => n + t.players.length, 0)}{" "}
              players
              {rostersOnly ? null : (
                <>
                  {" · "}
                  {preview.gameCount > 0
                    ? `${preview.gameCount} games (final results)`
                    : "no schedule found"}
                </>
              )}
            </p>

            {/* Season picker — for leagues with multiple seasons, reloads the
                preview for the chosen season (esportsdesk childSeasonID). */}
            {preview.preview.seasons.length > 1 ? (
              <form
                action={previewAction}
                className="flex flex-wrap items-end gap-2"
              >
                <input type="hidden" name="url" value={preview.url} />
                <div className="space-y-1">
                  <Label htmlFor="season">Season</Label>
                  <select
                    id="season"
                    name="season"
                    key={preview.preview.season ?? ""}
                    defaultValue={preview.preview.season ?? ""}
                    onChange={(e) => e.currentTarget.form?.requestSubmit()}
                    className="border-input bg-background h-9 rounded-md border px-3 text-sm"
                  >
                    {preview.preview.seasons.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.label}
                      </option>
                    ))}
                  </select>
                </div>
                {previewing ? (
                  <span className="text-muted-foreground pb-2 text-xs">
                    Loading…
                  </span>
                ) : null}
              </form>
            ) : null}

            <div className="divide-y rounded-lg border">
              {preview.preview.teams.map((t) => {
                const caps = t.players.filter((p) => p.isCaptain);
                return (
                  <div
                    key={t.sourceTeamId}
                    className="flex items-center justify-between gap-3 px-3 py-2 text-sm"
                  >
                    <span className="font-medium">{t.name}</span>
                    <span className="text-muted-foreground">
                      {t.players.length} players
                      {caps.length ? (
                        <Badge
                          variant="secondary"
                          className="ml-2 px-1.5 py-0 text-[0.65rem]"
                        >
                          C:{" "}
                          {caps
                            .map((c) => `${c.firstName} ${c.lastName}`)
                            .join(", ")}
                        </Badge>
                      ) : null}
                    </span>
                  </div>
                );
              })}
            </div>

            {completed ? (
              <p
                role="status"
                aria-live="polite"
                className="rounded-md bg-emerald-50 px-3 py-2 text-sm text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300"
              >
                {completed.message}
              </p>
            ) : (
              <form
                action={runAction}
                className="grid gap-3 sm:grid-cols-2 sm:items-end"
              >
                <input type="hidden" name="url" value={preview.url} />
                <input
                  type="hidden"
                  name="season"
                  value={preview.preview.season ?? ""}
                />
                <div className="space-y-1">
                  <Label htmlFor="league_name">New league name</Label>
                  <Input
                    id="league_name"
                    name="league_name"
                    required
                    defaultValue={preview.preview.leagueName}
                  />
                </div>
                <div className="space-y-1">
                  <Label htmlFor="season_name">Season name</Label>
                  <Input
                    id="season_name"
                    name="season_name"
                    defaultValue="Imported Season"
                  />
                </div>
                <div className="flex items-center gap-3 sm:col-span-2">
                  <Button type="submit" disabled={busy}>
                    {busy
                      ? "Importing…"
                      : rostersOnly
                        ? "Import rosters"
                        : "Import into OBHL"}
                  </Button>
                  {run && !run.ok ? (
                    <p role="alert" className="text-destructive text-sm">
                      {run.message}
                    </p>
                  ) : null}
                  <span className="text-muted-foreground text-xs">
                    {rostersOnly
                      ? "Creates a new inactive league with these teams and players and nothing else. Set any goalie positions in Rosters (esportsdesk rarely records them)."
                      : "Imports the selected season as a new inactive league. Set any goalie positions in Rosters (esportsdesk rarely records them)."}
                  </span>
                </div>
              </form>
            )}
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}
