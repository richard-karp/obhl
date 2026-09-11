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

/**
 * The six things a manager can tell the generator, in the order they are worth
 * reaching for: the two that pin a bye, the two that pin a game, then the
 * softer week-level and preference kinds.
 */
const CONSTRAINT_OPTIONS: { value: ConstraintKind; label: string }[] = [
  { value: "bye_on", label: "Bye on a night" },
  { value: "bye_week", label: "Bye the whole week" },
  { value: "bye_in_week", label: "Bye once in a week" },
  { value: "play_on", label: "Play on a night" },
  { value: "slot_on", label: "Play at an ice time" },
  { value: "slot_bias", label: "Prefer early/late ice" },
];

/**
 * The constraints card.
 *
 * ⚠️ It lives INSIDE the generate form, and that is not a layout preference.
 * The season's game nights do not exist until this form is filled in — they are
 * derived by `enumerateNights` from the weekdays, skip dates and start/end above,
 * and nothing about them is stored. A card rendered elsewhere on the page would
 * have no calendar to offer.
 *
 * ⛔ NEITHER BUTTON HERE IS A SUBMIT BUTTON, AND BOTH REASONS ARE LOAD-BEARING.
 *
 * Adding used to post through `formAction` on a submit button — the only way a
 * control inside the generate form can post somewhere else, since HTML forbids
 * nested forms. It worked, and it took the whole generate form down with it:
 * React 19 resets every uncontrolled input on a submit that reaches its form
 * action, so adding one manager request wiped the first game night, the games
 * per team, the ice times and every weekday checkbox the manager had just
 * typed. Measured 2026-09-06 on Fall 2026. It was also this form's FIRST submit
 * button in tree order, which made it what Enter did from any text field.
 *
 * So Add is an ordinary `type="button"` that builds its own `FormData` from the
 * form it sits in and calls the action in a transition — the same shape Remove
 * has always had, for the different reason below. With no submit button but
 * Generate left in the form, the form's own `onSubmit` can prevent the default
 * unconditionally, which is what stops the reset.
 *
 * ⛔ REMOVING CANNOT USE `formAction` EITHER, AND THIS IS NOT A STYLE CHOICE. A remove
 * has to say WHICH request, and the obvious way — `name="constraint_id"
 * value={c.id}` on the submit button — is silently broken. React uses a submit
 * button's `name` to encode which action to invoke when `formAction` is a
 * function, so it OVERRIDES the one written there:
 *
 *     Cannot specify a "name" prop for a button that specifies a function as a
 *     formAction. React needs it to encode which action should be invoked.
 *     It will get overridden.
 *
 * That is a console warning, not an error, and what it describes has no symptom
 * worth the name: the action runs, `constraint_id` arrives empty, and the
 * manager is told "No request selected." about a request they plainly selected.
 * Measured 2026-09-04 — every ✕ on this card was inert, and a request once added
 * could not be removed at all.
 *
 * `type="button"` also stops the ✕ submitting the generate form by accident,
 * which a bare `<button>` in a form otherwise does.
 *
 * The date fields are plain dates, deliberately unvalidated here: this component
 * cannot know which dates become game nights until the generator runs, so a
 * request naming a date that turns out not to be one is reported unmet with that
 * reason on the preview rather than refused at entry.
 */
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
  // Not `useActionState` — see the ⛔ above. The id has to travel in the
  // FormData this builds, because a submit button's `name` cannot carry it.
  //
  // ⚠️ WHICH id is in flight, not a boolean. One shared pending flag disabled
  // EVERY ✕ while any one of them was removing — wrong to look at, and what
  // made the e2e teardown click a disabled button and time out.
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
        // ⛔ NEVER SWALLOW NEXT'S CONTROL FLOW. `redirect()` and `notFound()`
        // work BY THROWING, and this action reaches `redirect("/")` through
        // `requireLeagueManager` — catching that would turn "you may not do
        // this" into a toast and leave the manager sitting on the page they
        // were being sent away from. Both carry a `digest` of "NEXT_REDIRECT;…"
        // or "NEXT_NOT_FOUND", so they go straight back up.
        //
        // Everything else is a real failure and has to be said out loud:
        // `useActionState` used to own this path, and replacing it with a bare
        // await left a rejected action looking exactly like the inert ✕ this
        // control was just fixed for.
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
  useEffect(() => {
    if (!addState) return;
    if (addState.ok) toast.success(addState.message);
    else toast.error(addState.message);
  }, [addState]);

  const nameOf = (id: string) =>
    teams.find((t) => t.id === id)?.name ?? "A removed team";
  const needsDate =
    kind === "bye_on" || kind === "play_on" || kind === "slot_on";
  const needsWeek = kind === "bye_week" || kind === "bye_in_week";

  return (
    <div
      className="space-y-2 rounded-lg border p-3"
      /*
        ⚠️ ENTER INSIDE THIS CARD MEANS "ADD REQUEST", NOT "GENERATE".
        A form has one default submit button, and now that Add is a plain
        button that is Generate — so Enter from the date or ice-time field
        started a 25-second generate instead of adding the request the manager
        was in the middle of typing. It used to do the right thing only by
        accident, because Add happened to be the first submit button in tree
        order. Handled here rather than left to the browser.
      */
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
          ⛔ `type="button"`, NOT a submit carrying `formAction` — see the ⛔ in
          this component's header. As a submit it took React 19's form-reset
          path and emptied the generate form above on every request added.

          `formNoValidate` went with it: a plain button never triggers the
          form's native validation, so there is nothing left to opt out of.
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

/**
 * The generate button — the ONLY submit button in this form.
 *
 * That is worth keeping true. It carried a `data-generate` marker while the
 * constraints card's "Add request" was also a submit, so the form's `onSubmit`
 * could tell them apart; the marker is gone because the discrimination was
 * itself the bug (see `onSubmit`). Adding a second submit button here would
 * bring back React 19's form reset for whatever it submits.
 */
function SubmitButton({ pending }: { pending: boolean }) {
  return (
    <Button type="submit" disabled={pending}>
      {pending ? "Generating…" : "Generate schedule"}
    </Button>
  );
}

/**
 * What a screen reader is told while a generate runs — the sentence only, never
 * the countdown. Lives here because the visible copy and the announced copy are
 * rendered in two different places (see the live region in the form below) and
 * have to stay in step.
 */
const GENERATING_STATUS = "Building the schedule.";

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
      {/*
        Named, so it isn't announced as a bare unlabelled progress bar. This is
        the one part of the indicator a screen reader can usefully query on
        demand — hence a real name rather than `aria-hidden` alongside the text.
      */}
      <Progress
        value={fraction * 100}
        aria-label="Schedule generation progress"
      />
      {/*
        Visual only. The announced copy is the live region in the form below;
        this paragraph would otherwise duplicate it, and it carries the
        countdown, which changes four times a second and must never reach a
        screen reader.
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
  const formRef = useRef<HTMLFormElement>(null);
  /**
   * Which schedule of the many equally-valid ones is on screen.
   *
   * ⚠️ `localStorage`, NOT a column on `seasons`. This is per-manager,
   * per-browser scratch — a migration for a counter is disproportionate.
   *
   * ⛔ EVERY ACCESS IN try/catch AND EVERY READ TOLERATES null. A private
   * window, cleared site data, or a browser set to block storage makes the
   * accessor ITSELF throw, and a season with nothing stored must simply start
   * at 1 rather than render nothing.
   */
  const variationKey = `obhl:variation:${seasonId}`;
  const [variation, setVariation] = useState(() => {
    // ⛔ A LAZY INITIALISER IS SAFE HERE ONLY BECAUSE `variation` IS NEVER
    // RENDERED. It is read in `tryAnother` and written into the FormData in
    // `dispatch`; it reaches no DOM node, so the server and the client can
    // disagree about it without any hydration mismatch to reconcile. Add a
    // `<input value={variation}>` and this has to move into an effect.
    //
    // The `typeof window` guard is for the server render, where there is no
    // `localStorage` at all.
    if (typeof window === "undefined") return 1;
    try {
      const n = Number(window.localStorage.getItem(variationKey));
      return Number.isFinite(n) && n >= 1 ? Math.min(50, Math.floor(n)) : 1;
    } catch {
      // A private window, cleared site data, or a browser set to block storage
      // makes the accessor ITSELF throw. The counter is a convenience, not
      // state — starting over at 1 is a correct outcome, not a failure.
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

  // Same house pattern as publish-controls.tsx: the result is a toast, not
  // inline text, and toasting is a side effect on an external system.
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

  /**
   * ⛔ THE ACTION IS DISPATCHED HERE, NOT THROUGH `<form action={…}>`, AND THAT
   * IS THE WHOLE FIX FOR "generate cleared my fields".
   *
   * React 19 resets a form's uncontrolled inputs on every submit that goes
   * through the `action` prop — `startHostTransition` in react-dom calls
   * `requestFormReset` before it ever runs the action, with no opt-out
   * (react-dom 19.2.4, `react-dom-client.development.js`). Generate is
   * ITERATIVE: a manager regenerates five or six times, changing one field
   * each pass, and every pass was throwing away the other five. Measured
   * 2026-09-06 on Fall 2026 — after a generate, `games_per_team` went back to
   * 10, `slot_times` to "19:00, 20:20, 21:40" and every weekday checkbox to
   * unchecked, while the skip chips and the length mode (React state, not
   * inputs) survived untouched. That split is what identifies the cause: a
   * remount would have taken the state with it.
   *
   * `preventDefault` is what stops React's reset. Its "action" listener is
   * queued after this `onSubmit` and bails when the event is already
   * default-prevented, so the reset never runs — and the action is then ours to
   * dispatch. `startTransition` is required, not decorative: `useActionState`'s
   * dispatcher only raises its `isPending` flag when it is called inside one,
   * so without it the button never says "Generating…" and the progress bar
   * never mounts.
   *
   * ⛔ UNCONDITIONAL, AND THAT TOOK A SECOND FIX TO EARN. This used to bail
   * unless the submitter carried `data-generate`, because the constraints
   * card's "Add request" was a submit button posting through `formAction` and
   * preventing here would have made every Add silently do nothing. The bail was
   * the bug: React still took the reset path for that submitter, so adding one
   * manager request wiped every field the manager had typed — the half of the
   * original complaint that the first fix missed.
   *
   * Add is a plain `type="button"` now (see the ConstraintsCard header), so
   * Generate is the only submit button left in this form and there is nothing
   * left to discriminate. Preventing unconditionally also closes the hole the
   * submitter check opened: a submit with a null submitter — `requestSubmit()`
   * with no argument, or implicit submission with no default button — fell
   * through to a native browser navigation that discarded the whole form.
   */
  const onSubmit = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    // Generate always means "the first schedule for these inputs".
    rememberVariation(1);
    dispatch(e.currentTarget, 1);
  };

  /**
   * Dispatch the action with an explicit variation.
   *
   * ⛔ `v` is a PARAMETER, never read back from `variation` state. React batches
   * the `setVariation` next to each caller, so reading the state here would
   * dispatch the value from before the click and "Try a different schedule"
   * would regenerate the schedule the manager just rejected.
   *
   * ⛔ AND THE TRY BUTTON IS `type="button"`, NOT A SECOND SUBMIT — see the
   * note on `SubmitButton`. Generate stays the only submit in this form, so
   * nothing re-opens React 19's form reset, and this takes exactly the path
   * `onSubmit` takes once it has prevented the default.
   */
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
            // The browser half of the past-date guard: it stops the mistake
            // being typed, but a client can drop it, so `generateSchedule`
            // refuses the same date server-side. Today, in the league's zone —
            // not the browser's, which would disagree by a day for anyone
            // travelling.
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
          `type="button"`, dispatching through `dispatch` rather than submitting
          — see the ⛔ on `dispatch` and the note on `SubmitButton`. A second
          `type="submit"` here would put a second submitter back in this form,
          which is the arrangement the unconditional `preventDefault` in
          `onSubmit` exists to make unnecessary.
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
        Permanently mounted, and empty when idle. A live region inserted into
        the DOM with its text already in place is generally not announced — the
        region has to exist *before* its content changes — so this deliberately
        sits outside the `pending` branch instead of inside the indicator.

        It carries the sentence only. The countdown lives in the visual
        paragraph above, which is `aria-hidden`: a number ticking four times a
        second inside a live region would be read out on every change.

        The overrun wording stays visual. Announcing it would mean lifting the
        indicator's elapsed-time state up to this component, and that state is
        deliberately scoped to the indicator's mount — see the note on
        GenerateProgressBar. Not worth trading that for a second announcement.
      */}
      <p aria-live="polite" className="sr-only">
        {pending ? GENERATING_STATUS : ""}
      </p>
    </form>
  );
}
