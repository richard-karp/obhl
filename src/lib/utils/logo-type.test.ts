import { describe, it, expect } from "vitest";
import { logoFileType } from "./logo-type";

describe("logoFileType", () => {
  it("maps raster extensions to their content type", () => {
    expect(logoFileType("crest.png")).toEqual({ ext: "png", contentType: "image/png" });
    expect(logoFileType("CREST.JPG")).toEqual({ ext: "jpg", contentType: "image/jpeg" });
    expect(logoFileType("crest.jpeg")).toEqual({ ext: "jpeg", contentType: "image/jpeg" });
    expect(logoFileType("crest.webp")).toEqual({ ext: "webp", contentType: "image/webp" });
  });

  it("refuses anything else, SVG included", () => {
    expect(logoFileType("crest.svg")).toBeNull();
    expect(logoFileType("crest.html")).toBeNull();
    expect(logoFileType("crest")).toBeNull();
  });
});
