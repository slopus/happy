import { describe, expect, it } from "vitest";
import { fileSizeParts, formatFileSize } from "./format-file-size.js";

describe("formatFileSize", () => {
  it("uses whole units and one decimal only when needed", () => {
    expect(formatFileSize(0)).toBe("0 B");
    expect(formatFileSize(512)).toBe("512 B");
    expect(formatFileSize(1024)).toBe("1 KB");
    expect(formatFileSize(2048)).toBe("2 KB");
    expect(formatFileSize(1536)).toBe("1.5 KB");
    expect(formatFileSize(Math.round(1.4 * 1024 * 1024))).toBe("1.4 MB");
    expect(formatFileSize(3 * 1024 * 1024)).toBe("3 MB");
  });

  it("rolls a rounded 1024 up to the next unit", () => {
    expect(formatFileSize(1024 * 1024 - 1)).toBe("1 MB");
  });

  it("moves to GB instead of showing thousands of MB", () => {
    expect(fileSizeParts(1536 * 1024 * 1024)).toEqual({ amount: "1.5", unit: "GB" });
    expect(formatFileSize(3 * 1024 ** 3)).toBe("3 GB");
  });

  it("splits the amount from the unit, rolling a rounded 1024 up", () => {
    expect(fileSizeParts(512)).toEqual({ amount: "512", unit: "B" });
    expect(fileSizeParts(1024 * 1024 - 1)).toEqual({ amount: "1", unit: "MB" });
    expect(fileSizeParts(Number.NaN)).toBeNull();
  });

  it("uses the locale's decimal separator when given one", () => {
    expect(fileSizeParts(1536, "de")).toEqual({ amount: "1,5", unit: "KB" });
    expect(fileSizeParts(1536, "en")).toEqual({ amount: "1.5", unit: "KB" });
    expect(fileSizeParts(1024, "de")).toEqual({ amount: "1", unit: "KB" });
  });

  it("returns nothing for an unknown size", () => {
    expect(formatFileSize(Number.NaN)).toBe("");
    expect(formatFileSize(Number.POSITIVE_INFINITY)).toBe("");
    expect(formatFileSize(-1)).toBe("");
  });
});
