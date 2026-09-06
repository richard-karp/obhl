"use client";

import { useState, useTransition } from "react";
import {
  previewScheduleRepair,
  applyScheduleRepair,
  type RepairPreview,
} from "@/lib/actions/schedule";
import { PlanCard } from "@/components/manage/repair-plan-card";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { formatLongDate } from "@/lib/format";

export type RepairTeam = { id: string; name: string };
export type RepairNight = { date: string; times: string[] };

const SELECT =
  "border-input bg-background h-9 w-full rounded-md border px-2 text-sm";

/**
 * Pin a team to a night — or a night and an ice time — and repair the season
 * around it, or repair it with no pin at all.
 *
 * ⛔ **STATE THE PIN → SEE A PLAN → APPLY.** The diff is on screen before
 * anything is written, never after. This is the screen that stops a manager
 * wrecking a live schedule, and the one-off planner already set the precedent.
 *
 * ⚠️ **What repair cannot do, said out loud on the page rather than only when it
 * fails.** Participation is frozen by the published schedule: who plays on which
 * night cannot move, so games played, byes and per-weekday counts cannot either.
 * What moves is who plays whom, the ice time and home/away. A team pinned to a
 * night it byes is reported unmet with that reason — the obvious reading of "X
 * needs to play that night" is that repair will add them to it, and it will not.
 */
