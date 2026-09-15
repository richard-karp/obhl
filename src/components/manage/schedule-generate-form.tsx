"use client";

import {
  startTransition,
  useActionState,
  useEffect,
  useMemo,
  useRef,
  useState,
  useTransition,
} from "react";
import type { DateRange, Matcher } from "react-day-picker";
import { CalendarIcon, Loader2Icon, X } from "lucide-react";
import { toast } from "sonner";
import { leagueDateKey } from "@/lib/format";
import {
  generateSchedule,
  saveScheduleConstraint,
  deleteScheduleConstraint,
  type ConstraintState,
  type GenerateState,
} from "@/lib/actions/schedule";
import {
  describeConstraint,
  type ConstraintKind,
  type ScheduleConstraint,
} from "@/lib/schedule/constraints";
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

/** The six request kinds, in the order worth reaching for: bye pins, game pins, then the softer kinds. */
const CONSTRAINT_OPTIONS: { value: ConstraintKind; label: string }[] = [
  { value: "bye_on", label: "Bye on a night" },
  { value: "bye_week", label: "Bye the whole week" },
  { value: "bye_in_week", label: "Bye once in a week" },
  { value: "play_on", label: "Play on a night" },
  { value: "slot_on", label: "Play at an ice time" },
  { value: "slot_bias", label: "Prefer early/late ice" },
];

