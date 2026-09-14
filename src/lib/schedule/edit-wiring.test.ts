import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/** ⛔ Structural on purpose: two fixes to `schedule-edits.ts` were reported done and never
 *  applied, and neither is observable from outside, so these assert where the guards sit. */
const SRC = readFileSync(
  join(process.cwd(), "src/lib/actions/schedule-edits.ts"),
  "utf8",
);

/** The body of one exported action, from its name to the next `export `. */
function bodyOf(name: string): string {
  const start = SRC.indexOf(`export async function ${name}`);
  expect(start, `${name} is not an exported action any more`).toBeGreaterThan(
    -1,
  );
  const next = SRC.indexOf("\nexport ", start + 1);
  return SRC.slice(start, next === -1 ? SRC.length : next);
}

/** Every `name(...)` call with its arguments. ⚠️ Count depth, not a regex: nested parentheses
 *  end a non-greedy match before the argument under test. */
function callsTo(name: string): string[] {
  const out: string[] = [];
  let from = 0;
  for (;;) {
    const at = SRC.indexOf(`${name}(`, from);
    if (at === -1) return out;
    let depth = 0;
    let i = at + name.length;
    for (; i < SRC.length; i++) {
      if (SRC[i] === "(") depth++;
      else if (SRC[i] === ")" && --depth === 0) break;
    }
    out.push(SRC.slice(at, i + 1));
    from = i + 1;
  }
}

describe("schedule-edits wiring", () => {
  /** Both exchanges read one side of the season (`is_draft`), so a draft/published pair must
   *  be refused outright; a missing guard surfaces as "the schedule changed". */
  it.each(["exchangeTeams", "exchangeSlots"])(
    "%s refuses a draft/published pair outright",
    (name) => {
      expect(bodyOf(name)).toContain("is_draft !== y0.is_draft");
    },
  );

  /** Without `nameOf`, every balance refusal names a raw UUID and no other test notices. */
  it("passes nameOf to preserved at every call site", () => {
    const calls = callsTo("preserved");
    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) expect(call).toContain("nameOf");
  });
});
