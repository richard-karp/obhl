import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Convention guard, a sibling of `src/lib/actions/league-guards.test.ts`.
 *
 * ⛔ WHY THIS FILE EXISTS. Two fixes to `schedule-edits.ts` were written,
 * reported as done in a commit message, and never actually applied: the edits
 * were made by pattern replacement, the file had since been reformatted, the
 * patterns matched nothing, and nothing asserted the result. The full suite —
 * 476 unit tests and the whole e2e run — passed over both.
 *
 * They survived because neither is observable from outside: one is a refusal on
 * a pair no test constructs, the other is an argument that only changes how a
 * message reads. So the check has to be structural. These assertions are ugly
 * on purpose; they fail loudly the moment a guard stops being where it is
 * claimed to be, which is the failure the last two review rounds actually had.
 */
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

/**
 * Every `name(...)` call in the file, with its arguments.
 *
 * ⚠️ A REGEX CANNOT DO THIS, AND THE FIRST VERSION OF THIS TEST PROVED IT:
 * `preserved(countsFor(rows), countsFor(after), nameOf)` nests parentheses, so
 * a non-greedy match stops at the first `)` and reports an argument list that
 * ends before the argument under test. Count depth instead.
 */
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
  /**
   * Both two-game exchanges read ONE side of the season (`seasonRows` is scoped
   * by `is_draft`), so a draft/published pair puts the partner outside every
   * list that reasons about it. It fails closed, but as "the schedule changed
   * while this was on screen" — a refusal that names the wrong cause and leaves
   * the manager with nothing to do. The guard landed in `exchangeTeams` alone
   * while the commit claimed both.
   */
  it.each(["exchangeTeams", "exchangeSlots"])(
    "%s refuses a draft/published pair outright",
    (name) => {
      expect(bodyOf(name)).toContain("is_draft !== y0.is_draft");
    },
  );

  /**
   * `preserved` takes the team names the caller has already resolved. Called
   * with two arguments it falls back to its identity default and every balance
   * refusal names a raw UUID — correct, useless, and invisible to every test.
   */
  it("passes nameOf to preserved at every call site", () => {
    const calls = callsTo("preserved");
    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) expect(call).toContain("nameOf");
  });
});