// ⛔ Add is `type="button"`: a submit reaching a form action makes React 19 reset the whole generate form.
// ⛔ Remove too: a function `formAction` overrides the button's `name`, so the request id arrives empty.
function ConstraintsCard({
  teams,
  constraints,
}: {
  teams: { id: string; name: string }[];
  constraints: ScheduleConstraint[];
}) {
  const [kind, setKind] = useState<ConstraintKind>("bye_on");
  const [addState, addAction, adding] = useActionState<
    ConstraintState,
    FormData
  >(saveScheduleConstraint, null);
  // Not `useActionState`: the id travels in the FormData built here. ⚠️ Which id is in flight, not a
  // boolean, or every ✕ is disabled while any one is removing.
  const [, startRemove] = useTransition();
  const [removingId, setRemovingId] = useState<string | null>(null);
  const removeRequest = (id: string) => {
    setRemovingId(id);
    startRemove(async () => {
      try {
        const body = new FormData();
        body.set("constraint_id", id);
        const result = await deleteScheduleConstraint(null, body);
        if (result?.ok) toast.success(result.message);
        else if (result) toast.error(result.message);
      } catch (err) {
        // ⛔ Never swallow Next's control flow: `redirect()` (via `requireLeagueManager`) throws a "NEXT_"
        // digest, which must go back up. Anything else is a real failure and is said out loud.
        const digest = (err as { digest?: unknown } | null)?.digest;
        if (typeof digest === "string" && digest.startsWith("NEXT_")) throw err;
        toast.error(
          "Couldn't remove that request — check your connection and try again.",
        );
      } finally {
        setRemovingId(null);
      }
    });
  };
  // ⛔ After an add, clear the named fields, never `form.reset()`: this card sits inside the generate form,
  // so a reset empties that too. ⚠️ `constraint_kind` and `constraint_prefer` are kept on purpose.
  const cardRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!addState) return;
    if (addState.ok) {
      toast.success(addState.message);
      const fields = cardRef.current?.querySelectorAll<
        HTMLInputElement | HTMLSelectElement
      >("[name^='constraint_']");
      for (const el of fields ?? []) {
        if (el.name === "constraint_kind" || el.name === "constraint_prefer") {
          continue;
        }
        el.value = "";
      }
    } else toast.error(addState.message);
  }, [addState]);

  const nameOf = (id: string) =>
    teams.find((t) => t.id === id)?.name ?? "A removed team";
  const needsDate =
    kind === "bye_on" || kind === "play_on" || kind === "slot_on";
  const needsWeek = kind === "bye_week" || kind === "bye_in_week";

  return (
    <div
      ref={cardRef}
      className="space-y-2 rounded-lg border p-3"
      /* ⚠️ Enter inside this card means "Add request": the form's default submit button is Generate, a
         25-second run, so the browser must not handle it. */
      onKeyDown={(e) => {
        if (e.key !== "Enter" || e.shiftKey) return;
        const el = e.target as HTMLElement;
        if (el.tagName !== "INPUT" && el.tagName !== "SELECT") return;
        e.preventDefault();
        const form = (el as HTMLInputElement).form;
        if (!form) return;
        const body = new FormData(form);
        startTransition(() => addAction(body));
      }}
    >
      <div className="space-y-0.5">
        <Label>Manager requests (optional)</Label>
        <p className="text-muted-foreground text-xs">
          Best effort, and never at the cost of an even schedule: every team
          still plays the same number of games, every night runs the same
          number, and each pair still meets the same number of times. A forced
          bye moves one of that team&apos;s byes — it never adds one.
        </p>
      </div>

      {constraints.length > 0 ? (
        <ul className="space-y-1">
          {constraints.map((c) => (
            <li
              key={c.id}
              className="bg-secondary/50 flex items-center justify-between gap-2 rounded-md px-2 py-1 text-xs"
            >
              <span>{describeConstraint(c, nameOf(c.teamId))}</span>
              <button
                type="button"
                disabled={removingId === c.id}
                onClick={() => removeRequest(c.id)}
                className="text-muted-foreground hover:text-foreground shrink-0 disabled:opacity-50"
                aria-label={`Remove request: ${describeConstraint(c, nameOf(c.teamId))}`}
              >
                <X className="size-3" />
              </button>
            </li>
          ))}
        </ul>
      ) : null}

      <div className="flex flex-wrap items-end gap-2">
        <div className="space-y-1">
          <Label htmlFor="constraint_team_id" className="text-xs">
            Team
          </Label>
          <select
            id="constraint_team_id"
            name="constraint_team_id"
            className="border-input bg-background h-9 rounded-md border px-2 text-sm"
            defaultValue=""
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
          <Label htmlFor="constraint_kind" className="text-xs">
            Request
          </Label>
          <select
            id="constraint_kind"
            name="constraint_kind"
            value={kind}
            onChange={(e) => setKind(e.target.value as ConstraintKind)}
            className="border-input bg-background h-9 rounded-md border px-2 text-sm"
          >
            {CONSTRAINT_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </div>

        {needsDate ? (
          <div className="space-y-1">
            <Label htmlFor="constraint_date" className="text-xs">
              Date
            </Label>
            <Input id="constraint_date" name="constraint_date" type="date" />
          </div>
        ) : null}

        {needsWeek ? (
          <div className="space-y-1">
            <Label htmlFor="constraint_week_of" className="text-xs">
              Any date that week
            </Label>
            <Input
              id="constraint_week_of"
              name="constraint_week_of"
              type="date"
            />
          </div>
        ) : null}

        {kind === "slot_on" ? (
          <div className="space-y-1">
            <Label htmlFor="constraint_time" className="text-xs">
              Ice time
            </Label>
            <Input
              id="constraint_time"
              name="constraint_time"
              type="time"
              className="w-32"
            />
          </div>
        ) : null}

        {kind === "slot_bias" ? (
          <>
            <div className="space-y-1">
              <Label htmlFor="constraint_from" className="text-xs">
                From
              </Label>
              <Input id="constraint_from" name="constraint_from" type="date" />
            </div>
            <div className="space-y-1">
              <Label htmlFor="constraint_to" className="text-xs">
                To
              </Label>
              <Input id="constraint_to" name="constraint_to" type="date" />
            </div>
            <div className="space-y-1">
              <Label htmlFor="constraint_prefer" className="text-xs">
                Prefer
              </Label>
              <select
                id="constraint_prefer"
                name="constraint_prefer"
                className="border-input bg-background h-9 rounded-md border px-2 text-sm"
                defaultValue="early"
              >
                <option value="early">Earlier ice</option>
                <option value="late">Later ice</option>
              </select>
            </div>
          </>
        ) : null}

        {/*
          ⛔ `type="button"`, not a submit with `formAction` (React 19 resets the generate form). It reads
          `e.currentTarget.form`, so the card must stay inside the generate form.
        */}
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={adding}
          onClick={(e) => {
            const form = e.currentTarget.form;
            if (!form) return;
            const body = new FormData(form);
            startTransition(() => addAction(body));
          }}
        >
          {adding ? "Adding…" : "Add request"}
        </Button>
      </div>
    </div>
  );
}

/** The only submit button in this form: a second would bring back React 19's form reset for it. */
function SubmitButton({ pending }: { pending: boolean }) {
  return (
    <Button type="submit" disabled={pending}>
      {pending ? "Generating…" : "Generate schedule"}
    </Button>
  );
}

/** What a screen reader hears while a generate runs: the sentence only, never the countdown. */
const GENERATING_STATUS = "Building the schedule.";

