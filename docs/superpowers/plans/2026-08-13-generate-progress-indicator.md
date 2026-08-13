# Schedule builder — generate progress indicator (designed, not built)

**Protocol — read this and nothing else to resume.**

1. This file is self-contained. Do **not** read `docs/superpowers/plans/2026-08-12-g2-pairing-weekday-split.md` (183 lines) or `-phase-s-best-of-k.md` (581) — both are shipped work, and everything still binding from them is in `SCHEDULE_HANDOFF.md` §5. Open `SCHEDULE_HANDOFF.md` only if you touch the generator itself; this task does not.
2. ⛔ **PR #9 is open, pushed, and deliberately NOT merged.** The user chose "hold off" on 2026-08-13, wanting an independent review and a browser run first. Do not merge it. 24 commits, `MERGEABLE`/`CLEAN`, 0 behind `main`.
3. ⛔ **All four rematch metrics must stay 0** and `WD_SPLIT_W` must not be tuned — standing league rulings. This task touches no generator code, so neither should come up.
4. Every number here was **watched appear**. Claims about how code is *shaped* say "reading" in those words.
5. Verify with `npx vitest run && npm run lint && npx tsc --noEmit`. Baseline: **226 pass**, lint clean, tsc clean, ~36 s.

**Status: design approved, plan refined, nothing built.** The branch is clean and fully pushed; this task adds new files and touches four existing ones.

---

## What shipped this session (2026-08-13)

| Work | Commits | State |
|---|---|---|
| G2 — compound pass drives `pairingWeekdayExcess` 8 → 0 | `163bf8c`, `9b72247` | pushed |
| Code-review fixes (count-not-score, plateau budget, index skip, fail-closed) | `6625829`, `dd6b628`, `47f636b`, `349e8f1` | pushed |
| e2e for the new spacing rows | `54ec346` | pushed |

Reference season now reads, stable over many runs: `pairingWeekdayExcess` 0, all four rematch 0, all byes 0, weekday balance 18/18, ice share 12/12/12, `slotWeekdaySpread` 0, `slotStreak3` 0, `slotConsecutive` 48, generate **26.4 s**.

## The task

Generate takes ~26.4 s. The only indicator is a button label swap (`schedule-generate-form.tsx:62-68`) — a static word for 26 s reads as frozen. Separately, `generateSchedule` (`src/lib/actions/schedule.ts:69`, returns `void`) has **eight silent `return` paths**, so a refusal looks identical to a slow run.

Build: a determinate bar with a ticking countdown, plus the action returning a result.

### Measured — do not re-derive

Generate time by season size (8 teams, 3 sheets, Mon+Thu):

| nights | games/team | time |
|---|---|---|
| 12 | 9 | 2.8 s |
| 20 | 15 | 9.5 s |
| 28 | 21 | 26.5 s |
| 36 | 27 | 26.4 s |
| 48 | 36 | 26.4 s |

Saturates the Phase S budget from ~28 nights up. The e2e fixture (sparse, 14 nights) generates in **~0.4 s**.

Readings of the code, not measurements: `radix-ui@1.4.3` exports `Progress`; `useActionState` is used by 11 components and `generateSchedule` is the only form action that doesn't return state; `ScheduleGenerateForm` has exactly one renderer (`schedule-builder-panel.tsx:243`); `enumerateNights` (`src/lib/schedule/capacity.ts`) is pure and client-importable.

### Known limitation — decided, not overlooked

The countdown is time-based and the estimate is one number from the Phase S budget, so **below ~28 nights it overstates** — a 12-night season says "about 26 seconds" and finishes in under 3. The user was offered an "up to about 30 seconds" ceiling that never overstates and **chose the countdown anyway**. Put this in a comment beside the estimate so nobody later reads it as a guarantee; hedge the copy with "about".

An adaptive per-season estimate was considered and rejected: the night count is obtainable, but the night-count→time curve is a fit to one machine's numbers.

### Changes

**1.** `src/lib/schedule/assignNights.ts` — export beside `SLOT_CANDIDATES` (~129) and `SLOT_BUDGET_MS` (~99):

```ts
// Typical, NOT a bound: Phase P alone may spend solve(4_000) plus a 3 s plateau
// sweep on a hard league. Sized against the ~1.3 s measured on the reference.
const PHASE_PM_ALLOWANCE_MS = 1_500;
export const estimatedGenerateMs = () =>
  SLOT_CANDIDATES.length * SLOT_BUDGET_MS + PHASE_PM_ALLOWANCE_MS;
```

Computed, not hardcoded, so adding a sixth Phase S candidate moves it automatically — that happened once already. Keep `SLOT_CANDIDATES` unexported.

**2.** New `src/components/manage/generate-progress.ts` — pure:

```ts
export function generateProgress(elapsedMs: number, expectedMs: number): {
  fraction: number;      // 0..0.95, capped so it never sits at 100% while working
  remainingSec: number;  // 0 once overrun
  overrun: boolean;
}
```

