import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { TeamLogo } from "./team-logo";

// Pins the contract callers feed (`logo_text_color`, `logo_path`), so an edit here can't move it under them.
// Called as a plain function: the component is pure, so no DOM or jsdom is needed.
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