// Mounted only while pending, so its lifetime is one run. Rendered unconditionally, a second generate would
// measure from the first run's start and show instant overrun.
function GenerateProgressBar({ expectedMs }: { expectedMs: number }) {
  const [elapsedMs, setElapsedMs] = useState(0);

  // The clock is read in an effect: `Date.now()` in a render body is impure.
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
      {/*
        Named, not `aria-hidden`: the one part of the indicator a screen reader can query on demand.
      */}
      <Progress
        value={fraction * 100}
        aria-label="Schedule generation progress"
      />
      {/*
        Visual only: the live region below announces, and the countdown must never reach a screen reader.
      */}
      <p
        className="text-muted-foreground flex items-center gap-1.5 text-xs"
        aria-hidden="true"
      >
        <Loader2Icon className="size-3.5 shrink-0 animate-spin" />
        <span>
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
  teams,
  constraints,
  expectedMs,
}: {
  seasonId: string;
  seasonStart: string | null;
  seasonEnd: string | null;
  /** Enrolled teams, for the constraints card's picker. */
  teams: { id: string; name: string }[];
  /** This season's stored manager requests. */
  constraints: ScheduleConstraint[];
  /** From Phase S's budget: one number for every season, so it overstates a small one (hence "about"). */
  expectedMs: number;
}) {
  const [mode, setMode] = useState<"games" | "date">("games");
  const [skips, setSkips] = useState<SkipRange[]>([]);
  const formRef = useRef<HTMLFormElement>(null);
  // ⚠️ `localStorage`, not a `seasons` column: per-manager scratch. ⛔ Every access in try/catch: blocked
  // storage makes the accessor itself throw, and a season with nothing stored starts at 1.
  const variationKey = `obhl:variation:${seasonId}`;
  const [variation, setVariation] = useState(() => {
    // ⛔ A lazy initialiser is safe only because `variation` is never rendered, so there is no hydration
    // mismatch; render it into an input and this moves into an effect. `typeof window`: the server render.
    if (typeof window === "undefined") return 1;
    try {
      const n = Number(window.localStorage.getItem(variationKey));
      return Number.isFinite(n) && n >= 1 ? Math.min(50, Math.floor(n)) : 1;
    } catch {
      // A convenience, not state: starting over at 1 is correct.
      return 1;
    }
  });
  const rememberVariation = (v: number) => {
    setVariation(v);
    try {
      window.localStorage.setItem(variationKey, String(v));
    } catch {
      /* as above */
    }
  };
  const [pendingRange, setPendingRange] = useState<DateRange | undefined>();
  const [state, action, pending] = useActionState<GenerateState, FormData>(
    generateSchedule,
    null,
  );

  // The result is a toast, and toasting is a side effect, so it lives in an effect.
  useEffect(() => {
    if (!state) return;
    if (state.ok) toast.success(state.message);
    else toast.error(state.message);
  }, [state]);

  const defaultGames = teams.length > 1 ? (teams.length - 1) * 2 : 14;
  const excludedValue = useMemo(
    () =>
      [
        ...new Set(
          skips.flatMap((r) => expandRange(parseKey(r.from), parseKey(r.to))),
        ),
      ]
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

  // ⛔ Dispatched here, not through `<form action>`: React 19 resets uncontrolled inputs on an action submit,
  // and `preventDefault` is what stops it. `startTransition` is what raises `isPending`.
  const onSubmit = (e: React.FormEvent<HTMLFormElement>) => {
    // ⛔ Unconditional: Generate is the only submit, and a null submitter would fall through to a navigation.
    e.preventDefault();
    // Generate always means "the first schedule for these inputs".
    rememberVariation(1);
    dispatch(e.currentTarget, 1);
  };

  // ⛔ `v` is a parameter, never read from state: React batches `setVariation`, so it would resend the old one.
  // ⛔ The Try button calls this as `type="button"`, not a second submit, so the form reset stays shut.
  const dispatch = (form: HTMLFormElement, v: number) => {
    const body = new FormData(form);
    body.set("variation", String(v));
    startTransition(() => action(body));
  };

  const tryAnother = () => {
    const form = formRef.current;
    if (!form) return;
    const next = variation + 1;
    rememberVariation(next);
    dispatch(form, next);
  };

  return (
    <form ref={formRef} onSubmit={onSubmit} className="space-y-4">
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
            // The browser half of the past-date guard; `generateSchedule` refuses server-side. Today in the
            // league's zone, not the browser's, which is a day off for anyone travelling.
            min={leagueDateKey(new Date().toISOString())}
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
            defaultValue="19:00, 20:20, 21:40"
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
                onClick={() =>
                  setSkips((prev) => prev.filter((_, j) => j !== i))
                }
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

      <ConstraintsCard teams={teams} constraints={constraints} />

      <div className="flex items-center gap-3 pt-1">
        <SubmitButton pending={pending} />
        {/*
          ⛔ `type="button"` through `dispatch`, never a second submitter in this form (see `onSubmit`).
        */}
        <Button
          type="button"
          variant="outline"
          disabled={pending}
          onClick={tryAnother}
        >
          Try a different schedule
        </Button>
        {pending ? (
          <GenerateProgressBar expectedMs={expectedMs} />
        ) : (
          <span className="text-muted-foreground text-xs">
            Creates a private preview only managers can see. Review it below,
            then Publish to make it live — or Discard.
          </span>
        )}
      </div>

      {/*
        Permanently mounted: a live region must exist before its content changes. The sentence only, since
        a ticking countdown would be read on every change.
      */}
      <p aria-live="polite" className="sr-only">
        {pending ? GENERATING_STATUS : ""}
      </p>
    </form>
  );
}
