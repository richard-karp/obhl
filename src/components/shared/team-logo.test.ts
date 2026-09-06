import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { TeamLogo } from "./team-logo";

/**
 * The CONTROL for the team-logo work: `TeamLogo` itself was never the bug. Every
 * screen that showed white letters on a pale chip, or initials for a team with a
 * real crest, was a CALLER that never plumbed `logo_text_color` / `logo_path`
 * through its `select`. This file pins the contract those callers have to feed,
 * so a later edit here cannot quietly move the goalposts underneath them.
 *
 * Called as a plain function rather than rendered: the component is pure and
 * returns an element tree, so the two branches can be told apart by `type` and
 * `props` with no DOM. That is what keeps this in the `node` environment the
 * rest of the suite already runs in — no jsdom, no renderer.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const el = (props: Parameters<typeof TeamLogo>[0]) => TeamLogo(props) as any;

describe("TeamLogo", () => {
  const OLD_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
  beforeAll(() => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = "http://supabase.test";
  });
  afterAll(() => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = OLD_URL;
  });

  it('draws dark letters when textColor is "dark"', () => {
    const chip = el({
      name: "Harbor Seals",
      color: "#ffffff",
      textColor: "dark",
    });
    expect(chip.type).toBe("span");
    expect(chip.props.className).toContain("text-slate-900");
    expect(chip.props.className).not.toContain("text-white");
  });

  it("draws white letters for every other textColor, null included", () => {
    for (const textColor of ["light", null, undefined]) {
      const chip = el({ name: "Harbor Seals", color: "#0b3d91", textColor });
      expect(chip.props.className).toContain("text-white");
      expect(chip.props.className).not.toContain("text-slate-900");
    }
  });

  it("renders the uploaded image instead of the monogram when logoPath is set", () => {
    const img = el({
      name: "Harbor Seals",
      color: "#0b3d91",
      logoPath: "harbor/seals.png",
    });
    expect(img.type).toBe("img");
    expect(img.props.src).toBe(
      "http://supabase.test/storage/v1/object/public/logos/harbor/seals.png",
    );
  });

  it("ignores textColor once logoPath is set — the image branch draws no letters", () => {
    const img = el({
      name: "Harbor Seals",
      color: "#ffffff",
      logoPath: "harbor/seals.png",
      textColor: "dark",
    });
    expect(img.type).toBe("img");
    expect(img.props.className).not.toContain("text-slate-900");
  });

  it("falls back to the monogram when logoPath is null", () => {
    const chip = el({ name: "Harbor Seals", color: "#0b3d91", logoPath: null });
    expect(chip.type).toBe("span");
  });
});
