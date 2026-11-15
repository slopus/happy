import { describe, expect, it } from "vitest";
import { formatElapsed } from "./primitives";

describe("formatElapsed", () => {
  it("formats sub-minute elapsed time to one decimal second", () => {
    expect(formatElapsed(1_000, 1_000)).toBe("0.0s");
    expect(formatElapsed(1_000, 1_100)).toBe("0.1s");
    expect(formatElapsed(1_000, 12_500)).toBe("11.5s");
    expect(formatElapsed(1_000, 60_900)).toBe("59.9s");
  });

  it("formats elapsed time past a minute", () => {
    expect(formatElapsed(0, 60_000)).toBe("1m 0.0s");
    expect(formatElapsed(0, 125_700)).toBe("2m 5.7s");
  });

  it("rounds to tenths before choosing the minute boundary", () => {
    expect(formatElapsed(0, 59_950)).toBe("1m 0.0s");
    expect(formatElapsed(0, 119_950)).toBe("2m 0.0s");
  });

  it("clamps negative deltas to zero", () => {
    expect(formatElapsed(5_000, 4_000)).toBe("0.0s");
  });
});
