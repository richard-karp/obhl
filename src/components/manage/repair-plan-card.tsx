"use client";

import { useState } from "react";
import { ICE_METRIC_LABEL, type OneOffPlan } from "@/lib/schedule/oneOff";
import { formatLongDate } from "@/lib/format";

/**
 * One ranked repair plan, with its scorecard and its per-night diff.
 *
 * Shared by the one-off planner and the schedule repair, because they are the
 * same plans from the same engine — `planRepair` is `planOneOff` with no
 * one-off game on it. Two copies of this card would drift, and the thing they
 * would drift on is the ⛔ below.
 *
 * ⛔ THE DIFF IS SHOWN BEFORE THE APPLY, NEVER AFTER. This is the screen that
 * stops a manager wrecking a live schedule, and it is the reason the whole flow
 * is state-the-change → see-a-plan → apply rather than a button that just does
 * it.
 */
export function PlanCard({
  plan,
  selected,
  onChoose,
  name,
  nightDate,
}: {
  plan: OneOffPlan;
  selected: boolean;
  onChoose: () => void;
  /** Team name by planner index. */
  name: (i: number) => string;
  /** Night date by planner index. */
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
            <div className="text-xs text-amber-600 dark:text-amber-400">
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
