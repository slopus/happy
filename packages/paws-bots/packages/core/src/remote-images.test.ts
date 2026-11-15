import { describe, expect, it } from "vitest";
import { normalizeRemoteImagesPreference } from "./remote-images.js";

describe("normalizeRemoteImagesPreference", () => {
  it("stays off unless a saved choice turns it on", () => {
    expect(normalizeRemoteImagesPreference("on")).toBe("on");
    expect(normalizeRemoteImagesPreference(" ON ")).toBe("on");
    expect(normalizeRemoteImagesPreference("off")).toBe("off");
    expect(normalizeRemoteImagesPreference(null)).toBe("off");
    expect(normalizeRemoteImagesPreference(undefined)).toBe("off");
    expect(normalizeRemoteImagesPreference("nonsense")).toBe("off");
  });
});
