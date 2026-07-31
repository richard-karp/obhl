import { describe, it, expect } from "vitest";
import { publishMode } from "./publishMode";

describe("publishMode", () => {
  it("is empty with no live games and no draft", () => {
    expect(publishMode({ liveCount: 0, draftCount: 0, started: false })).toBe("empty");
  });

  it("is draft-only when a draft exists and nothing is live", () => {
    expect(publishMode({ liveCount: 0, draftCount: 40, started: false })).toBe("draft-only");
  });

  it("is published when a live schedule exists and there is no draft", () => {
    expect(publishMode({ liveCount: 40, draftCount: 0, started: false })).toBe("published");
  });

  it("is replace when a draft would displace a live schedule", () => {
    expect(publishMode({ liveCount: 40, draftCount: 42, started: false })).toBe("replace");
  });

  it("is locked once the season has started", () => {
    expect(publishMode({ liveCount: 40, draftCount: 0, started: true })).toBe("locked");
  });

  it("stays locked even with a draft sitting there", () => {
    // A stale draft generated before the first game was played. It must not
    // offer a replace — started outranks every other signal. Task 5 relies on
    // this to decide whether to render the publish control at all.
    expect(publishMode({ liveCount: 40, draftCount: 42, started: true })).toBe("locked");
  });
});
