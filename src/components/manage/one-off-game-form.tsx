"use client";

import { useState, useTransition } from "react";
import {
  previewOneOffGame,
  applyOneOffGame,
  type OneOffPreview,
} from "@/lib/actions/schedule";
import {
  ICE_METRIC_LABEL,
  type OneOffPlan,
  type OneOffRound,
} from "@/lib/schedule/oneOff";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { formatLongDate } from "@/lib/format";

export type TeamOption = { id: string; name: string };
export type NightOption = { date: string; teamIds: string[]; games: number };

const SELECT =
  "border-input bg-background h-9 w-full rounded-md border px-2 text-sm";

/** Which team-select fields a round needs, in display order. */
function fieldsFor(round: OneOffRound) {
  return round === "semifinals"
    ? [
        { key: "sf1", title: "Semifinal 1" },
        { key: "sf2", title: "Semifinal 2" },
      ]
    : [{ key: "final", title: "" }];
}

export function OneOffGameForm({
  seasonId,
  teams,
  nights,
}: {
  seasonId: string;
  teams: TeamOption[];
  nights: NightOption[];
}) {
  const [round, setRound] = useState<OneOffRound>("final");
  const [picks, setPicks] = useState<Record<string, string>>({});
  const [label, setLabel] = useState("Final");
  const [date, setDate] = useState("");
  const [featureSlot, setFeatureSlot] = useState(true);

  const [preview, setPreview] = useState<OneOffPreview | null>(null);
  const [chosen, setChosen] = useState<string | null>(null);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(
    null,
  );
  const [pending, startTransition] = useTransition();

  const fields = fieldsFor(round);
  const slotKeys = fields.flatMap((f) => [`${f.key}_a`, `${f.key}_b`]);
  const picked = slotKeys.map((k) => picks[k]).filter(Boolean);
  const complete = picked.length === slotKeys.length;
  const distinct = new Set(picked).size === picked.length;

  /**
   * Only nights where *every* chosen team is already scheduled. Forcing the
   * matchup onto any other night would take a game off whoever it displaced,
   * so an ineligible night is never offered rather than validated after the
   * fact.
   */
  const eligible =
    complete && distinct
      ? nights.filter(
          (n) =>
            n.games >= fields.length &&
            picked.every((t) => n.teamIds.includes(t)),
        )
      : [];

  const reset = () => {
    setPreview(null);
    setChosen(null);
    setMessage(null);
  };

  const matchups = (): [string, string][] =>
    fields.map((f) => [picks[`${f.key}_a`], picks[`${f.key}_b`]]);

  const onPreview = () => {
    setMessage(null);
    startTransition(async () => {
      const res = await previewOneOffGame({
        seasonId,
        round,
        matchups: matchups(),
        label,
        date,
        featureSlot,
      });
      if (!res) return;
      if (!res.ok) {
        setPreview(null);
        setMessage({ ok: false, text: res.message });
        return;
      }
      if (res.kind !== "preview") return;
      setPreview(res.preview);
      setChosen(
        res.preview.plans[res.preview.plans.length > 1 ? 1 : 0]?.id ?? null,
      );
    });
  };

  const onApply = () => {
    if (!preview) return;
    const plan = preview.plans.find((p) => p.id === chosen);
    if (!plan) return;
    startTransition(async () => {
      const res = await applyOneOffGame({
        seasonId,
        round,
        matchups: matchups(),
        label,
        date,
        // Send dates, not the planner's night indices: apply re-reads the
        // schedule, and an index would silently point at a different night if
        // anything shifted in between.
        changes: plan.changes.map((c) => ({
          date: preview.nights[c.night].date,
          to: c.to,
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
      setPicks({});
      setDate("");
    });
  };

  const teamSelect = (key: string, text: string) => (
    <div className="space-y-1">
      <Label htmlFor={key}>{text}</Label>
      <select
        id={key}
        className={SELECT}
        value={picks[key] ?? ""}
        onChange={(e) => {
          setPicks({ ...picks, [key]: e.target.value });
          setDate("");
          reset();
        }}
      >
        <option value="" disabled>
          Pick a team…
        </option>
        {teams.map((t) => (
          <option key={t.id} value={t.id}>
            {t.name}
          </option>
        ))}
      </select>
    </div>
  );

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle className="text-base">The game</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1">
              <Label htmlFor="round">Round</Label>
              <select
                id="round"
                className={SELECT}
                value={round}
                onChange={(e) => {
                  setRound(e.target.value as OneOffRound);
                  setPicks({});
                  setDate("");
                  reset();
                }}
              >
                <option value="final">Final (1 game)</option>
                <option value="semifinals">Semifinals (2 games)</option>
              </select>
            </div>
            {round === "final" ? (
              <div className="space-y-1">
                <Label htmlFor="label">Label</Label>
                <Input
                  id="label"
                  value={label}
                  onChange={(e) => setLabel(e.target.value)}
                />
              </div>
            ) : null}
          </div>

          {fields.map((f) => (
            <div key={f.key} className="space-y-1.5">
              {f.title ? (
                <p className="text-muted-foreground text-xs font-semibold uppercase">
                  {f.title}
                </p>
              ) : null}
              <div className="grid gap-3 sm:grid-cols-2">
                {teamSelect(`${f.key}_a`, "Team 1")}
                {teamSelect(`${f.key}_b`, "Team 2")}
              </div>
            </div>
          ))}

          {complete && !distinct ? (
            <p className="text-destructive text-sm">
              Each team can only be in one of these games.
            </p>
          ) : null}

          <div className="space-y-1 sm:max-w-sm">
            <Label htmlFor="date">Date</Label>
            <select
              id="date"
              className={SELECT}
              value={date}
              disabled={!complete || !distinct}
              onChange={(e) => {
                setDate(e.target.value);
                reset();
              }}
            >
              <option value="" disabled>
                {!complete || !distinct
                  ? "Pick the teams first…"
                  : eligible.length === 0
                    ? "No night has all these teams playing"
                    : "Pick a night…"}
              </option>
              {eligible.map((n) => (
                <option key={n.date} value={n.date}>
                  {formatLongDate(n.date)}
                </option>
              ))}
            </select>
            <p className="text-muted-foreground text-xs">
              Only nights where every chosen team is already scheduled. The game
              takes over one of that night&apos;s games rather than adding one,
              so nobody gains or loses a game.
            </p>
          </div>

          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={featureSlot}
              onChange={(e) => {
                setFeatureSlot(e.target.checked);
                reset();
              }}
            />
            Give the labelled game the last ice time
          </label>
          {featureSlot ? (
            <p className="text-muted-foreground text-xs">
              Holding that slot costs those two teams a little of their even
              ice-time share for the season.
            </p>
          ) : null}

          <div className="flex items-center gap-3">
            <Button
              onClick={onPreview}
              disabled={pending || !date || !distinct}
            >
              {pending ? "Working…" : "Preview"}
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
        <PlanPicker
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

function PlanPicker({
  preview,
  chosen,
  onChoose,
  onApply,
  pending,
}: {
  preview: OneOffPreview;
  chosen: string | null;
  onChoose: (id: string) => void;
  onApply: () => void;
  pending: boolean;
}) {
  const name = (i: number) => preview.teams[i]?.name ?? "?";
  const nightDate = (i: number) => preview.nights[i]?.date ?? "";

  if (preview.relabelOnly) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Nothing to repair</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <p className="text-muted-foreground text-sm">
            Those teams are already playing each other that night, so this is
            just a label. No other game changes.
          </p>
          <Button onClick={onApply} disabled={pending}>
            {pending ? "Saving…" : "Label the game"}
          </Button>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Pick how to absorb it</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-muted-foreground text-sm">
          Games played, byes and the weekday split are identical in every option
          below — those can&apos;t move. What differs is how much of the rest of
          the season is disturbed putting opponent balance, ice time and
          home/away back.
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

function Metric({
  label,
  before,
  after,
}: {
  label: string;
  before: number;
  after: number;
}) {
  const worse = after > before;
  return (
    <div className="flex items-baseline gap-1.5">
      <span className="text-muted-foreground">{label}</span>
      <span
        className={
          worse
            ? "text-amber-600 tabular-nums dark:text-amber-400"
            : after < before
              ? "text-emerald-600 tabular-nums dark:text-emerald-400"
              : "tabular-nums"
        }
      >
        {before} → {after}
      </span>
    </div>
  );
}

function PlanCard({
  plan,
  selected,
  onChoose,
  name,
  nightDate,
}: {
  plan: OneOffPlan;
  selected: boolean;
  onChoose: () => void;
  name: (i: number) => string;
  nightDate: (i: number) => string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div
      className={
        selected
          ? "border-primary rounded-lg border-2 p-3"
          : "rounded-lg border p-3"
      }
    >
      <label className="flex cursor-pointer items-start gap-3">
        <input
          type="radio"
          name="plan"
          className="mt-1"
          checked={selected}
          onChange={onChoose}
        />
        <div className="min-w-0 flex-1 space-y-1.5">
          <div className="font-medium">{plan.label}</div>
          <div className="text-muted-foreground flex flex-wrap gap-x-4 gap-y-1 text-xs">
            <span>
              {plan.matchupNights.length} night
              {plan.matchupNights.length === 1 ? "" : "s"} with a new opponent
            </span>
            <span>
              {plan.sameOpponentNights.length} keeping the same opponents
            </span>
            {plan.settledNight !== null ? (
              <span>
                settled by {formatLongDate(nightDate(plan.settledNight))}
              </span>
            ) : null}
          </div>
          <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs">
            <span
              className={
                plan.drift.length === 0
                  ? "text-emerald-600 dark:text-emerald-400"
                  : "text-amber-600 dark:text-amber-400"
              }
            >
              {plan.drift.length === 0
                ? "✓ opponent balance restored"
                : `${plan.drift.length} matchup${plan.drift.length === 1 ? "" : "s"} left off target`}
            </span>
            <Metric
              label="ice time"
              before={plan.slotSpreadBefore}
              after={plan.slotSpreadAfter}
            />
            <Metric
              label="weekday ice"
              before={plan.spacingBefore.slotWeekdaySpread}
              after={plan.spacingAfter.slotWeekdaySpread}
            />
            <Metric
              label="home/away"
              before={plan.homeAwaySpreadBefore}
              after={plan.homeAwaySpreadAfter}
            />
          </div>
          {/*
            Measured against leaving the season alone, not against the numbers
            above — those read from the pre-edit schedule. A repair can improve
            on the incumbent and still be the worse of the two ways forward.
          */}
          {plan.worseThan.length > 0 ? (
            <div className="text-amber-600 dark:text-amber-400 text-xs">
              ⚠ worse than leaving the season alone:{" "}
              {plan.worseThan.map((m) => ICE_METRIC_LABEL[m]).join(", ")}
            </div>
          ) : null}
        </div>
      </label>

      {plan.changes.length > 0 ? (
        <div className="mt-2 pl-7">
          <button
            type="button"
            onClick={() => setOpen(!open)}
            className="text-muted-foreground hover:text-foreground text-xs underline"
          >
            {open ? "Hide" : "Show"} the {plan.changes.length} night
            {plan.changes.length === 1 ? "" : "s"} that change
          </button>
          {open ? (
            <div className="mt-2 space-y-2">
              {plan.changes.map((c) => (
                <div key={c.night} className="text-xs">
                  <div className="font-medium">
                    {formatLongDate(nightDate(c.night))}
                    {c.matchupChanged ? null : (
                      <span className="text-muted-foreground font-normal">
                        {" "}
                        · same opponents — ice time or home side
                      </span>
                    )}
                  </div>
                  <div className="text-muted-foreground grid gap-0.5 sm:grid-cols-2">
                    <div>
                      {c.from.map((g, i) => (
                        <div key={i}>
                          {name(g[1])} @ {name(g[0])}
                        </div>
                      ))}
                    </div>
                    <div>
                      {c.to.map((g, i) => (
                        <div key={i}>
                          {name(g[1])} @ {name(g[0])}
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
