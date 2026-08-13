"use client";

import { useActionState, useEffect, useMemo, useState } from "react";
import type { DateRange, Matcher } from "react-day-picker";
import { CalendarIcon, Loader2Icon, X } from "lucide-react";
import { toast } from "sonner";
import { generateSchedule, type GenerateState } from "@/lib/actions/schedule";
import { generateProgress } from "@/components/manage/generate-progress";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Progress } from "@/components/ui/progress";
import { Calendar } from "@/components/ui/calendar";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";

const WEEKDAYS = [
  { value: 1, label: "Mon" },
  { value: 2, label: "Tue" },
  { value: 3, label: "Wed" },
  { value: 4, label: "Thu" },
  { value: 5, label: "Fri" },
  { value: 6, label: "Sat" },
  { value: 0, label: "Sun" },
];

/** Local-date key (YYYY-MM-DD) — matches the calendar day the user clicked. */
function dateKey(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function parseKey(s: string): Date {
  const [y, m, d] = s.split("-").map(Number);
  return new Date(y, m - 1, d);
}

function shortLabel(s: string): string {
  return parseKey(s).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
}

/** Every date from `from` to `to` inclusive, as YYYY-MM-DD keys. */
function expandRange(from: Date, to: Date): string[] {
  const out: string[] = [];
  const cur = new Date(from.getFullYear(), from.getMonth(), from.getDate());
  const end = new Date(to.getFullYear(), to.getMonth(), to.getDate());
  while (cur <= end) {
    out.push(dateKey(cur));
    cur.setDate(cur.getDate() + 1);
  }
  return out;
}

type SkipRange = { from: string; to: string };

function SubmitButton({ pending }: { pending: boolean }) {
  return (
    <Button type="submit" disabled={pending}>
      {pending ? "Generating…" : "Generate schedule"}
    </Button>
  );
}

/**
 * The bar, the countdown, and the tick that drives them.
 *
 * Mounted only while the action is pending (see the call site), so this
 * component's lifetime *is* one run: the start timestamp is captured at mount
 * and the interval is torn down at unmount. That is load-bearing. If this were
 * ever rendered unconditionally with `pending` as a prop, a second generate
 * would measure from the first run's start and show instant overrun, and the
 * interval would keep ticking between runs — both would need an explicit reset
 * to replace what the conditional render gives for free.
 */
function GenerateProgressBar({ expectedMs }: { expectedMs: number }) {
  const [elapsedMs, setElapsedMs] = useState(0);

  // The clock is read here rather than during render — `Date.now()` in a render
  // body is impure, and an effect that runs once on mount is the same instant
  // for this component's purposes.
  useEffect(() => {
    const startedAt = Date.now();
    const id = setInterval(() => {
      setElapsedMs(Date.now() - startedAt);
    }, 250);
    return () => clearInterval(id);
  }, []);

  const { fraction, remainingSec, overrun } = generateProgress(
    elapsedMs,
    expectedMs,
  );

  return (
    <div className="min-w-0 flex-1 space-y-1.5">
      <Progress value={fraction * 100} />
      <p className="text-muted-foreground flex items-center gap-1.5 text-xs">
        <Loader2Icon className="size-3.5 shrink-0 animate-spin" aria-hidden />
        {/*
          The live region carries the sentence, never the ticking number: a
          countdown inside it would be announced on every tick. The number sits
          in a sibling span, so screen readers hear "Building the schedule"
          once, and the overrun wording once if it comes.
        */}
        <span aria-live="polite">
          {overrun
            ? "Still working — this season is taking longer than usual."
            : "Building the schedule"}
        </span>
        {overrun ? null : <span>— about {remainingSec}s left.</span>}
      </p>
    </div>
  );
}

export function ScheduleGenerateForm({
  seasonId,
  seasonStart,
  seasonEnd,
  teamCount,
  expectedMs,
}: {
  seasonId: string;
  seasonStart: string | null;
  seasonEnd: string | null;
  teamCount: number;
  /**
   * How long a generate is expected to take, computed server-side from the
   * generator's own Phase S budget.
   *
   * One number for every season, NOT a per-season estimate — the search spends
   * its whole budget on any league big enough to need it, and saturates from
   * about 28 game nights up. Below that it overstates: a 12-night season is
   * told "about 26 seconds" and finishes in under 3. That was a deliberate
   * choice over a never-overstating "up to about 30 seconds" ceiling, and the
   * copy hedges with "about" because of it. An adaptive curve was rejected —
   * the night count is available, but the night-count-to-time fit is one
   * machine's numbers.
   */
  expectedMs: number;
}) {
  const [mode, setMode] = useState<"games" | "date">("games");
  const [skips, setSkips] = useState<SkipRange[]>([]);
  const [pendingRange, setPendingRange] = useState<DateRange | undefined>();
  const [state, action, pending] = useActionState<GenerateState, FormData>(
    generateSchedule,
    null,
  );

  // Same house pattern as publish-controls.tsx: the result is a toast, not
  // inline text, and toasting is a side effect on an external system.
  useEffect(() => {
    if (!state) return;
    if (state.ok) toast.success(state.message);
    else toast.error(state.message);
  }, [state]);

  const defaultGames = teamCount > 1 ? (teamCount - 1) * 2 : 14;
  const excludedValue = useMemo(
    () =>
      [...new Set(skips.flatMap((r) => expandRange(parseKey(r.from), parseKey(r.to))))]
        .sort()
        .join(", "),
    [skips],
  );

  const addPending = () => {
    if (!pendingRange?.from) return;
    const to = pendingRange.to ?? pendingRange.from;
    setSkips((prev) => [
      ...prev,
      { from: dateKey(pendingRange.from!), to: dateKey(to) },
    ]);
    setPendingRange(undefined);
  };

  const disabled: Matcher[] = [];
  if (seasonStart) disabled.push({ before: parseKey(seasonStart) });
  if (seasonEnd) disabled.push({ after: parseKey(seasonEnd) });

  return (
    <form action={action} className="space-y-4">
      <input type="hidden" name="season_id" value={seasonId} />
      <input type="hidden" name="length_mode" value={mode} />
      <input type="hidden" name="excluded_dates" value={excludedValue} />

      <div className="grid gap-4 sm:grid-cols-4 sm:items-end">
        <div className="space-y-1">
          <Label htmlFor="start_date">First game night</Label>
          <Input
            id="start_date"
            name="start_date"
            type="date"
            required
            defaultValue={seasonStart ?? ""}
          />
        </div>

        <div className="space-y-1 sm:col-span-2">
          <Label>Regular-season length</Label>
          <div className="flex gap-1.5">
            {(["games", "date"] as const).map((m) => (
              <button
                key={m}
                type="button"
                onClick={() => setMode(m)}
                className={`h-9 flex-1 rounded-md border px-2 text-sm font-medium ${
                  mode === m
                    ? "bg-secondary border-secondary-foreground/30"
                    : "border-input"
                }`}
              >
                {m === "games" ? "By games per team" : "By end date"}
              </button>
            ))}
          </div>
        </div>

        {mode === "games" ? (
          <div className="space-y-1">
            <Label htmlFor="games_per_team">Games per team</Label>
            <Input
              id="games_per_team"
              name="games_per_team"
              type="number"
              min={1}
              max={200}
              defaultValue={defaultGames}
            />
          </div>
        ) : (
          <div className="space-y-1">
            <Label htmlFor="reg_season_end">Last regular-season night</Label>
            <Input
              id="reg_season_end"
              name="reg_season_end"
              type="date"
              required
              defaultValue={seasonEnd ?? ""}
            />
          </div>
        )}
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-1">
          <Label htmlFor="slot_times">Ice-time slots (earliest → latest)</Label>
          <Input
            id="slot_times"
            name="slot_times"
            defaultValue="19:00, 20:15, 21:30"
          />
        </div>

        <div className="space-y-1.5">
          <Label>Game nights</Label>
          <div className="flex flex-wrap gap-1.5">
            {WEEKDAYS.map((d) => (
              <label
                key={d.value}
                className="border-input has-[:checked]:bg-secondary has-[:checked]:border-secondary-foreground/30 flex cursor-pointer items-center gap-1.5 rounded-md border px-2.5 py-1 text-sm font-medium select-none"
              >
                <input type="checkbox" name="weekdays" value={d.value} />
                {d.label}
              </label>
            ))}
          </div>
        </div>
      </div>

      <div className="space-y-1.5">
        <Label>Weeks off / skip dates</Label>
        <div className="flex flex-wrap items-center gap-2">
          <Popover>
            <PopoverTrigger asChild>
              <Button type="button" variant="outline" size="sm">
                <CalendarIcon className="mr-1.5 size-4" /> Pick dates
              </Button>
            </PopoverTrigger>
            <PopoverContent className="w-auto p-0" align="start">
              <Calendar
                mode="range"
                selected={pendingRange}
                onSelect={setPendingRange}
                defaultMonth={seasonStart ? parseKey(seasonStart) : undefined}
                disabled={disabled.length ? disabled : undefined}
              />
              <div className="flex items-center justify-between gap-2 border-t p-2">
                <span className="text-muted-foreground text-xs">
                  {pendingRange?.from
                    ? `${shortLabel(dateKey(pendingRange.from))}${
                        pendingRange.to
                          ? ` – ${shortLabel(dateKey(pendingRange.to))}`
                          : ""
                      }`
                    : "Click a day or drag a range"}
                </span>
                <Button
                  type="button"
                  size="sm"
                  onClick={addPending}
                  disabled={!pendingRange?.from}
                >
                  Add
                </Button>
              </div>
            </PopoverContent>
          </Popover>

          {skips.map((r, i) => (
            <span
              key={`${r.from}-${r.to}-${i}`}
              className="bg-secondary flex items-center gap-1 rounded-md px-2 py-1 text-xs"
            >
              {r.from === r.to
                ? shortLabel(r.from)
                : `${shortLabel(r.from)} – ${shortLabel(r.to)}`}
              <button
                type="button"
                onClick={() => setSkips((prev) => prev.filter((_, j) => j !== i))}
                className="text-muted-foreground hover:text-foreground"
                aria-label="Remove"
              >
                <X className="size-3" />
              </button>
            </span>
          ))}
        </div>
        <p className="text-muted-foreground text-xs">
          Optional. Skip holidays or breaks — pick a single day or a range.
        </p>
      </div>

      <div className="flex items-center gap-3 pt-1">
        <SubmitButton pending={pending} />
        {pending ? (
          <GenerateProgressBar expectedMs={expectedMs} />
        ) : (
          <span className="text-muted-foreground text-xs">
            Creates a private preview only managers can see. Review it below,
            then Publish to make it live — or Discard.
          </span>
        )}
      </div>
    </form>
  );
}
