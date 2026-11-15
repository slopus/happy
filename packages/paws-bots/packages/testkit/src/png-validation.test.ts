import { PNG } from "pngjs";
import { describe, expect, it } from "vitest";
import { validatePngScreenshot } from "./png-validation.js";

function validPng() {
  const png = new PNG({ width: 1, height: 1 });
  png.data = Buffer.from([23, 45, 67, 255]);
  return PNG.sync.write(png);
}

describe("validatePngScreenshot", () => {
  it("accepts a complete decodable PNG", () => {
    expect(() => validatePngScreenshot(validPng(), "valid.png")).not.toThrow();
  });

  it("rejects a truncated PNG with a valid signature and header", () => {
    const truncated = validPng().subarray(0, -12);
    expect(() => validatePngScreenshot(truncated, "truncated.png")).toThrow(/IEND|Truncated/);
  });

  it("rejects bytes appended after IEND", () => {
    const trailing = Buffer.concat([validPng(), Buffer.from("not-an-image")]);
    expect(() => validatePngScreenshot(trailing, "trailing.png")).toThrow(/end/);
  });

  it("rejects corrupt image data even when the PNG structure is present", () => {
    const corrupt = validPng();
    corrupt[corrupt.length - 13]! ^= 0xff;
    expect(() => validatePngScreenshot(corrupt, "corrupt.png")).toThrow(/Invalid PNG/);
  });
});
