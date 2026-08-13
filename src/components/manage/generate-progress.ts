/**
 * The arithmetic behind the generate progress bar, kept out of the component so
 * it can be tested: vitest only collects `.test.ts` files under `src` and this
 * repo has no component-test harness, so a pure module is the only testable
 * part. The bar itself is verified by eye.
 *
 * Time-based, because the generator reports nothing while it runs — Phase S
 * spends a fixed wall-clock budget per candidate inside a single server action,
 * so there is no progress to read, only elapsed time against an expectation.
 */
export type GenerateProgress = {
  /**
   * 0..0.95. Capped below 1 deliberately: a bar sitting at 100% while the
   * server is still working reads as hung, where a bar stalled just short of
   * the end reads as "nearly there".
   */
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
  // A non-positive estimate would divide by zero. It can't happen from
  // `estimatedGenerateMs()`, but the value crosses a server/client boundary as
  // a prop, so treat it as "no estimate": show the bar pinned at its cap and
  // the overrun copy, which is honest about not knowing how long is left.
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
