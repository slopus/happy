import { describe, expect, it } from "vitest";
import { typeScale } from "./index.js";

describe("typeScale", () => {
  it("gives every style a line height at least as tall as its text", () => {
    for (const style of Object.values(typeScale)) {
      expect(style.lineHeight).toBeGreaterThanOrEqual(style.fontSize);
    }
  });
});
