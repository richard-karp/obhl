// Kept out of the component so it can be tested (there is no component-test harness). Time-based: the
// generator reports nothing while it runs.
export type GenerateProgress = {
  /** 0..0.95: a bar at 100% while the server is still working reads as hung. */
  fraction: number;
  /** Whole seconds left, floored at 0 once the estimate is spent. */
  remainingSec: number;
  /** True once elapsed has passed the estimate — the copy changes here. */
  overrun: boolean;
};

/** Never reach the end of the track while work is still in flight. */
const MAX_FRACTION = 0.95;

export function generateProgress(
  elapsedMs: number,
  expectedMs: number,
): GenerateProgress {
  // A non-positive estimate is "no estimate" (it crosses a server/client boundary): pinned at the cap, with
  // the overrun copy.
  if (!(expectedMs > 0)) {
    return { fraction: MAX_FRACTION, remainingSec: 0, overrun: true };
  }

  const elapsed = Math.max(0, elapsedMs);
  const overrun = elapsed >= expectedMs;

  return {
    fraction: Math.min(MAX_FRACTION, elapsed / expectedMs),
    remainingSec: overrun ? 0 : Math.ceil((expectedMs - elapsed) / 1_000),
    overrun,
  };
}