export function ScheduleRepairForm({
  seasonId,
  teams,
  nights,
}: {
  seasonId: string;
  teams: RepairTeam[];
  /** The season's UNLOCKED nights, with the ice times each one runs. */
  nights: RepairNight[];
}) {
  const [teamId, setTeamId] = useState("");
  const [date, setDate] = useState("");
  const [time, setTime] = useState("");

  const [preview, setPreview] = useState<RepairPreview | null>(null);
  const [chosen, setChosen] = useState<string | null>(null);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(
    null,
  );
  const [pending, startTransition] = useTransition();

  const night = nights.find((n) => n.date === date);
  const reset = () => {
    setPreview(null);
    setChosen(null);
    setMessage(null);
  };

  const run = (pin: { teamId: string; date: string; time: string } | null) => {
    setMessage(null);
    startTransition(async () => {
      const res = await previewScheduleRepair({ seasonId, pin });
      if (!res) return;
      if (!res.ok) {
        setPreview(null);
        setMessage({ ok: false, text: res.message });
        return;
      }
      if (res.kind !== "preview") return;
      setPreview(res.preview);
      // ⛔ Index 0, NOT index 1. The one-off form skips its first plan because
      // that one is the zero-change "leave the season alone" baseline;
      // `planRepair` filters that baseline out before returning, so copying the
      // skip here quietly defaulted to the SECOND repair ("disturb the fewest
      // games") while the comment claimed it was picking the best.
      setChosen(res.preview.plans[0]?.id ?? null);
    });
  };

  const onApply = () => {
    if (!preview) return;
    const plan = preview.plans.find((p) => p.id === chosen);
    if (!plan) return;
    startTransition(async () => {
      const res = await applyScheduleRepair({
        seasonId,
        // Dates, not the planner's night indices: apply re-reads the schedule,
        // and an index would silently point at a different night if anything
        // shifted in between.
        changes: plan.changes.map((c) => ({
          date: preview.nights[c.night].date,
          to: c.to,
          // ⛔ The ids this plan was computed against, in slot order. Apply
          // re-reads the schedule and refuses if they have moved — see
          // `PlannedNight.gameIds`.
          gameIds: preview.nights[c.night].gameIds,
        })),
      });
      if (!res) return;
      if (!res.ok) {
        setMessage({ ok: false, text: res.message });
        return;
      }
      if (res.kind !== "applied") return;
      setMessage({ ok: true, text: res.message });
      setPreview(null);
      setChosen(null);
    });
  };

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle className="text-base">
            Put a team on a night, or an ice time
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-muted-foreground text-sm">
            The schedule repairs around the pin: who plays whom, the ice times
            and the home side all move to put opponent balance and ice-time
            share back. Who plays on which night does not move — that is fixed
            by the published schedule, so games played, byes and the weekday
            split stay exactly as they are.
          </p>

          <div className="grid gap-3 sm:grid-cols-3">
            <div className="space-y-1">
              <Label htmlFor="repair_team">Team</Label>
              <select
                id="repair_team"
                className={SELECT}
                value={teamId}
                onChange={(e) => {
                  setTeamId(e.target.value);
                  reset();
                }}
              >
                <option value="">Pick a team…</option>
                {teams.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}
                  </option>
                ))}
              </select>
            </div>

            <div className="space-y-1">
              <Label htmlFor="repair_date">Night</Label>
              <select
                id="repair_date"
                className={SELECT}
                value={date}
                onChange={(e) => {
                  setDate(e.target.value);
                  setTime("");
                  reset();
                }}
              >
                <option value="">Pick a night…</option>
                {nights.map((n) => (
                  <option key={n.date} value={n.date}>
                    {formatLongDate(n.date)}
                  </option>
                ))}
              </select>
            </div>

            <div className="space-y-1">
              <Label htmlFor="repair_time">Ice time (optional)</Label>
              <select
                id="repair_time"
                className={SELECT}
                value={time}
                disabled={!night}
                onChange={(e) => {
                  setTime(e.target.value);
                  reset();
                }}
              >
                <option value="">
                  {night ? "Any time that night" : "Pick a night first…"}
                </option>
                {/*
                  The night's PUBLISHED ice times, not a form's slot list — the
                  pin is about a night that already exists. See `publishedSlots`
                  in the action for the hazard this avoids.
                */}
                {(night?.times ?? []).map((t) => (
                  <option key={t} value={t}>
                    {t}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-3">
            <Button
              onClick={() => run({ teamId, date, time })}
              disabled={pending || !teamId || !date}
            >
              {pending ? "Working…" : "Preview the repair"}
            </Button>
            {/*
              Item 4: the same engine with no pin at all — what a manager
              reaches for after a run of manual reschedules has left the
              ice-time share lopsided.
            */}
            <Button
              variant="outline"
              onClick={() => {
                setTeamId("");
                setDate("");
                setTime("");
                run(null);
              }}
              disabled={pending}
            >
              {pending ? "Working…" : "Just repair the schedule"}
            </Button>
            {message ? (
              <p
                className={
                  message.ok
                    ? "text-sm text-emerald-600 dark:text-emerald-400"
                    : "text-destructive text-sm"
                }
              >
                {message.text}
              </p>
            ) : null}
          </div>
        </CardContent>
      </Card>

      {preview ? (
        <RepairPlans
          preview={preview}
          chosen={chosen}
          onChoose={setChosen}
          onApply={onApply}
          pending={pending}
        />
      ) : null}
    </div>
  );
}

function RepairPlans({
  preview,
  chosen,
  onChoose,
  onApply,
  pending,
}: {
  preview: RepairPreview;
  chosen: string | null;
  onChoose: (id: string) => void;
  onApply: () => void;
  pending: boolean;
}) {
  const name = (i: number) => preview.teams[i]?.name ?? "?";
  const nightDate = (i: number) => preview.nights[i]?.date ?? "";

  // ⛔ The unmet case, said in terms a manager can act on. Never a silent drop.
  if (preview.unmet) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-base">
            That isn&apos;t something a repair can do
          </CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm">{preview.unmet}</p>
        </CardContent>
      </Card>
    );
  }

  // ⚠️ Item 4 has to be able to say this, rather than offer a plan that churns
  // nights for a score that did not move.
  if (preview.nothingToImprove) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Nothing to improve</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          {/*
            ⚠️ "Already true" and "the search could not do it" are different
            answers, and telling a manager the wrong one is how they conclude
            the feature is broken when it simply had no work to do.
          */}
          {preview.pinAlreadyMet ? (
            <p className="text-sm">
              That team is already where you asked for it, so the pin needed no
              change.
            </p>
          ) : null}
          <p className="text-muted-foreground text-sm">
            The search couldn&apos;t find a rearrangement of the remaining
            nights that beats the one already published, so there is nothing
            worth applying.
          </p>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Pick a repair</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {/*
          ⛔ A `play_on` pin that IS satisfiable is one the published schedule
          already meets — repair cannot add a team to a night, so there is no
          other kind it can honour. Saying so stops the manager reading these
          plans as something their pin produced.
        */}
        {preview.pinAlreadyMet ? (
          <p className="text-sm">
            That team is already where you asked for it. These plans are an
            ordinary repair of the nights still to come, not a consequence of
            the pin.
          </p>
        ) : null}
        <p className="text-muted-foreground text-sm">
          Games played, byes and the weekday split are identical in every option
          — those can&apos;t move. What differs is how much of the rest of the
          season is disturbed putting opponent balance, ice time and home/away
          back. No game gets a new id, so team calendar feeds update in place.
        </p>

        <div className="space-y-3">
          {preview.plans.map((plan) => (
            <PlanCard
              key={plan.id}
              plan={plan}
              selected={chosen === plan.id}
              onChoose={() => onChoose(plan.id)}
              name={name}
              nightDate={nightDate}
            />
          ))}
        </div>

        <Button onClick={onApply} disabled={pending || !chosen}>
          {pending ? "Saving…" : "Apply this plan"}
        </Button>
      </CardContent>
    </Card>
  );
}
