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

// ⛔ State the pin, see a plan, then apply: the diff is on screen before anything is written. ⚠️ Repair
// can't add a team to a night (participation is frozen), so a pin on a bye is reported unmet.
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
      // ⛔ Index 0, not 1: `planRepair` already drops the zero-change baseline the one-off form skips.
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
        // Dates, not night indices: apply re-reads the schedule, and an index could point at another night.
        changes: plan.changes.map((c) => ({
          date: preview.nights[c.night].date,
          to: c.to,
          // ⛔ The ids this plan was computed against, in slot order: apply refuses if they have moved.
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
                  The night's published ice times, not a form's slot list: the pin is about an existing night.
                */}
                {/*
                  ⚠️ Distinct times: two games at one clock time made duplicate keys; the server takes the first.
                */}
                {[...new Set(night?.times ?? [])].map((t) => (
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
              The same engine with no pin: for when manual reschedules have left ice-time share lopsided.
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

  // ⚠️ Not "nothing to improve": repairs exist and the pin rules them out. Merged into the branch below, it
  // would call the season as good as it gets.
  if (preview.pinBlocksImprovement) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-base">
            The pin rules out the repairs
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          <p className="text-sm">
            That team is already on the ice time you asked for. There are ways
            to improve the rest of the season, but every one of them moves that
            game off it.
          </p>
          <p className="text-muted-foreground text-sm">
            Repair without the pin to see them.
          </p>
        </CardContent>
      </Card>
    );
  }

  // ⚠️ An unpinned repair must be able to say this, rather than churn nights for a score that did not move.
  if (preview.nothingToImprove) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Nothing to improve</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          {/*
            ⚠️ "Already true" and "the search could not" are different answers; the wrong one reads as broken.
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
          ⛔ A satisfiable `play_on` pin is one already met (repair can't add a team to a night): say so.
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
