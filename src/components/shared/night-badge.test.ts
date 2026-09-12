import { describe, it, expect } from "vitest";
import { NightBadge } from "./night-badge";

/**
 * The two branches the e2e cannot see.
 *
 * ⚠️ THE SEED PINS A NIGHT ON EXACTLY TWO ROWS — Sharks' goalies #1 and #8, per
 * `supabase/seed.sql`. So `04-rosters` can assert the pill renders, but the
 * absence branch it exercises is "no pill on the other twelve rows", which no
 * assertion there names: a component that rendered nothing at all would pass
 * every one of them except the two goalie ones. This pins both branches
 * directly.
 *
 * ⚠️ AND IT PINS THE LETTER, WHICH IS THE WHOLE FEATURE. `NIGHT_LABEL[night]`
 * is three characters; the pill shows one. An edit that dropped the `[0]` would
 * still render a plausible pill and still pass an e2e looking for a badge.
 *
 * Called as a plain function rather than rendered — the same approach as
 * `team-logo.test.ts`, and for the same reason: the component is pure, so its
 * element tree can be read with no DOM and no jsdom.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const el = (night: number | null) => NightBadge({ night }) as any;

describe("NightBadge", () => {
  it("renders nothing when the player has no fixed night", () => {
    expect(el(null)).toBeNull();
  });

  it("shows the first letter of the day, not the three-letter label", () => {
    expect(el(2).props.children).toBe("T");
    expect(el(1).props.children).toBe("M");
    expect(el(6).props.children).toBe("S");
  });

  it("carries the full day name as the title, which is what tells Tue from Thu", () => {
    // The maintainer chose the single letter knowing their own league plays
    // both — so this attribute is the only thing separating the two pills.
    const tue = el(2);
    const thu = el(4);
    expect(tue.props.children).toBe(thu.props.children);
    expect(tue.props.title).toBe("Tuesday");
    expect(thu.props.title).toBe("Thursday");
  });

  it("matches the rookie R's shape — outline, same padding and type scale", () => {
    // ⚠️ NOT COSMETIC. "a little pill like the rookie R" is the request; a
    // badge that drifts to another variant stops reading as the same kind of
    // mark as the four beside it.
    const chip = el(0);
    expect(chip.props.variant).toBe("outline");
    expect(chip.props.className).toBe("ml-1 px-1.5 py-0 text-[0.65rem]");
  });

  it("renders every weekday 0-6, the range the column is constrained to", () => {
    // `team_players.night_of_week` is `check (night_of_week between 0 and 6)`
    // since `0049`, so these seven are the whole input domain.
    const letters = [0, 1, 2, 3, 4, 5, 6].map((n) => el(n).props.children);
    expect(letters).toEqual(["S", "M", "T", "W", "T", "F", "S"]);
  });
});
