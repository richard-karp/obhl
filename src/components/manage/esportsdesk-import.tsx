"use client";

import { useActionState } from "react";
import {
  previewEsportsdeskImport,
  runEsportsdeskImport,
  type ImportPreviewState,
  type ImportRunState,
} from "@/lib/actions/import";
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
    runEsportsdeskImport,
    null,
  );

  return (
    <div className="space-y-6">
      {/* Step 1 — paste URL, fetch preview */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">1. Source</CardTitle>
        </CardHeader>
        <CardContent>
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
              leagueID. Pulls teams, rosters, and the schedule with final
              results (one-time migration).
            </p>
            {preview && !preview.ok ? (
              <p role="alert" aria-live="polite" className="text-destructive text-sm">
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
              players ·{" "}
              {preview.gameCount > 0
                ? `${preview.gameCount} games (final results)`
                : "no schedule found"}
            </p>
            <div className="divide-y rounded-lg border">
              {preview.preview.teams.map((t) => {
                const caps = t.players.filter((p) => p.isCaptain);
                return (
                  <div key={t.sourceTeamId} className="flex items-center justify-between gap-3 px-3 py-2 text-sm">
                    <span className="font-medium">{t.name}</span>
                    <span className="text-muted-foreground">
                      {t.players.length} players
                      {caps.length ? (
                        <Badge variant="secondary" className="ml-2 px-1.5 py-0 text-[0.65rem]">
                          C: {caps.map((c) => `${c.firstName} ${c.lastName}`).join(", ")}
                        </Badge>
                      ) : null}
                    </span>
                  </div>
                );
              })}
            </div>

            {run?.ok ? (
              <p role="status" aria-live="polite" className="rounded-md bg-emerald-50 px-3 py-2 text-sm text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300">
                {run.message}
              </p>
            ) : (
              <form action={runAction} className="grid gap-3 sm:grid-cols-2 sm:items-end">
                <input type="hidden" name="url" value={preview.url} />
                <div className="space-y-1">
                  <Label htmlFor="league_name">New league name</Label>
                  <Input id="league_name" name="league_name" required defaultValue={preview.preview.leagueName} />
                </div>
                <div className="space-y-1">
                  <Label htmlFor="season_name">Season name</Label>
                  <Input id="season_name" name="season_name" defaultValue="Imported Season" />
                </div>
                <div className="flex items-center gap-3 sm:col-span-2">
                  <Button type="submit" disabled={running}>
                    {running ? "Importing…" : "Import into OBHL"}
                  </Button>
                  {run && !run.ok ? (
                    <p role="alert" className="text-destructive text-sm">{run.message}</p>
                  ) : null}
                  <span className="text-muted-foreground text-xs">
                    Creates a new inactive league + season. Positions default to
                    Forward (esportsdesk has none) — set goalies in Rosters.
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
