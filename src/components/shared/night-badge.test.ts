import { describe, it, expect } from "vitest";
import { NightBadge } from "./night-badge";

// ⚠️ The seed pins a night on two rows only, so e2e can't see the absent branch. ⚠️ The letter is the feature:
// dropping `[0]` still renders a plausible pill. Called as a plain function, since the component is pure.
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
    // ⚠️ Not cosmetic: a badge drifting to another variant stops reading like the four beside it.
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
