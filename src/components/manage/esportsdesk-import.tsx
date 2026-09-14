"use client";

import { useActionState } from "react";
import Link from "next/link";
import {
  previewEsportsdeskImport,
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
  const [run, runAction, running] = useActionState<ImportRunState, FormData>(
    runRosterOnlyImport,
    null,
  );
  const completed = run?.ok ? run : null;

  return (
    <div className="space-y-6">
      {/* Step 1 — paste URL, fetch preview */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">1. Source</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
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
              leagueID. Imports the teams and players only — no games, results,
              or stats.
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
              // ⚠️ Only a PARTIAL success lands here: a clean run redirects from
              // the action. This block is the only record of what came up short.
              <div
                role="status"
                aria-live="polite"
                className="space-y-2 rounded-md bg-emerald-50 px-3 py-2 text-sm text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300"
              >
                <p>{completed.message}</p>
                {/* ⛔ No link when the membership grant failed: it would bounce
                    to the picker and read as a broken link. */}
                {completed.canOpen ? (
                  <Link
                    href={`/${completed.slug}/seasons`}
                    className="inline-block font-medium underline underline-offset-2"
                  >
                    Open the new league →
                  </Link>
                ) : null}
              </div>
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
                  <Button type="submit" disabled={running}>
                    {running ? "Importing…" : "Import rosters"}
                  </Button>
                  {run && !run.ok ? (
                    <p role="alert" className="text-destructive text-sm">
                      {run.message}
                    </p>
                  ) : null}
                  <span className="text-muted-foreground text-xs">
                    Creates a new inactive league with these teams and players
                    and nothing else. Set any goalie positions in Rosters
                    (esportsdesk rarely records them).
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
