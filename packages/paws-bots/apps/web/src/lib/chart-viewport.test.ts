import { describe, expect, it } from "vitest";
import { chartViewport } from "./chart-viewport.js";

describe("chartViewport", () => {
  it("caps the expanded chart at 1240px wide and 88% of the viewport", () => {
    expect(chartViewport(10_000, 2_000)).toEqual({ width: 1240, height: 1320 });
    expect(chartViewport(1_000, 1_000)).toEqual({ width: 880, height: 660 });
  });

  it("floors fractional viewport sizes", () => {
    expect(chartViewport(901, 701).width).toBe(792);
    expect(chartViewport(901, 701).height).toBe(462);
  });
});