Extracted because vitest's `include` is `src/**/*.test.ts` and this repo has **no component-test harness** — a pure module is the only testable part. Test file alongside: the cap, the countdown, the overrun flag, `expectedMs <= 0` not dividing by zero.

**3.** New `src/components/ui/progress.tsx` wrapping `radix-ui`'s `Progress`. Follow `src/components/ui/separator.tsx` exactly: `"use client"`, named import from `radix-ui`, `data-slot`, `cn` from `@/lib/utils`.

**4 + 5 — land together in one commit** (the signature change breaks the form until the wiring lands).

`src/lib/actions/schedule.ts`, reusing the shape at line 203:

```ts
export type GenerateState = { ok: boolean; message: string } | null;
export async function generateSchedule(_prev: GenerateState, formData: FormData): Promise<GenerateState>
```

Each of the eight silent `return`s gets a specific reason; success returns the game count; keep both `revalidatePath` calls.

`src/components/manage/schedule-generate-form.tsx` — mirror `publish-controls.tsx:45-59`:

```tsx
const [state, action, pending] = useActionState<GenerateState, FormData>(generateSchedule, null);
useEffect(() => {
  if (!state) return;
  state.ok ? toast.success(state.message) : toast.error(state.message);
}, [state]);
```

Result goes to a **sonner toast** — the house pattern, not inline text. `SubmitButton` drops `useFormStatus` and takes `pending` as a prop. While pending, the helper text beside the button is replaced by the bar and countdown; `Loader2Icon` + `animate-spin`, matching `src/components/ui/sonner.tsx:28`.

Copy: `Building the schedule — about Ns left.` → on overrun, `Still working — this season is taking longer than usual.`

Two edges the component must handle, both real bugs if missed:
- **Reset the start timestamp on every `pending` → true.** Otherwise a second generate measures from the first run's start and shows instant overrun.
- **Clear the 250 ms interval** on unmount and when pending goes false.

Accessibility: `aria-live="polite"` on the status sentence only, never the ticking number.

**6.** `src/components/manage/schedule-builder-panel.tsx:243` — call `estimatedGenerateMs()` server-side, pass `expectedMs`.

### Out of scope

The panel still reads "No draft schedule" while generating. Fixing it means lifting pending state into the server component's subtree — much larger, for a contradiction the indicator largely answers.

### Verification

- `npx vitest run` → 226 + the new progress tests. `npm run lint && npx tsc --noEmit`.
- `npx playwright test e2e/11-schedule-builder.spec.ts` (12 tests today) — **watch for toast overlap**: three tests click "Discard draft" / "Publish N games" right after generating, and sonner renders in a corner where it can cover controls. If it flakes, scope the click or dismiss the toast; don't add a wait. Extend the spec to assert the **result toast, not the bar** — the fixture generates in ~0.4 s, so asserting the indicator would race. Say in the comment that the bar is verified by eye.
- Manual, the one that actually proves it: `npm run dev`, Fall 2026 setup page, generate 8 teams / Mon+Thu / 36 games and watch the bar run ~26 s. Then submit with no weekdays checked and confirm a specific error toast instead of silence.

## Open items — not being worked

- **PR #9 unmerged by choice.** Wants an independent review (`/code-review ultra 9` — user-triggered, I cannot launch it) and a browser run.
- **`worseThan` banner rendering is untested.** Its *logic* is covered (`oneOff.test.ts:255-292`); the banner only renders when a repair genuinely regresses an ice metric, so testing it needs a purpose-built fixture, not a test that passes on fixture luck.
- **`slotWeekdaySpread` in the panel is a summed spread, not a count** — same class as the bug fixed in `6625829`, milder because its label names no noun and it's always integral. Raised; user chose not to address it.

## Housekeeping this session could not do

Plan mode was active throughout, so two things are undone:

1. **This file belongs in the repo** as `docs/superpowers/plans/2026-08-13-generate-progress-indicator.md`, matching the four already there, so it survives outside `~/.claude/plans/`. Move it, then delete this copy — one home per fact.
2. The brainstorming flow calls for a design doc at `docs/superpowers/specs/2026-08-13-generate-progress-indicator-design.md`, committed. Its content is this file's *task* sections. Do that first, or fold it into (1) and skip the duplicate.

**Do not read:** `docs/superpowers/plans/2026-08-12-*.md` (764 lines across two) — shipped, superseded by `SCHEDULE_HANDOFF.md` §5. `EXPORTS_HANDOFF.md` (264) — unrelated. The generator itself (`matchups.ts`, `slots.ts`, `participation.ts`, ~1,600 lines) — this task changes one exported constant in `assignNights.ts` and nothing else in that library.

**Read cost:** this file (139 lines, counted) is the whole brief. Add `schedule-generate-form.tsx` (~270) and `publish-controls.tsx:40-95` when you start writing. Budget ~500.
