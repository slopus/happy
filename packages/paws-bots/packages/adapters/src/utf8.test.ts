import { describe, expect, it } from "vitest";
import { byteLength, sliceWellFormed, truncateUtf8 } from "./utf8.js";

describe("byteLength", () => {
  it("counts UTF-8 bytes", () => {
    expect(byteLength("")).toBe(0);
    expect(byteLength("abc")).toBe(3);
    expect(byteLength("aé中😀")).toBe(10);
    expect(byteLength("\ud800")).toBe(3);
  });
});

describe("truncateUtf8", () => {
  it.each([
    [1, "a"],
    [2, "a"],
    [3, "aé"],
    [5, "aé"],
    [6, "aé中"],
    [9, "aé中"],
    [10, "aé中😀"],
    [20, "aé中😀"],
  ])("keeps whole code points within %i bytes", (maxBytes, expected) => {
    expect(truncateUtf8("aé中😀", maxBytes)).toBe(expected);
  });

  it.each([
    [3, ""],
    [4, "😀"],
    [6, "😀"],
    [7, "中😀"],
    [9, "é中😀"],
    [10, "aé中😀"],
  ])("keeps whole trailing code points within %i bytes", (maxBytes, expected) => {
    expect(truncateUtf8("aé中😀", maxBytes, "end")).toBe(expected);
  });

  it("keeps lone trailing surrogates without splitting valid pairs", () => {
    expect(truncateUtf8("a\ud800", 3, "end")).toBe("\ud800");
    expect(truncateUtf8("a\udc00", 3, "end")).toBe("\udc00");
    expect(truncateUtf8("😀", 3, "end")).toBe("");
    expect(truncateUtf8("text", 0, "end")).toBe("");
  });

  it("returns an empty string for nonpositive budgets", () => {
    expect(truncateUtf8("text", 0)).toBe("");
    expect(truncateUtf8("text", -1)).toBe("");
  });

  it("preserves empty strings and lone surrogates", () => {
    expect(truncateUtf8("", 10)).toBe("");
    expect(truncateUtf8("\ud800", 2)).toBe("");
    expect(truncateUtf8("\ud800", 3)).toBe("\ud800");
  });
});

describe("sliceWellFormed", () => {
  it.each([
    ["ab😀cd", 2, "ab"],
    ["ab😀cd", 3, "ab"],
    ["ab😀cd", 4, "ab😀"],
    ["ab😀cd", 10, "ab😀cd"],
    ["😀", 1, ""],
    ["a\ud800b", 2, "a\ud800"],
    ["abc", 0, ""],
  ])("cuts %j at %i without splitting a surrogate pair", (value, end, expected) => {
    expect(sliceWellFormed(value, end)).toBe(expected);
  });
});
